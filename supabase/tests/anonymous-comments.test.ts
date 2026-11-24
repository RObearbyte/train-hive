import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { deleteMyAccount, exportMyData, referencesTo } from './account-deletion-helpers';
import {
  agePost,
  commentOn,
  createPost,
  deletePost,
  endEventDaysAgo,
  eventFeed,
  feedUnread,
  hiddenAuthor,
  markFeedRead,
  replyTo,
  storedPost,
} from './event-feed-helpers';
import {
  addMember,
  admin,
  asAnon,
  asService,
  asUser,
  closeDb,
  countRows,
  createPack,
  createTraining,
  INSUFFICIENT_PRIVILEGE,
  resetData,
  setRsvp,
} from './helpers';
import { notifications } from './notifications-helpers';
import { errorKey, raised, waitForBlocked } from './qa-helpers';

/**
 * Anonymous comments (migration 20261204000100_anonymous_comments.sql): members' own top-level
 * comments, anonymous comments and replies (members only), what anonymity hides and from whom
 * (feed, unread list, direct table reads, Realtime row, service_role, notifications, other
 * people's exports), the author's own delete, organizer moderation, the anonymous rate limit,
 * hygiene, window, unread, export and erasure.
 */

beforeEach(resetData);
afterAll(closeDb);

const UNKNOWN = '00000000-0000-4000-8000-000000000000';
const denied = { code: INSUFFICIENT_PRIVILEGE };
const ANON_NAME = 'Annie Anon';

/** A community with an organizer, a second organizer, the anonymous author and two members; one event. */
async function world() {
  const pack = await createPack(2);
  const author = await addMember(pack.communityId, { name: ANON_NAME });
  const second = await addMember(pack.communityId, { role: 'organizer', name: 'Sam Second' });
  const removed = await addMember(pack.communityId, { status: 'removed', name: 'Rita Removed' });
  const other = await createPack(1);
  const event = await createTraining(pack.organizerId, pack.communityId, { title: 'Hill repeats' });
  return { ...pack, author, second, removed, other, event };
}

/** "Adjective Animal", plain ASCII. */
const ALIAS_SHAPE = /^[A-Z][a-z]+ [A-Z][a-z]+$/;

/** A person's nickname on an event (superuser), or undefined. */
async function aliasOf(sessionId: string, userId: string): Promise<string | undefined> {
  const { rows } = await admin.query<{ alias: string }>(
    'select alias from private.event_aliases where session_id = $1 and user_id = $2',
    [sessionId, userId],
  );
  return rows[0]?.alias;
}

/** True when the text mentions the user by id or by the anonymous author's display name. */
function leaks(value: unknown, authorId: string): boolean {
  const text = JSON.stringify(value);
  return text.includes(authorId) || text.includes(ANON_NAME);
}

describe('create_event_comment', () => {
  it('a member writes a named top-level comment; organizers too; the body is cleaned; nobody is notified', async () => {
    const w = await world();
    await setRsvp(w.memberIds[0], w.event.id, 'going');
    await setRsvp(w.organizerId, w.event.id, 'going');
    const before = await countRows('notifications');
    const comment = await commentOn(w.memberIds[0], w.event.id, '  Who\r\nbrings ‮cones‬?\u0007 ');
    expect(comment).toMatchObject({
      session_id: w.event.id,
      community_id: w.communityId,
      author_id: w.memberIds[0],
      parent_id: null,
      kind: 'comment',
      is_anonymous: false,
      body: 'Who\nbrings cones?',
      deleted_at: null,
    });
    expect(await hiddenAuthor(comment.id)).toBeUndefined();
    const own = await commentOn(w.organizerId, w.event.id, 'I do', false);
    expect(own).toMatchObject({ kind: 'comment', author_id: w.organizerId, is_anonymous: false });
    // Comments notify nobody (named or anonymous).
    await commentOn(w.author, w.event.id, 'Quiet', true);
    expect(await countRows('notifications')).toBe(before);
  });

  it('an anonymous comment is stored without author in the table; the author is kept privately', async () => {
    const w = await world();
    const comment = await commentOn(w.author, w.event.id, 'Too fast last week', true);
    expect(comment).toMatchObject({ kind: 'comment', is_anonymous: true, author_id: null, body: 'Too fast last week' });
    expect(await storedPost(comment.id)).toMatchObject({ author_id: null, is_anonymous: true });
    expect(await hiddenAuthor(comment.id)).toBe(w.author);
    // null for p_anonymous = named.
    expect((await commentOn(w.author, w.event.id, 'Named', null)).author_id).toBe(w.author);
  });

  it('authorization: removed members, other communities, unknown events, anon and service_role are refused; nothing written', async () => {
    const w = await world();
    for (const userId of [w.removed, w.other.organizerId, w.other.memberIds[0]]) {
      for (const anonymous of [false, true]) {
        await expect(commentOn(userId, w.event.id, 'x', anonymous)).rejects.toMatchObject(raised('not_a_member'));
        // Authorization comes before validation.
        await expect(commentOn(userId, w.event.id, '', anonymous)).rejects.toMatchObject(raised('not_a_member'));
      }
    }
    await expect(commentOn(w.author, UNKNOWN)).rejects.toMatchObject(raised('not_found'));
    await expect(commentOn(w.author, null)).rejects.toMatchObject(raised('not_found'));
    await expect(
      asAnon((db) => db.query('select public.create_event_comment($1, $2, $3)', [w.event.id, 'Hi', true])),
    ).rejects.toMatchObject(denied);
    await expect(
      asService((db) => db.query('select public.create_event_comment($1, $2, $3)', [w.event.id, 'Hi', true])),
    ).rejects.toMatchObject(denied);
    expect(await countRows('event_posts')).toBe(0);
  });

  it('organizers can never post anonymously (comment or reply): anonymous_not_allowed, nothing written', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id, 'Organizer post');
    const comment = await commentOn(w.memberIds[0], w.event.id, 'Member comment');
    for (const organizer of [w.organizerId, w.second]) {
      await expect(commentOn(organizer, w.event.id, 'x', true)).rejects.toMatchObject(raised('anonymous_not_allowed'));
      // Checked before the window and the body.
      await expect(commentOn(organizer, w.event.id, '', true)).rejects.toMatchObject(raised('anonymous_not_allowed'));
      for (const parent of [post.id, comment.id]) {
        await expect(replyTo(organizer, parent, 'x', true)).rejects.toMatchObject(raised('anonymous_not_allowed'));
      }
    }
    await endEventDaysAgo(w.event.id, 31);
    await expect(commentOn(w.organizerId, w.event.id, 'x', true)).rejects.toMatchObject(raised('anonymous_not_allowed'));
    expect(await countRows('event_posts')).toBe(2);
    expect(await admin.query('select 1 from private.event_post_anonymous_authors')).toMatchObject({ rowCount: 0 });
  });

  it('a member promoted while their anonymous comment waits for the membership lock is refused after the lock', async () => {
    const w = await world();
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query("update public.memberships set role = 'organizer' where user_id = $1", [w.author]);
      const pending = commentOn(w.author, w.event.id, 'Sneaky', true).then(() => 'ok', errorKey);
      await waitForBlocked('create_event_comment');
      await client.query('commit');
      expect(await pending).toBe('P0001:anonymous_not_allowed');
    } finally {
      client.release();
    }
    expect(await countRows('event_posts')).toBe(0);
  });

  it('body limits and hygiene: 1..1000 characters after cleaning, blank and invisible-only refused', async () => {
    const w = await world();
    expect((await commentOn(w.author, w.event.id, 'x'.repeat(1000), true)).body).toHaveLength(1000);
    expect((await commentOn(w.author, w.event.id, `‪${'y'.repeat(1000)}\u0001 `)).body).toBe('y'.repeat(1000));
    for (const anonymous of [false, true]) {
      for (const body of ['x'.repeat(1001), '', '  \n\t', null, '​', '‮‬', '⠀', '⁦⁩']) {
        await expect(commentOn(w.author, w.event.id, body, anonymous), JSON.stringify(body)).rejects.toMatchObject(
          raised('validation_failed:body'),
        );
      }
    }
    const post = await createPost(w.organizerId, w.event.id);
    await expect(replyTo(w.author, post.id, '​', true)).rejects.toMatchObject(raised('validation_failed:body'));
    expect((await replyTo(w.author, post.id, '⁧ok⁩\r\nfine', true)).body).toBe('ok\nfine');
    expect(await countRows('event_posts')).toBe(4);
  });

  it('posting window: comments and anonymous replies until 30 days after the end, then event_closed', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id);
    await endEventDaysAgo(w.event.id, 29);
    const late = await commentOn(w.author, w.event.id, 'Late', true);
    await replyTo(w.memberIds[0], late.id, 'Reply to a comment', true);
    await endEventDaysAgo(w.event.id, 30);
    const before = await countRows('event_posts');
    await expect(commentOn(w.author, w.event.id, 'x', true)).rejects.toMatchObject(raised('event_closed'));
    await expect(commentOn(w.author, w.event.id, 'x')).rejects.toMatchObject(raised('event_closed'));
    await expect(commentOn(w.author, w.event.id, '', true)).rejects.toMatchObject(raised('event_closed'));
    await expect(replyTo(w.author, post.id, 'x', true)).rejects.toMatchObject(raised('event_closed'));
    expect(await countRows('event_posts')).toBe(before);
    expect(await eventFeed(w.author, w.event.id)).toMatchObject({
      is_open: false, can_comment: false, can_comment_anonymously: false,
    });
    // The author can still delete their anonymous comment.
    expect((await deletePost(w.author, late.id)).deleted_at).not.toBeNull();
  });
});

describe('replies to comments and anonymous replies', () => {
  it('members reply to comments (one level); anonymous replies are stored without author', async () => {
    const w = await world();
    const comment = await commentOn(w.memberIds[0], w.event.id, 'Carpool?');
    const reply = await replyTo(w.author, comment.id, 'Yes please', true);
    expect(reply).toMatchObject({ parent_id: comment.id, kind: 'reply', is_anonymous: true, author_id: null });
    expect(await hiddenAuthor(reply.id)).toBe(w.author);
    await expect(replyTo(w.memberIds[1], reply.id, 'x', true)).rejects.toMatchObject(raised('not_a_top_level_post'));
    const named = await replyTo(w.organizerId, comment.id, 'Sure');
    expect(named).toMatchObject({ kind: 'reply', is_anonymous: false, author_id: w.organizerId });
    for (const userId of [w.removed, w.other.memberIds[0]]) {
      await expect(replyTo(userId, comment.id, 'x', true)).rejects.toMatchObject(raised('not_a_member'));
    }
    await expect(
      asAnon((db) => db.query('select public.reply_to_event_post($1, $2, $3)', [comment.id, 'Hi', true])),
    ).rejects.toMatchObject(denied);
  });

  it('notifications: an anonymous reply is quoted as "<nickname>: ..."; a reply to an anonymous comment reaches its hidden author', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id);
    await admin.query('delete from public.notifications where true');

    const anonymousReply = await replyTo(w.author, post.id, 'Can we  start\nlater?', true);
    const alias = await aliasOf(w.event.id, w.author);
    expect(alias).toMatch(ALIAS_SHAPE);
    const rows = await notifications("kind = 'event_reply'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: w.organizerId,
      title: 'New reply: Hill repeats',
      body: `${alias}: Can we start later?`,
      dedupe_key: `event_reply:${anonymousReply.id}`,
    });
    expect(leaks(rows, w.author)).toBe(false);

    const comment = await commentOn(w.author, w.event.id, 'Secret comment', true);
    await admin.query('delete from public.notifications where true');
    await replyTo(w.memberIds[0], comment.id, 'Good point');
    // The hidden author is notified (the replier is named, as always).
    expect((await notifications("kind = 'event_reply'")).map((n) => [n.user_id, n.body])).toEqual([
      [w.author, 'Member 1: Good point'],
    ]);
    // The hidden author replying under their own anonymous comment: nobody is notified.
    await replyTo(w.author, comment.id, 'Thanks', true);
    expect(await notifications("kind = 'event_reply'")).toHaveLength(1);
    // No notification anywhere names the anonymous author.
    expect(leaks(await notifications(`user_id <> '${w.author}'`), w.author)).toBe(false);
  });
});

describe('anonymity: nobody else can find the author', () => {
  async function anonymousWorld() {
    const w = await world();
    await setRsvp(w.memberIds[0], w.event.id, 'going');
    const post = await createPost(w.organizerId, w.event.id, 'Organizer post');
    const comment = await commentOn(w.author, w.event.id, 'Anonymous comment', true);
    const reply = await replyTo(w.author, post.id, 'Anonymous reply', true);
    await replyTo(w.memberIds[0], comment.id, 'Reply to the anonymous comment');
    return { ...w, post, comment, reply };
  }

  it('get_event_feed shows the nickname (author id and role null) to members and organizers; the author sees mine', async () => {
    const w = await anonymousWorld();
    const alias = await aliasOf(w.event.id, w.author);
    expect(alias).toMatch(ALIAS_SHAPE);
    for (const viewer of [w.memberIds[0], w.memberIds[1], w.organizerId, w.second]) {
      const feed = await eventFeed(viewer, w.event.id);
      expect(leaks(feed, w.author), viewer).toBe(false);
      const comment = feed.posts.find((p) => p.id === w.comment.id);
      expect(comment).toMatchObject({
        kind: 'comment', is_anonymous: true, author_id: null, author_name: alias, author_role: null, mine: false,
        body: 'Anonymous comment',
      });
      const reply = feed.posts.find((p) => p.id === w.post.id)?.replies.find((r) => r.id === w.reply.id);
      // The same person keeps the same nickname within the event.
      expect(reply).toMatchObject({ kind: 'reply', is_anonymous: true, author_id: null, author_name: alias, mine: false });
    }
    const own = await eventFeed(w.author, w.event.id);
    expect(own).toMatchObject({ can_comment: true, can_comment_anonymously: true, can_post: false, post_count: 4 });
    const mine = own.posts.find((p) => p.id === w.comment.id);
    expect(mine).toMatchObject({ is_anonymous: true, mine: true, can_delete: true, author_id: null, author_name: alias });
    expect(own.posts.find((p) => p.id === w.post.id)).toMatchObject({ kind: 'post', mine: false, can_delete: false });
    const organizerFeed = await eventFeed(w.organizerId, w.event.id);
    expect(organizerFeed).toMatchObject({ can_comment: true, can_comment_anonymously: false, can_post: true });
    expect(organizerFeed.posts.every((p) => p.can_delete && p.replies.every((r) => r.can_delete))).toBe(true);
  });

  it('get_event_feed_unread and the other communities: nothing names the author', async () => {
    const w = await anonymousWorld();
    for (const viewer of [w.memberIds[1], w.organizerId]) {
      expect(leaks(await feedUnread(viewer, w.communityId), w.author)).toBe(false);
    }
    await expect(eventFeed(w.other.organizerId, w.event.id)).rejects.toMatchObject(raised('not_a_member'));
  });

  it('direct table reads (members, organizers, service_role) and the Realtime row carry no author for anonymous rows', async () => {
    const w = await anonymousWorld();
    const readAll = (userId: string) =>
      asUser(userId, async (db) => (await db.query('select * from public.event_posts order by created_at')).rows);
    for (const viewer of [w.memberIds[0], w.organizerId, w.second]) {
      const rows = await readAll(viewer);
      expect(rows).toHaveLength(4);
      expect(leaks(rows, w.author), viewer).toBe(false);
      for (const row of rows.filter((r) => r.is_anonymous)) expect(row.author_id).toBeNull();
    }
    // The author's own direct read shows no author either (the table never holds it).
    expect((await readAll(w.author)).filter((r) => r.author_id === w.author)).toEqual([]);
    // Other communities see no rows at all.
    expect(await readAll(w.other.organizerId)).toEqual([]);
    // service_role (bypasses RLS) reads the table but not the private author map.
    const serviceRows = await asService(async (db) => (await db.query('select * from public.event_posts')).rows);
    expect(serviceRows).toHaveLength(4);
    expect(leaks(serviceRows, w.author)).toBe(false);
    for (const run of [
      (sql: string) => asUser(w.organizerId, (db) => db.query(sql)),
      (sql: string) => asUser(w.author, (db) => db.query(sql)),
      (sql: string) => asAnon((db) => db.query(sql)),
      (sql: string) => asService((db) => db.query(sql)),
    ]) {
      for (const table of ['event_post_anonymous_authors', 'event_aliases', 'event_alias_salt']) {
        await expect(run(`select * from private.${table}`), table).rejects.toMatchObject(denied);
      }
      await expect(
        run(`select private.assign_event_alias('${w.event.id}', '${w.memberIds[1]}')`),
      ).rejects.toMatchObject(denied);
    }
    // Realtime publishes the stored row as it is: the published table has no row filter and the
    // stored anonymous rows have a null author_id.
    const { rows: pub } = await admin.query(
      "select rowfilter from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'event_posts'",
    );
    expect(pub).toEqual([{ rowfilter: null }]);
    const { rows: stored } = await admin.query(
      'select author_id from public.event_posts where is_anonymous',
    );
    expect(stored).toEqual([{ author_id: null }, { author_id: null }]);
  });

  it('the export of other members and of organizers never contains the anonymous author', async () => {
    const w = await anonymousWorld();
    for (const userId of [w.organizerId, w.memberIds[0], w.memberIds[1]]) {
      const ex = await exportMyData(userId);
      expect(leaks(ex, w.author), userId).toBe(false);
      expect(JSON.stringify(ex)).not.toContain('Anonymous comment');
    }
    // The organizer's export holds their notification about the anonymous reply, quoted by nickname,
    // and no nickname list (they have none).
    const alias = await aliasOf(w.event.id, w.author);
    const organizerExport = (await exportMyData(w.organizerId)) as unknown as { authored: { event_aliases: unknown[] } };
    expect(JSON.stringify(organizerExport)).toContain(`${alias}: Anonymous reply`);
    expect(organizerExport.authored.event_aliases).toEqual([]);
  });

  it('the rows returned to an organizer who deletes an anonymous item carry no author', async () => {
    const w = await anonymousWorld();
    const deleted = await deletePost(w.organizerId, w.comment.id);
    expect(deleted).toMatchObject({ author_id: null, body: null, is_anonymous: true });
    expect(leaks(deleted, w.author)).toBe(false);
  });
});

describe('nicknames', () => {
  it('stable for one person within an event (comments, replies, after a delete); none for named items or refused writes', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id);
    await commentOn(w.author, w.event.id, 'Named first');
    expect(await aliasOf(w.event.id, w.author)).toBeUndefined();
    const first = await commentOn(w.author, w.event.id, 'One', true);
    const alias = await aliasOf(w.event.id, w.author);
    expect(alias).toMatch(ALIAS_SHAPE);
    await replyTo(w.author, post.id, 'Two', true);
    await deletePost(w.author, first.id);
    await commentOn(w.author, w.event.id, 'Three', true);
    expect(await aliasOf(w.event.id, w.author)).toBe(alias);
    const feed = await eventFeed(w.memberIds[0], w.event.id);
    const names = [
      ...feed.posts.filter((p) => p.is_anonymous).map((p) => p.author_name),
      ...feed.posts.flatMap((p) => p.replies).filter((r) => r.is_anonymous).map((r) => r.author_name),
    ];
    expect(names).toEqual([alias, alias]);
    // Named items still show the display name.
    expect(feed.posts.find((p) => !p.is_anonymous && p.kind === 'comment')?.author_name).toBe(ANON_NAME);
    // A refused anonymous write (organizer, closed event, bad body) assigns nothing.
    await expect(commentOn(w.organizerId, w.event.id, 'x', true)).rejects.toMatchObject(raised('anonymous_not_allowed'));
    await expect(commentOn(w.memberIds[1], w.event.id, '', true)).rejects.toMatchObject(raised('validation_failed:body'));
    expect(await countRows('event_posts')).toBe(5);
    expect((await admin.query('select user_id from private.event_aliases')).rows).toEqual([{ user_id: w.author }]);
  });

  it('differs across events (not linkable) and is unique within an event across many members', async () => {
    const w = await world();
    const events = [w.event];
    for (let i = 0; i < 5; i += 1) events.push(await createTraining(w.organizerId, w.communityId, { title: `Event ${i}` }));
    for (const event of events) await commentOn(w.author, event.id, 'Hi', true);
    const perEvent = await Promise.all(events.map((e) => aliasOf(e.id, w.author)));
    for (const alias of perEvent) expect(alias).toMatch(ALIAS_SHAPE);
    // Six salted, independent draws from 1600: all equal only by a 1-in-1600^5 chance.
    expect(new Set(perEvent).size).toBeGreaterThan(1);

    const crowd: string[] = [];
    for (let i = 0; i < 60; i += 1) crowd.push(await addMember(w.communityId, { name: `Crowd ${i}` }));
    for (let i = 0; i < crowd.length; i += 10) {
      await Promise.all(crowd.slice(i, i + 10).map((u) => commentOn(u, w.event.id, 'Me too', true)));
    }
    const { rows } = await admin.query<{ n: number; distinct: number }>(
      'select count(*)::int as n, count(distinct alias)::int as distinct from private.event_aliases where session_id = $1',
      [w.event.id],
    );
    expect(rows[0]).toEqual({ n: 61, distinct: 61 });
    const feed = await eventFeed(w.organizerId, w.event.id);
    expect(new Set(feed.posts.map((p) => p.author_name)).size).toBe(61);
    expect(feed.posts.every((p) => ALIAS_SHAPE.test(p.author_name ?? ''))).toBe(true);
  });

  it('a taken nickname is skipped; when all 1600 are taken: alias_pool_exhausted and nothing written', async () => {
    const w = await world();
    // 1599 other people already hold every nickname but "Zesty Zebra" on this event.
    await admin.query(
      `with combos as (
         select adj || ' ' || animal as alias
         from unnest(private.alias_adjectives()) adj cross join unnest(private.alias_animals()) animal
         where adj || ' ' || animal <> 'Zesty Zebra'
       ),
       numbered as (select alias, row_number() over (order by alias) as n from combos),
       u as (insert into auth.users (is_anonymous) select true from generate_series(1, 1599) returning id),
       p as (insert into public.profiles (id, display_name) select id, 'Filler' from u returning id),
       pn as (select id, row_number() over (order by id) as n from p)
       insert into private.event_aliases (session_id, user_id, alias)
       select $1, pn.id, numbered.alias from pn join numbered using (n)`,
      [w.event.id],
    );
    await commentOn(w.author, w.event.id, 'Last one', true);
    expect(await aliasOf(w.event.id, w.author)).toBe('Zesty Zebra');
    const before = await countRows('event_posts');
    await expect(commentOn(w.memberIds[0], w.event.id, 'No room', true)).rejects.toMatchObject(raised('alias_pool_exhausted'));
    const post = await createPost(w.organizerId, w.event.id);
    await expect(replyTo(w.memberIds[0], post.id, 'No room', true)).rejects.toMatchObject(raised('alias_pool_exhausted'));
    expect(await countRows('event_posts')).toBe(before + 1);
    expect(await aliasOf(w.event.id, w.memberIds[0])).toBeUndefined();
    // Named comments still work, and the author keeps posting under their nickname.
    await commentOn(w.memberIds[0], w.event.id, 'Named is fine');
    await commentOn(w.author, w.event.id, 'Again', true);
  });

  it('the word lists: 40 x 40 distinct plain-ASCII words', async () => {
    const { rows } = await admin.query<{ adj: string[]; animals: string[] }>(
      'select private.alias_adjectives() as adj, private.alias_animals() as animals',
    );
    for (const list of [rows[0].adj, rows[0].animals]) {
      expect(list).toHaveLength(40);
      expect(new Set(list.map((x) => x.toLowerCase())).size).toBe(40);
      for (const word of list) expect(word).toMatch(/^[A-Z][a-z]+$/);
    }
  });

  it('nicknames go with their event (cascade)', async () => {
    const w = await world();
    const second = await createTraining(w.organizerId, w.communityId);
    await commentOn(w.author, w.event.id, 'x', true);
    await commentOn(w.author, second.id, 'y', true);
    await admin.query('delete from public.training_sessions where id = $1', [w.event.id]);
    expect((await admin.query('select session_id from private.event_aliases')).rows).toEqual([{ session_id: second.id }]);
  });
});

describe('deleting', () => {
  it('the author deletes their own anonymous comment (with its replies) and anonymous reply; others cannot', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id);
    const comment = await commentOn(w.author, w.event.id, 'Mine', true);
    const under = await replyTo(w.memberIds[0], comment.id, 'Under it');
    const reply = await replyTo(w.author, post.id, 'My reply', true);
    for (const userId of [w.memberIds[0], w.memberIds[1], w.removed, w.other.organizerId]) {
      await expect(deletePost(userId, comment.id)).rejects.toMatchObject(raised('forbidden'));
      await expect(deletePost(userId, reply.id)).rejects.toMatchObject(raised('forbidden'));
    }
    // A member never deletes an organizer post, even with a comment of their own on the event.
    await expect(deletePost(w.author, post.id)).rejects.toMatchObject(raised('forbidden'));
    expect(await countRows('event_posts', 'deleted_at is not null')).toBe(0);

    expect(await deletePost(w.author, reply.id)).toMatchObject({ body: null, author_id: null });
    await deletePost(w.author, comment.id);
    for (const id of [comment.id, under.id]) expect((await storedPost(id))?.deleted_at).not.toBeNull();
    expect((await storedPost(post.id))?.deleted_at).toBeNull();
  });

  it('a member deletes their own named comment; organizers delete any comment; a former member no longer can', async () => {
    const w = await world();
    const named = await commentOn(w.memberIds[0], w.event.id, 'Named');
    expect((await deletePost(w.memberIds[0], named.id)).deleted_at).not.toBeNull();
    const byOrganizer = await commentOn(w.memberIds[1], w.event.id, 'Spam', true);
    expect((await deletePost(w.second, byOrganizer.id)).body).toBeNull();
    const kept = await commentOn(w.author, w.event.id, 'Kept', true);
    await asUser(w.author, (db) => db.query('select public.leave_community($1)', [w.communityId]));
    await expect(deletePost(w.author, kept.id)).rejects.toMatchObject(raised('forbidden'));
    // Leaving keeps the comment, still anonymous.
    const feed = await eventFeed(w.memberIds[0], w.event.id);
    expect(feed.posts.find((p) => p.id === kept.id)).toMatchObject({ is_anonymous: true, author_id: null, body: 'Kept' });
  });
});

describe('rate limit: anonymous writes only', () => {
  it('10 anonymous comments and replies per member per event per rolling hour; the 11th is rate_limited; named writes are unlimited', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id);
    const otherEvent = await createTraining(w.organizerId, w.communityId);
    const anon = [];
    for (let i = 0; i < 6; i += 1) anon.push(await commentOn(w.author, w.event.id, `Anon ${i}`, true));
    for (let i = 0; i < 4; i += 1) anon.push(await replyTo(w.author, post.id, `Anon reply ${i}`, true));
    const before = await countRows('event_posts');
    await expect(commentOn(w.author, w.event.id, 'Eleventh', true)).rejects.toMatchObject(raised('rate_limited'));
    await expect(replyTo(w.author, post.id, 'Eleventh', true)).rejects.toMatchObject(raised('rate_limited'));
    expect(await countRows('event_posts')).toBe(before);
    expect(await countRows('notifications', "kind = 'event_reply'")).toBe(4);

    // Named comments and replies are not limited.
    for (let i = 0; i < 12; i += 1) await commentOn(w.author, w.event.id, `Named ${i}`);
    for (let i = 0; i < 12; i += 1) await replyTo(w.author, post.id, `Named reply ${i}`);
    // Per member and per event.
    await commentOn(w.memberIds[0], w.event.id, 'Someone else', true);
    await commentOn(w.author, otherEvent.id, 'Other event', true);

    // Deleting does not give a slot back; an item older than an hour does.
    await deletePost(w.author, anon[0].id);
    await expect(commentOn(w.author, w.event.id, 'Still limited', true)).rejects.toMatchObject(raised('rate_limited'));
    await agePost(anon[1].id, 61);
    await commentOn(w.author, w.event.id, 'One more', true);
    await expect(commentOn(w.author, w.event.id, 'Again', true)).rejects.toMatchObject(raised('rate_limited'));
  });

  it('is exact under concurrency', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id);
    const outcomes = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        (i % 2 === 0
          ? commentOn(w.author, w.event.id, `Parallel ${i}`, true)
          : replyTo(w.author, post.id, `Parallel ${i}`, true)
        ).then(() => 'ok', errorKey),
      ),
    );
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(10);
    expect(outcomes.filter((o) => o === 'P0001:rate_limited')).toHaveLength(6);
    expect(await countRows('event_posts', 'is_anonymous')).toBe(10);
    expect(await admin.query('select 1 from private.event_post_anonymous_authors')).toMatchObject({ rowCount: 10 });
  });
});

describe('unread', () => {
  it('anonymous items of others are unread; the author\'s own anonymous items never are', async () => {
    const w = await world();
    await commentOn(w.author, w.event.id, 'A', true);
    const post = await createPost(w.organizerId, w.event.id, 'P');
    await replyTo(w.author, post.id, 'R', true);
    await commentOn(w.memberIds[0], w.event.id, 'Named');

    expect(await eventFeed(w.author, w.event.id)).toMatchObject({ post_count: 4, unread_count: 2 });
    expect(await feedUnread(w.author, w.communityId)).toEqual([
      expect.objectContaining({ session_id: w.event.id, post_count: 4, unread_count: 2 }),
    ]);
    expect(await eventFeed(w.memberIds[1], w.event.id)).toMatchObject({ unread_count: 4 });
    expect((await eventFeed(w.organizerId, w.event.id)).unread_count).toBe(3);
    await markFeedRead(w.memberIds[1], w.event.id);
    expect((await eventFeed(w.memberIds[1], w.event.id)).unread_count).toBe(0);
    await commentOn(w.author, w.event.id, 'B', true);
    expect((await eventFeed(w.memberIds[1], w.event.id)).unread_count).toBe(1);
    expect((await feedUnread(w.memberIds[1], w.communityId))[0].unread_count).toBe(1);
  });
});

describe('GDPR', () => {
  it('the author\'s export lists their anonymous items, flagged; the scanner finds the hidden author', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id, 'Organizer words');
    const comment = await commentOn(w.author, w.event.id, 'My anonymous words', true);
    const reply = await replyTo(w.author, post.id, 'My anonymous reply', true);
    const named = await commentOn(w.author, w.event.id, 'My named words');
    await commentOn(w.memberIds[0], w.event.id, 'Someone else anonymous', true);

    const otherEvent = await createTraining(w.organizerId, w.communityId, { title: 'Other event' });
    await commentOn(w.author, otherEvent.id, 'Elsewhere', true);

    const ex = (await exportMyData(w.author)) as unknown as {
      authored: { event_posts: Record<string, unknown>[]; event_aliases: Record<string, unknown>[] };
      truncated: Record<string, boolean>;
      README: string;
    };
    const alias = await aliasOf(w.event.id, w.author);
    const otherAlias = await aliasOf(otherEvent.id, w.author);
    expect(ex.authored.event_posts).toEqual([
      expect.objectContaining({ post_id: comment.id, kind: 'comment', is_anonymous: true, alias, body: 'My anonymous words', parent_id: null }),
      expect.objectContaining({ post_id: reply.id, kind: 'reply', is_anonymous: true, alias, parent_id: post.id }),
      expect.objectContaining({ post_id: named.id, kind: 'comment', is_anonymous: false, alias: null }),
      expect.objectContaining({ session_id: otherEvent.id, is_anonymous: true, alias: otherAlias }),
    ]);
    expect(ex.authored.event_aliases).toEqual([
      expect.objectContaining({ session_id: w.event.id, event_title: 'Hill repeats', alias }),
      expect.objectContaining({ session_id: otherEvent.id, event_title: 'Other event', alias: otherAlias }),
    ]);
    expect(ex.truncated).toMatchObject({ event_aliases: false, event_posts: false });
    expect(ex.README).toContain('is_anonymous marks the ones you posted anonymously');
    expect(JSON.stringify(ex)).not.toContain('Someone else anonymous');
    // The other member's nickname is not in the author's export.
    expect(JSON.stringify(ex)).not.toContain(`"${await aliasOf(w.event.id, w.memberIds[0])}"`);

    const refs = await referencesTo(w.author);
    expect(refs['private.event_post_anonymous_authors.author_id']).toBe(3);
    expect(refs['private.event_aliases.user_id']).toBe(2);
    expect(refs['public.event_posts.author_id']).toBe(1);

    const organizerExport = (await exportMyData(w.organizerId)) as unknown as {
      authored: { event_posts: Record<string, unknown>[] };
    };
    expect(organizerExport.authored.event_posts).toEqual([
      expect.objectContaining({ body: 'Organizer words', kind: 'post', is_anonymous: false }),
    ]);
  });

  it('account deletion: comments and replies (anonymous or not) go, with the notifications quoting them; organizer posts stay', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id, 'Organizer post');
    const anonComment = await commentOn(w.author, w.event.id, 'Anon comment', true);
    const namedComment = await commentOn(w.author, w.event.id, 'Named comment');
    const anonReply = await replyTo(w.author, post.id, 'Anon reply', true);
    const namedReply = await replyTo(w.author, post.id, 'Named reply');
    const underComment = await replyTo(w.memberIds[0], anonComment.id, 'Under the anonymous comment');
    const keptReply = await replyTo(w.memberIds[1], post.id, 'Kept reply');
    await markFeedRead(w.author, w.event.id);
    expect(await countRows('notifications', 'dedupe_key = $1', [`event_reply:${anonReply.id}`])).toBe(1);

    await deleteMyAccount(w.author);

    expect(await referencesTo(w.author)).toEqual({});
    for (const id of [anonComment.id, namedComment.id, anonReply.id, namedReply.id, underComment.id]) {
      expect(await storedPost(id), id).toBeUndefined();
    }
    expect(await countRows('notifications', 'dedupe_key = any ($1)', [[`event_reply:${anonReply.id}`, `event_reply:${namedReply.id}`]])).toBe(0);
    expect(await storedPost(post.id)).toMatchObject({ author_id: w.organizerId, body: 'Organizer post' });
    expect(await storedPost(keptReply.id)).toMatchObject({ author_id: w.memberIds[1] });
    expect(await admin.query('select 1 from private.event_post_anonymous_authors')).toMatchObject({ rowCount: 0 });
    expect(await aliasOf(w.event.id, w.author)).toBeUndefined();
  });

  it('an organizer\'s account deletion: their posts stay without author, their comments go', async () => {
    const w = await world();
    const post = await createPost(w.second, w.event.id, 'Second organizer post');
    const comment = await commentOn(w.second, w.event.id, 'Second organizer comment');
    await deleteMyAccount(w.second);
    expect(await storedPost(post.id)).toMatchObject({ author_id: null, is_anonymous: false, body: 'Second organizer post' });
    expect(await storedPost(comment.id)).toBeUndefined();
    // A deleted account's post: author null, not anonymous ("Former member").
    const feed = await eventFeed(w.memberIds[0], w.event.id);
    expect(feed.posts).toEqual([expect.objectContaining({ id: post.id, author_id: null, is_anonymous: false, kind: 'post', mine: false })]);
  });

  it('anonymous activity counts as account activity (retention)', async () => {
    const w = await world();
    await admin.query("update auth.users set created_at = now() - interval '900 days' where id = $1", [w.author]);
    const before = (await admin.query('select private.account_last_activity($1) as at', [w.author])).rows[0].at as Date;
    await commentOn(w.author, w.event.id, 'Still here', true);
    const after = (await admin.query('select private.account_last_activity($1) as at', [w.author])).rows[0].at as Date;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
    const { rows } = await admin.query<{ at: Date }>(
      `select max(ep.created_at) as at from public.event_posts ep
       join private.event_post_anonymous_authors a on a.post_id = ep.id where a.author_id = $1`,
      [w.author],
    );
    expect(after).toEqual(rows[0].at);
  });

  it('a deleted account\'s still-valid token gets only the functions\' own errors', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id);
    await deleteMyAccount(w.author);
    const outcomes = [];
    for (const [sql, params] of [
      ['select public.create_event_comment($1, $2, $3)', [w.event.id, 'Ghost', true]],
      ['select public.reply_to_event_post($1, $2, $3)', [post.id, 'Ghost', true]],
    ] as [string, unknown[]][]) {
      outcomes.push(await asUser(w.author, (db) => db.query(sql, params)).then(() => 'ok', errorKey));
    }
    expect(outcomes).toEqual(['P0001:not_a_member', 'P0001:not_a_member']);
  });
});

describe('schema', () => {
  it('checks: an anonymous row has no author_id, organizer posts are never anonymous, kind matches parent_id', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id);
    const comment = await commentOn(w.author, w.event.id, 'x', true);
    for (const [sql, id] of [
      ['update public.event_posts set author_id = $2 where id = $1', comment.id],
      ['update public.event_posts set is_anonymous = true, author_id = null where id = $1', post.id],
      ["update public.event_posts set kind = 'reply' where id = $1", comment.id],
      ["update public.event_posts set kind = 'banana' where id = $1", comment.id],
    ] as const) {
      const params = sql.includes('$2') ? [id, w.author] : [id];
      await expect(admin.query(sql, params), sql).rejects.toMatchObject({ code: '23514' });
    }
    const reply = await replyTo(w.memberIds[0], post.id);
    await expect(
      admin.query("update public.event_posts set kind = 'comment' where id = $1", [reply.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('the hidden-author table: no privilege for any API role; RLS-free because nobody can reach it', async () => {
    const { rows } = await admin.query<{ role: string; any: boolean }>(
      `select r as role,
              has_table_privilege(r, 'private.event_post_anonymous_authors', 'select, insert, update, delete, truncate, references, trigger') as any
       from unnest(array['anon', 'authenticated', 'service_role']) r`,
    );
    expect(rows).toEqual([
      { role: 'anon', any: false },
      { role: 'authenticated', any: false },
      { role: 'service_role', any: false },
    ]);
  });

  it('API clients cannot write the new columns directly', async () => {
    const w = await world();
    const comment = await commentOn(w.author, w.event.id, 'x', true);
    for (const userId of [w.organizerId, w.author]) {
      await expect(
        asUser(userId, (db) => db.query('update public.event_posts set is_anonymous = false where id = $1', [comment.id])),
      ).rejects.toMatchObject(denied);
    }
  });
});
