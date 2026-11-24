/**
 * Event feed: form validation, labels and cache helpers. Pure TypeScript.
 * The server owns every rule (who may post, the window, the rate limit);
 * the checks here only save a round trip and are advisory.
 */
import { z } from 'zod';

import type { EventFeed, EventFeedItem, EventFeedUnread } from '@/lib/database.types';
import { toAppError, userMessage } from '@/lib/errors';

export const EVENT_POST_MAX = 1000;
/** Top-level posts per organizer per event per hour (server limit; for the message only). */
export const EVENT_POST_HOURLY_LIMIT = 5;

/** Length in characters (code points), as Postgres `char_length` counts. */
export function charCount(text: string): number {
  return Array.from(text).length;
}

export type PostFormValues = { body: string };

export const postFormSchema = z.object({ body: z.string() }).superRefine((values, ctx) => {
  const body = values.body.trim();
  if (body === '') {
    ctx.addIssue({ code: 'custom', path: ['body'], message: 'Write a message first.' });
  } else if (charCount(body) > EVENT_POST_MAX) {
    ctx.addIssue({
      code: 'custom',
      path: ['body'],
      message: `Keep it to ${EVENT_POST_MAX} characters.`,
    });
  }
});

/** The text that is sent: trimmed. */
export function toPostBody(values: PostFormValues): string {
  return values.body.trim();
}

/** "12 / 1000", counting the text as it will be sent. */
export function counterText(body: string): string {
  return `${charCount(body.trim())} / ${EVENT_POST_MAX}`;
}

/** Anonymous comments and replies per member per event per rolling hour (server limit; for the message only). */
export const ANONYMOUS_HOURLY_LIMIT = 10;

/** One line under the "Post anonymously" switch. */
export const ANONYMOUS_HELPER = 'Other members and organizers will see a nickname instead of your name.';

/**
 * Friendly text for a failed post, comment, reply or delete. `anonymous` says the
 * failed write was anonymous (the rate limit differs).
 */
export function feedErrorMessage(
  error: unknown,
  action: 'post' | 'delete' = 'post',
  anonymous = false,
): string {
  const appError = toAppError(error);
  if (appError.code === 'rate_limited') {
    return anonymous
      ? `You can post up to ${ANONYMOUS_HOURLY_LIMIT} anonymous comments per event per hour. Please try again later or comment with your name.`
      : `You can post ${EVENT_POST_HOURLY_LIMIT} messages per event per hour. Please try again later.`;
  }
  if (appError.code === 'forbidden') {
    return action === 'delete'
      ? 'You can no longer delete this message.'
      : 'Only an organizer can post here.';
  }
  return userMessage(appError.code, appError.field);
}

type CountRow = Pick<EventFeedUnread, 'post_count' | 'unread_count'>;

/** Heading of the entry point on the event details: "Discussion", "Discussion (3)" or "Discussion (2 new)". */
export function discussionLabel(row: CountRow | null): string {
  if (row === null || row.post_count <= 0) return 'Discussion';
  if (row.unread_count > 0) return `Discussion (${row.unread_count} new)`;
  return `Discussion (${row.post_count})`;
}

/** Secondary line of the entry point. */
export function discussionSubtitle(row: CountRow | null): string {
  if (row === null || row.post_count <= 0) return 'No messages yet';
  const posts = `${row.post_count} ${row.post_count === 1 ? 'message' : 'messages'}`;
  return row.unread_count > 0 ? `${posts}, ${row.unread_count} unread` : posts;
}

/** The unread row of one event, or null when it has no posts. */
export function unreadRowFor(
  rows: readonly EventFeedUnread[] | undefined,
  sessionId: string,
): EventFeedUnread | null {
  return rows?.find((row) => row.session_id === sessionId) ?? null;
}

/**
 * Who wrote it, as shown. An anonymous item shows its nickname (`author_name`);
 * your own anonymous item reads "You (Sleepy Capybara)". No name and not anonymous
 * means the account was deleted.
 */
export function authorLabel(
  item: Pick<EventFeedItem, 'author_name'> & Partial<Pick<EventFeedItem, 'is_anonymous' | 'mine'>>,
): string {
  const name = item.author_name === null || item.author_name.trim() === '' ? null : item.author_name;
  if (item.is_anonymous === true) {
    if (name === null) return 'Anonymous';
    return item.mine === true ? `You (${name})` : name;
  }
  return name ?? 'Former member';
}

/** The role chip: organizers only, and never on an anonymous item. */
export function roleLabel(
  item: Pick<EventFeedItem, 'author_role'> & Partial<Pick<EventFeedItem, 'is_anonymous'>>,
): string | null {
  return item.author_role === 'organizer' && item.is_anonymous !== true ? 'Organizer' : null;
}

/**
 * Soft color tokens used behind an anonymous nickname. All are theme tokens
 * (light and dark variants exist and carry the normal text color).
 */
export const ALIAS_TINTS = ['primarySoft', 'infoSoft', 'warningSoft', 'successSoft', 'dangerSoft'] as const;
export type AliasTint = (typeof ALIAS_TINTS)[number];

/** A stable color for a nickname: the same string always gives the same token. */
export function aliasTint(nickname: string): AliasTint {
  let hash = 0;
  for (let i = 0; i < nickname.length; i += 1) hash = (hash * 31 + nickname.charCodeAt(i)) >>> 0;
  return ALIAS_TINTS[hash % ALIAS_TINTS.length] ?? 'primarySoft';
}

/** Two letters for the circle of a nickname: "Sleepy Capybara" -> "SC". */
export function aliasInitials(nickname: string): string {
  const parts = nickname.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = Array.from(parts[0] ?? '')[0] ?? '';
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1] ?? '')[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/**
 * Ids that were unread when seen, kept while the screen is open: opening the
 * feed marks it read on the server, and the "New" cue must outlive that.
 */
export function accumulateNewIds(previous: ReadonlySet<string>, feed: EventFeed): Set<string> {
  const next = new Set(previous);
  for (const post of feed.posts) {
    if (post.is_unread) next.add(post.id);
    for (const reply of post.replies) if (reply.is_unread) next.add(reply.id);
  }
  return next;
}

/**
 * Optimistic delete: the feed without a post (and its replies) or a reply,
 * counts recomputed. Returns the same object when the id is not in it.
 */
export function removePostFromFeed(feed: EventFeed, postId: string): EventFeed {
  let changed = false;
  const posts: EventFeed['posts'] = [];
  for (const post of feed.posts) {
    if (post.id === postId) {
      changed = true;
      continue;
    }
    const replies = post.replies.filter((reply) => reply.id !== postId);
    if (replies.length !== post.replies.length) changed = true;
    posts.push(replies.length === post.replies.length ? post : { ...post, replies });
  }
  if (!changed) return feed;
  let postCount = 0;
  let unreadCount = 0;
  for (const post of posts) {
    postCount += 1 + post.replies.length;
    unreadCount += (post.is_unread ? 1 : 0) + post.replies.filter((reply) => reply.is_unread).length;
  }
  return { ...feed, posts, post_count: postCount, unread_count: unreadCount };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Cheap structural check of the RPC answer (it is typed `Json`). */
export function isEventFeed(value: unknown): value is EventFeed {
  return (
    isObject(value) &&
    typeof value.session_id === 'string' &&
    typeof value.is_open === 'boolean' &&
    typeof value.can_post === 'boolean' &&
    typeof value.can_reply === 'boolean' &&
    typeof value.is_organizer === 'boolean' &&
    typeof value.unread_count === 'number' &&
    typeof value.post_count === 'number' &&
    Array.isArray(value.posts) &&
    value.posts.every(
      (post) => isObject(post) && typeof post.id === 'string' && Array.isArray(post.replies),
    )
  );
}

export function isEventFeedUnreadList(value: unknown): value is EventFeedUnread[] {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        isObject(row) &&
        typeof row.session_id === 'string' &&
        typeof row.post_count === 'number' &&
        typeof row.unread_count === 'number',
    )
  );
}
