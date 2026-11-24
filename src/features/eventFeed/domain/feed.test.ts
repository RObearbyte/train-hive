import { describe, expect, it } from 'vitest';

import type { EventFeed, EventFeedItem } from '@/lib/database.types';
import { AppError } from '@/lib/errors';

import {
  ALIAS_TINTS,
  ANONYMOUS_HELPER,
  EVENT_POST_MAX,
  accumulateNewIds,
  aliasInitials,
  aliasTint,
  authorLabel,
  counterText,
  discussionLabel,
  discussionSubtitle,
  feedErrorMessage,
  isEventFeed,
  isEventFeedUnreadList,
  postFormSchema,
  removePostFromFeed,
  roleLabel,
  toPostBody,
  unreadRowFor,
} from './feed';

function item(id: string, overrides: Partial<EventFeedItem> = {}): EventFeedItem {
  return {
    id,
    parent_id: null,
    kind: overrides.parent_id ? 'reply' : 'post',
    author_id: 'u1',
    author_name: 'Ana',
    author_role: 'member',
    is_anonymous: false,
    mine: false,
    body: 'hello',
    created_at: '2026-11-20T10:00:00Z',
    is_unread: false,
    can_delete: false,
    ...overrides,
  };
}

function feed(): EventFeed {
  return {
    session_id: 's1',
    community_id: 'c1',
    is_organizer: true,
    closes_at: '2026-12-31T00:00:00Z',
    is_open: true,
    can_post: true,
    can_reply: true,
    can_comment: true,
    can_comment_anonymously: false,
    last_read_at: null,
    post_count: 4,
    unread_count: 2,
    posts: [
      {
        ...item('p2', { is_unread: true }),
        parent_id: null,
        replies: [item('r2', { parent_id: 'p2', is_unread: true })],
      },
      { ...item('p1'), parent_id: null, replies: [item('r1', { parent_id: 'p1' })] },
    ],
  };
}

describe('postFormSchema', () => {
  it('accepts text and ignores surrounding whitespace for the limit', () => {
    expect(postFormSchema.safeParse({ body: `  ${'a'.repeat(EVENT_POST_MAX)}  ` }).success).toBe(true);
  });

  it('rejects empty and whitespace-only text', () => {
    expect(postFormSchema.safeParse({ body: '' }).success).toBe(false);
    expect(postFormSchema.safeParse({ body: ' \n\t ' }).success).toBe(false);
  });

  it('rejects more than 1000 characters, counting code points', () => {
    expect(postFormSchema.safeParse({ body: 'a'.repeat(EVENT_POST_MAX + 1) }).success).toBe(false);
    // 1000 emoji are 1000 characters (2000 UTF-16 units): allowed.
    expect(postFormSchema.safeParse({ body: '😀'.repeat(EVENT_POST_MAX) }).success).toBe(true);
    expect(postFormSchema.safeParse({ body: '😀'.repeat(EVENT_POST_MAX + 1) }).success).toBe(false);
  });
});

describe('toPostBody / counterText', () => {
  it('trims', () => {
    expect(toPostBody({ body: '  hi there \n' })).toBe('hi there');
  });
  it('counts the trimmed text', () => {
    expect(counterText('  abc  ')).toBe(`3 / ${EVENT_POST_MAX}`);
  });
});

describe('feedErrorMessage', () => {
  it('has a specific message for the rate limit', () => {
    expect(feedErrorMessage(new AppError('rate_limited'))).toMatch(/5 messages per event per hour/);
  });
  it('explains a closed event and a deleted post', () => {
    expect(feedErrorMessage(new AppError('event_closed'))).toMatch(/closed/);
    expect(feedErrorMessage(new AppError('post_deleted'))).toMatch(/deleted/);
  });
  it('a refused delete does not claim the user tried to post', () => {
    expect(feedErrorMessage(new AppError('forbidden'))).toMatch(/Only an organizer can post/);
    expect(feedErrorMessage(new AppError('forbidden'), 'delete')).toMatch(/no longer delete/);
  });
  it('says the anonymous limit when the failed write was anonymous', () => {
    expect(feedErrorMessage(new AppError('rate_limited'), 'post', true)).toMatch(
      /up to 10 anonymous comments per event per hour/,
    );
    expect(feedErrorMessage(new AppError('rate_limited'), 'post', false)).not.toMatch(/anonymous/);
  });
  it('explains the anonymity errors', () => {
    expect(feedErrorMessage(new AppError('anonymous_not_allowed'))).toMatch(/Organizers cannot comment anonymously/);
    expect(feedErrorMessage(new AppError('alias_pool_exhausted'))).toMatch(/nicknames/);
    expect(feedErrorMessage({ code: 'P0001', message: 'alias_pool_exhausted' })).toMatch(/nicknames/);
  });
  it('maps raw backend errors', () => {
    expect(feedErrorMessage({ code: 'P0001', message: 'validation_failed:body' })).toMatch(/message/);
    expect(feedErrorMessage({ code: 'P0001', message: 'rate_limited' })).toMatch(/per hour/);
  });
});

describe('discussion labels', () => {
  it('has no count without posts', () => {
    expect(discussionLabel(null)).toBe('Discussion');
    expect(discussionLabel({ post_count: 0, unread_count: 0 })).toBe('Discussion');
    expect(discussionSubtitle(null)).toBe('No messages yet');
  });
  it('shows unread first, else the total', () => {
    expect(discussionLabel({ post_count: 5, unread_count: 2 })).toBe('Discussion (2 new)');
    expect(discussionLabel({ post_count: 5, unread_count: 0 })).toBe('Discussion (5)');
    expect(discussionSubtitle({ post_count: 1, unread_count: 0 })).toBe('1 message');
    expect(discussionSubtitle({ post_count: 5, unread_count: 2 })).toBe('5 messages, 2 unread');
  });
  it('finds the row of an event', () => {
    const rows = [{ session_id: 'a', post_count: 1, unread_count: 1, last_post_at: 'x' }];
    expect(unreadRowFor(rows, 'a')).toBe(rows[0]);
    expect(unreadRowFor(rows, 'b')).toBeNull();
    expect(unreadRowFor(undefined, 'a')).toBeNull();
  });
});

describe('author helpers', () => {
  it('names a deleted account "Former member"', () => {
    expect(authorLabel({ author_name: null })).toBe('Former member');
    expect(authorLabel({ author_name: 'Ana' })).toBe('Ana');
  });
  it('shows the nickname of an anonymous item and "You (nickname)" for your own', () => {
    const anon = { author_name: 'Sleepy Capybara', is_anonymous: true, mine: false };
    expect(authorLabel(anon)).toBe('Sleepy Capybara');
    expect(authorLabel({ ...anon, mine: true })).toBe('You (Sleepy Capybara)');
    expect(authorLabel({ author_name: null, is_anonymous: true, mine: false })).toBe('Anonymous');
  });
  it('never calls an anonymous item a former member, and a named item without a name is one', () => {
    expect(authorLabel({ author_name: null, is_anonymous: false, mine: false })).toBe('Former member');
  });
  it('never shows a role on an anonymous item', () => {
    expect(roleLabel({ author_role: 'organizer', is_anonymous: true })).toBeNull();
  });
  it('labels organizers only', () => {
    expect(roleLabel({ author_role: 'organizer' })).toBe('Organizer');
    expect(roleLabel({ author_role: 'member' })).toBeNull();
    expect(roleLabel({ author_role: null })).toBeNull();
  });
});

describe('alias colors', () => {
  it('is stable and always one of the theme tokens', () => {
    const names = ['Sleepy Capybara', 'Grumpy Otter', 'Brave Llama', 'Zesty Yak', '', 'A'];
    for (const name of names) {
      expect(aliasTint(name)).toBe(aliasTint(name));
      expect(ALIAS_TINTS).toContain(aliasTint(name));
    }
  });
  it('spreads different nicknames over several colors', () => {
    const adjectives = ['Sleepy', 'Grumpy', 'Brave', 'Zesty', 'Jolly', 'Mighty', 'Quiet', 'Witty'];
    const used = new Set(adjectives.map((a) => aliasTint(`${a} Capybara`)));
    expect(used.size).toBeGreaterThan(2);
  });
  it('makes two-letter initials', () => {
    expect(aliasInitials('Sleepy Capybara')).toBe('SC');
    expect(aliasInitials('  ')).toBe('?');
    expect(aliasInitials('Cat')).toBe('C');
  });
  it('has the helper line the owner asked for', () => {
    expect(ANONYMOUS_HELPER).toBe('Other members and organizers will see a nickname instead of your name.');
  });
});

describe('accumulateNewIds', () => {
  it('keeps ids that were unread, even after the server marks them read', () => {
    const first = accumulateNewIds(new Set(), feed());
    expect([...first].sort()).toEqual(['p2', 'r2']);
    const read = feed();
    read.posts = read.posts.map((post) => ({
      ...post,
      is_unread: false,
      replies: post.replies.map((reply) => ({ ...reply, is_unread: false })),
    }));
    expect([...accumulateNewIds(first, read)].sort()).toEqual(['p2', 'r2']);
  });
});

describe('removePostFromFeed', () => {
  it('removes a top-level post with its replies and recounts', () => {
    const next = removePostFromFeed(feed(), 'p2');
    expect(next.posts.map((post) => post.id)).toEqual(['p1']);
    expect(next.post_count).toBe(2);
    expect(next.unread_count).toBe(0);
  });
  it('removes a member comment with its replies like a post', () => {
    const f = feed();
    f.posts[0] = { ...f.posts[0]!, kind: 'comment' };
    const next = removePostFromFeed(f, 'p2');
    expect(next.posts.map((post) => post.id)).toEqual(['p1']);
  });
  it('removes a reply only', () => {
    const next = removePostFromFeed(feed(), 'r1');
    expect(next.posts.map((post) => post.replies.length)).toEqual([1, 0]);
    expect(next.post_count).toBe(3);
    expect(next.unread_count).toBe(2);
  });
  it('does not change the input and returns it when the id is unknown', () => {
    const original = feed();
    expect(removePostFromFeed(original, 'nope')).toBe(original);
    removePostFromFeed(original, 'p2');
    expect(original.posts).toHaveLength(2);
  });
});

describe('response guards', () => {
  it('accepts a real feed and rejects other shapes', () => {
    expect(isEventFeed(feed())).toBe(true);
    expect(isEventFeed(null)).toBe(false);
    expect(isEventFeed({ ...feed(), posts: 'x' })).toBe(false);
    expect(isEventFeed({ ...feed(), is_open: 'yes' })).toBe(false);
  });
  it('checks the unread list', () => {
    expect(isEventFeedUnreadList([])).toBe(true);
    expect(isEventFeedUnreadList([{ session_id: 'a', post_count: 1, unread_count: 0, last_post_at: 'x' }])).toBe(true);
    expect(isEventFeedUnreadList([{ session_id: 'a' }])).toBe(false);
    expect(isEventFeedUnreadList({})).toBe(false);
  });
});
