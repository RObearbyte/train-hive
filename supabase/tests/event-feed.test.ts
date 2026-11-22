import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { deleteMyAccount, exportMyData, referencesTo } from './account-deletion-helpers';
import {
  agePost,
  createPost,
  deletePost,
  endEventDaysAgo,
  eventFeed,
  feedUnread,
  markFeedRead,
  replyTo,
  storedPost,
} from './event-feed-helpers';
import {
  addMember,
  admin,
  asAnon,
  asUser,
  closeDb,
  countRows,
  createPack,
  createTraining,
  INSUFFICIENT_PRIVILEGE,
  resetData,
  setRsvp,
} from './helpers';
import { claimJobs, jobs, notifications, registerToken } from './notifications-helpers';
import { errorKey, raised, waitForBlocked } from './qa-helpers';

/**
 * P4 event feed (migration 20261129000100_event_feed.sql): organizer posts, member replies (one
 * level), deletion (organizers: any post; authors: own replies), posting window, rate limit,
 * notifications and deep links, read cursor and unread counts, GDPR export and erasure.
 */

beforeEach(resetData);
afterAll(closeDb);

const UNKNOWN = '00000000-0000-4000-8000-000000000000';
const denied = { code: INSUFFICIENT_PRIVILEGE };

/** Push jobs of feed notifications (event creation also queues training_created jobs). */
const feedJobs = () =>
  jobs("notification_id in (select id from public.notifications where kind in ('event_post', 'event_reply'))");

/** A community with an organizer, three members and a removed member; one event. */
async function world() {
  const pack = await createPack(3);
  const removed = await addMember(pack.communityId, { status: 'removed', name: 'Rita Removed' });
  const other = await createPack(1);
  const event = await createTraining(pack.organizerId, pack.communityId, { title: 'Hill repeats' });
  return { ...pack, removed, other, event };
}

describe('create_event_post', () => {
  it('an organizer posts; the body is cleaned and stored', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id, '  Bring\r\nwater ‮please‬.\u0007  ');
    expect(post).toMatchObject({
      session_id: w.event.id,
      community_id: w.communityId,
      author_id: w.organizerId,
      parent_id: null,
      body: 'Bring\nwater please.',
      deleted_at: null,
    });
    expect((await storedPost(post.id))?.body).toBe('Bring\nwater please.');
  });

  it('members, removed organizers, organizers of other communities, outsiders: forbidden; nothing written', async () => {
    const w = await world();
    const removedOrganizer = await addMember(w.communityId, { role: 'organizer', status: 'removed' });
    for (const userId of [w.memberIds[0], removedOrganizer, w.other.organizerId, w.other.memberIds[0], w.removed]) {
      await expect(createPost(userId, w.event.id)).rejects.toMatchObject(raised('forbidden'));
      // Authorization comes before validation: an invalid body still answers forbidden.
      await expect(createPost(userId, w.event.id, '')).rejects.toMatchObject(raised('forbidden'));
    }
    await expect(createPost(w.organizerId, UNKNOWN)).rejects.toMatchObject(raised('not_found'));
    await expect(createPost(w.organizerId, null)).rejects.toMatchObject(raised('not_found'));
    // An organizer of another community cannot post on this event, even with a valid body.
    await expect(createPost(w.other.organizerId, w.event.id, 'Spam')).rejects.toMatchObject(raised('forbidden'));
    await expect(
      asAnon((db) => db.query('select public.create_event_post($1, $2)', [w.event.id, 'Hi'])),
    ).rejects.toMatchObject(denied);
    expect(await countRows('event_posts')).toBe(0);
    expect(await countRows('notifications', "kind = 'event_post'")).toBe(0);
  });

  it('body limits: 1..1000 characters after cleaning; blank and invisible-only text rejected', async () => {
    const w = await world();
    const exact = await createPost(w.organizerId, w.event.id, 'x'.repeat(1000));
    expect(exact.body).toHaveLength(1000);
    // Stripped characters do not count.
    const padded = await createPost(w.organizerId, w.event.id, `‪${'y'.repeat(1000)}\u0001  `);
    expect(padded.body).toBe('y'.repeat(1000));
    for (const body of ['x'.repeat(1001), '', '   \n\t ', null, '​​', '‮‬', '⠀', '⁦⁩']) {
      await expect(createPost(w.organizerId, w.event.id, body), JSON.stringify(body)).rejects.toMatchObject(
        raised('validation_failed:body'),
      );
    }
    // Invisible characters next to visible text are kept (emoji ZWJ sequence).
    const emoji = await createPost(w.organizerId, w.event.id, '\u{1F3C3}‍♀️ go');
    expect(emoji.body).toBe('\u{1F3C3}‍♀️ go');
    expect(await countRows('event_posts')).toBe(3);
  });

  it('a cancelled event can still be discussed', async () => {
    const w = await world();
    await asUser(w.organizerId, (db) => db.query('select public.cancel_training($1)', [w.event.id]));
    const post = await createPost(w.organizerId, w.event.id, 'Rescheduled to next week.');
    expect(post.body).toBe('Rescheduled to next week.');
    expect((await replyTo(w.memberIds[0], post.id, 'OK')).parent_id).toBe(post.id);
  });
});

describe('posting window: until 30 days after the event ends', () => {
  it('open 29 days after the end, closed at 30 days (event_closed); reading, marking and deleting still work', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id, 'Before');
    const reply = await replyTo(w.memberIds[0], post.id, 'Reply before');

    await endEventDaysAgo(w.event.id, 29);
    const late = await createPost(w.organizerId, w.event.id, 'Photos are up');
    await replyTo(w.memberIds[1], late.id, 'Thanks');
    expect(await eventFeed(w.memberIds[0], w.event.id)).toMatchObject({ is_open: true, can_reply: true, can_post: false });

    await endEventDaysAgo(w.event.id, 30);
    const before = await countRows('event_posts');
    await expect(createPost(w.organizerId, w.event.id, 'Too late')).rejects.toMatchObject(raised('event_closed'));
    await expect(replyTo(w.memberIds[0], post.id, 'Too late')).rejects.toMatchObject(raised('event_closed'));
    // Closed comes before body validation.
    await expect(createPost(w.organizerId, w.event.id, '')).rejects.toMatchObject(raised('event_closed'));
    // Authorization comes before the window.
    await expect(createPost(w.memberIds[0], w.event.id, 'x')).rejects.toMatchObject(raised('forbidden'));
    await expect(replyTo(w.other.memberIds[0], post.id, 'x')).rejects.toMatchObject(raised('not_a_member'));
    expect(await countRows('event_posts')).toBe(before);

    const feed = await eventFeed(w.organizerId, w.event.id);
    expect(feed).toMatchObject({ is_open: false, can_post: false, can_reply: false, is_organizer: true });
    expect(new Date(feed.closes_at).getTime()).toBeLessThanOrEqual(Date.now());
    await markFeedRead(w.memberIds[0], w.event.id);
    expect((await deletePost(w.memberIds[0], reply.id)).deleted_at).not.toBeNull();
    expect((await deletePost(w.organizerId, post.id)).deleted_at).not.toBeNull();
  });

  it('without an end time the window is start + 2 hours + 30 days', async () => {
    const w = await world();
    await endEventDaysAgo(w.event.id, 29, false);
    await createPost(w.organizerId, w.event.id, 'Still open');
    await endEventDaysAgo(w.event.id, 30, false);
    await expect(createPost(w.organizerId, w.event.id, 'Closed')).rejects.toMatchObject(raised('event_closed'));
  });
});

describe('reply_to_event_post', () => {
  it('any active member (organizers too) replies to a top-level post', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id);
    const reply = await replyTo(w.memberIds[0], post.id, ' Will do! ');
    expect(reply).toMatchObject({
      session_id: w.event.id,
      community_id: w.communityId,
      author_id: w.memberIds[0],
      parent_id: post.id,
      body: 'Will do!',
    });
    const own = await replyTo(w.organizerId, post.id, 'Thanks');
    expect(own.parent_id).toBe(post.id);
  });

  it('replies are one level only; a deleted parent takes no replies', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id);
    const reply = await replyTo(w.memberIds[0], post.id);
    await expect(replyTo(w.memberIds[1], reply.id)).rejects.toMatchObject(raised('not_a_top_level_post'));
    await deletePost(w.organizerId, post.id);
    await expect(replyTo(w.memberIds[1], post.id)).rejects.toMatchObject(raised('post_deleted'));
    expect(await countRows('event_posts', 'parent_id = $1', [post.id])).toBe(1);
  });

  it('outsiders, removed members and anon are refused; unknown posts are not_found; body hygiene; nothing written', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id);
    for (const userId of [w.removed, w.other.organizerId, w.other.memberIds[0]]) {
      await expect(replyTo(userId, post.id)).rejects.toMatchObject(raised('not_a_member'));
    }
    await expect(replyTo(w.memberIds[0], UNKNOWN)).rejects.toMatchObject(raised('not_found'));
    await expect(replyTo(w.memberIds[0], null)).rejects.toMatchObject(raised('not_found'));
    for (const body of ['​', '', null, '‮', 'z'.repeat(1001)]) {
      await expect(replyTo(w.memberIds[0], post.id, body), JSON.stringify(body)).rejects.toMatchObject(
        raised('validation_failed:body'),
      );
    }
    await expect(
      asAnon((db) => db.query('select public.reply_to_event_post($1, $2)', [post.id, 'Hi'])),
    ).rejects.toMatchObject(denied);
    expect(await countRows('event_posts', 'parent_id is not null')).toBe(0);
    // A reply is cleaned like a post.
    expect((await replyTo(w.memberIds[0], post.id, '⁧ok⁩\r\nfine')).body).toBe('ok\nfine');
  });

  it('the table refuses a reply attached to a post of another event (composite foreign key)', async () => {
    const w = await world();
    const second = await createTraining(w.organizerId, w.communityId);
    const post = await createPost(w.organizerId, w.event.id);
    await expect(
      admin.query(
        `insert into public.event_posts (session_id, community_id, author_id, parent_id, body)
         values ($1, $2, $3, $4, 'x')`,
        [second.id, w.communityId, w.memberIds[0], post.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('a reply racing a delete of its parent: the delete wins and the reply is refused', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id);
    await asUser(w.organizerId, async (db) => {
      await db.query('begin');
      await db.query('select public.delete_event_post($1)', [post.id]);
      const reply = replyTo(w.memberIds[0], post.id, 'Late').then(() => 'ok', errorKey);
      await waitForBlocked('reply_to_event_post');
      await db.query('commit');
      expect(await reply).toBe('P0001:post_deleted');
    });
    expect(await countRows('event_posts', 'parent_id = $1', [post.id])).toBe(0);
  });
});

describe('delete_event_post', () => {
  it('an organizer deletes a member reply: tombstone without body; idempotent', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id);
    const reply = await replyTo(w.memberIds[0], post.id, 'Rude words');
    const deleted = await deletePost(w.organizerId, reply.id);
    expect(deleted.body).toBeNull();
    expect(deleted.deleted_at).not.toBeNull();
    const again = await deletePost(w.organizerId, reply.id);
    expect(again.deleted_at).toEqual(deleted.deleted_at);
    expect((await storedPost(post.id))?.deleted_at).toBeNull();
  });

  it('deleting a top-level post deletes its replies and the notifications quoting them', async () => {
    const w = await world();
    await setRsvp(w.memberIds[0], w.event.id, 'going');
    const post = await createPost(w.organizerId, w.event.id, 'Post text');
    const reply = await replyTo(w.memberIds[1], post.id, 'Reply text');
    expect(await countRows('notifications', "kind in ('event_post', 'event_reply')")).toBe(2);
    await deletePost(w.organizerId, post.id);
    for (const id of [post.id, reply.id]) {
      const row = await storedPost(id);
      expect(row?.body).toBeNull();
      expect(row?.deleted_at).not.toBeNull();
    }
    expect(await countRows('notifications', "kind in ('event_post', 'event_reply')")).toBe(0);
    expect(await feedJobs()).toHaveLength(0);
    const feed = await eventFeed(w.memberIds[0], w.event.id);
    expect(feed.posts).toEqual([]);
    expect(feed.post_count).toBe(0);
  });

  it('the author of a reply may delete it; nobody else but organizers; members never delete top-level posts', async () => {
    const w = await world();
    const [author, otherMember] = w.memberIds;
    const post = await createPost(w.organizerId, w.event.id);
    const reply = await replyTo(author, post.id, 'Oops');
    const otherReply = await replyTo(otherMember, post.id, 'Mine');

    for (const userId of [otherMember, w.removed, w.other.organizerId, w.other.memberIds[0]]) {
      await expect(deletePost(userId, reply.id)).rejects.toMatchObject(raised('forbidden'));
    }
    for (const userId of [author, otherMember, w.removed, w.other.organizerId]) {
      await expect(deletePost(userId, post.id)).rejects.toMatchObject(raised('forbidden'));
    }
    await expect(deletePost(w.organizerId, UNKNOWN)).rejects.toMatchObject(raised('not_found'));
    await expect(deletePost(w.organizerId, null)).rejects.toMatchObject(raised('not_found'));
    await expect(
      asAnon((db) => db.query('select public.delete_event_post($1)', [post.id])),
    ).rejects.toMatchObject(denied);
    expect(await countRows('event_posts', 'deleted_at is null')).toBe(3);

    const own = await deletePost(author, reply.id);
    expect(own).toMatchObject({ body: null, author_id: author });
    expect((await storedPost(post.id))?.deleted_at).toBeNull();
    expect((await storedPost(otherReply.id))?.deleted_at).toBeNull();

    // An author who left the community can no longer delete their reply.
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [otherMember]);
    await expect(deletePost(otherMember, otherReply.id)).rejects.toMatchObject(raised('forbidden'));
  });

  it('a reply author deleting their reply also removes the notification that quotes it (and its push job)', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id);
    const keep = await replyTo(w.memberIds[1], post.id, 'Stays');
    const reply = await replyTo(w.memberIds[0], post.id, 'Typo reply');
    expect(await countRows('notifications', "kind = 'event_reply'")).toBe(2);
    await deletePost(w.memberIds[0], reply.id);
    const left = await notifications("kind = 'event_reply'");
    expect(left.map((n) => n.dedupe_key)).toEqual([`event_reply:${keep.id}`]);
    expect(await feedJobs()).toHaveLength(1);
    // The tombstone keeps no text anywhere a member can read it.
    const { rows } = await admin.query('select body from public.notifications where body like $1', ['%Typo reply%']);
    expect(rows).toHaveLength(0);
  });

  it('a second organizer can delete the first organizer\'s post', async () => {
    const w = await world();
    const second = await addMember(w.communityId, { role: 'organizer', name: 'Sam Second' });
    const post = await createPost(w.organizerId, w.event.id);
    expect((await deletePost(second, post.id)).body).toBeNull();
  });
});

describe('notifications', () => {
  it('an organizer post notifies the going members only, never the author; deep link /events/<id>/feed', async () => {
    const w = await world();
    const [goingA, goingB, notGoing] = w.memberIds;
    await setRsvp(goingA, w.event.id, 'going');
    await setRsvp(goingB, w.event.id, 'going');
    await setRsvp(notGoing, w.event.id, 'not_going');
    await setRsvp(w.organizerId, w.event.id, 'going');
    // A removed member's old going RSVP does not make them a recipient.
    await admin.query(
      "insert into public.training_rsvps (session_id, community_id, user_id, response) values ($1, $2, $3, 'going')",
      [w.event.id, w.communityId, w.removed],
    );
    // A member of another community with a going RSVP elsewhere gets nothing.
    const elsewhere = await createTraining(w.other.organizerId, w.other.communityId);
    await setRsvp(w.other.memberIds[0], elsewhere.id, 'going');

    const post = await createPost(w.organizerId, w.event.id, 'Meet  at the\n\ngate.');
    const rows = await notifications("kind = 'event_post'");
    expect(rows.map((n) => n.user_id).sort()).toEqual([goingA, goingB].sort());
    for (const n of rows) {
      expect(n).toMatchObject({
        community_id: w.communityId,
        title: 'New post: Hill repeats',
        body: 'Meet at the gate.',
        deep_link: `/events/${w.event.id}/feed`,
        related_session_id: w.event.id,
        related_announcement_id: null,
        dedupe_key: `event_post:${post.id}`,
      });
    }
    expect(await feedJobs()).toHaveLength(2);
  });

  it('a reply notifies only the parent author, never oneself; an inactive author gets nothing', async () => {
    const w = await world();
    const second = await addMember(w.communityId, { role: 'organizer', name: 'Sam Second' });
    await setRsvp(w.memberIds[0], w.event.id, 'going');
    const post = await createPost(w.organizerId, w.event.id);
    await admin.query('delete from public.notifications where true');

    const reply = await replyTo(w.memberIds[0], post.id, 'On my way');
    const replyRows = await notifications("kind = 'event_reply'");
    expect(replyRows).toHaveLength(1);
    expect(replyRows[0]).toMatchObject({
      user_id: w.organizerId,
      title: 'New reply: Hill repeats',
      body: 'Member 1: On my way',
      deep_link: `/events/${w.event.id}/feed`,
      related_session_id: w.event.id,
      dedupe_key: `event_reply:${reply.id}`,
    });
    expect(await feedJobs()).toHaveLength(1);

    // The author replying to their own post: nobody.
    await replyTo(w.organizerId, post.id, 'Note to self');
    // A co-organizer replying: the author.
    await replyTo(second, post.id, 'Agreed');
    expect((await notifications("kind = 'event_reply'")).map((n) => n.user_id)).toEqual([
      w.organizerId,
      w.organizerId,
    ]);
    // Other repliers of the same post are not notified.
    expect(await countRows('notifications', 'user_id = $1', [w.memberIds[0]])).toBe(0);

    // The post's author is no longer an active member: a reply notifies nobody.
    const post2 = await createPost(second, w.event.id);
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [second]);
    await replyTo(w.memberIds[1], post2.id);
    expect(await notifications("kind = 'event_reply'")).toHaveLength(2);
  });

  it('the deep link allowlist accepts /events/<uuid>/feed (lowercase) and keeps the existing routes', async () => {
    const w = await world();
    const uuid = w.event.id;
    const insert = (link: string, key: string) =>
      admin.query(
        `insert into public.notifications (user_id, community_id, kind, title, body, deep_link, related_session_id, dedupe_key)
         values ($1, $2, 'event_post', 't', 'b', $3, $4, $5)`,
        [w.memberIds[0], w.communityId, link, uuid, key],
      );
    for (const [i, link] of ['/activity', `/trainings/${uuid}`, `/announcements/${uuid}`, `/events/${uuid}/feed`].entries()) {
      await insert(link, `ok:${i}`);
    }
    const bad = [
      `/events/${uuid}`, `/events/${uuid}/feed/`, `/events/${uuid}/feed?x=1`, `/events/${uuid.toUpperCase()}/feed`,
      `/events/${uuid}/log`, `/events//feed`, `/events/${uuid.slice(0, -1)}/feed`, `//events/${uuid}/feed`,
      `https://evil.example/events/${uuid}/feed`, `/events/${uuid}/feed\n`,
    ];
    for (const [i, link] of bad.entries()) {
      await expect(insert(link, `bad:${i}`), JSON.stringify(link)).rejects.toMatchObject({ code: '23514' });
    }
    const { rows } = await admin.query<{ convalidated: boolean }>(
      "select convalidated from pg_constraint where conname = 'notifications_deep_link_check'",
    );
    expect(rows).toEqual([{ convalidated: true }]);
  });

  it('rate limit: 5 posts per organizer per event per rolling hour; the 6th is refused (rate_limited), nothing written', async () => {
    const w = await world();
    await setRsvp(w.memberIds[0], w.event.id, 'going');
    const second = await addMember(w.communityId, { role: 'organizer', name: 'Sam Second' });
    const otherEvent = await createTraining(w.organizerId, w.communityId);

    const posts = [];
    for (let i = 0; i < 5; i += 1) posts.push(await createPost(w.organizerId, w.event.id, `Update ${i}`));
    await expect(createPost(w.organizerId, w.event.id, 'Update 5')).rejects.toMatchObject(raised('rate_limited'));
    expect(await countRows('event_posts', 'session_id = $1', [w.event.id])).toBe(5);
    expect(await countRows('notifications', "kind = 'event_post'")).toBe(5);
    expect(await feedJobs()).toHaveLength(5);

    // Replies do not count, and members' replies are not limited.
    for (let i = 0; i < 6; i += 1) await replyTo(w.organizerId, posts[0].id, `Reply ${i}`);
    // The limit is per organizer and per event.
    await createPost(second, w.event.id);
    await createPost(w.organizerId, otherEvent.id);

    // Deleting a post does not give its slot back.
    await deletePost(w.organizerId, posts[0].id);
    await expect(createPost(w.organizerId, w.event.id)).rejects.toMatchObject(raised('rate_limited'));

    // Rolling hour: once a post is older than an hour, one more is allowed.
    await agePost(posts[1].id, 61);
    await createPost(w.organizerId, w.event.id, 'One more');
    await expect(createPost(w.organizerId, w.event.id)).rejects.toMatchObject(raised('rate_limited'));
  });

  it('the rate limit is exact under concurrency', async () => {
    const w = await world();
    await setRsvp(w.memberIds[0], w.event.id, 'going');
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createPost(w.organizerId, w.event.id, `Parallel ${i}`).then(() => 'ok', errorKey),
      ),
    );
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(5);
    expect(outcomes.filter((o) => o === 'P0001:rate_limited')).toHaveLength(5);
    expect(await countRows('event_posts')).toBe(5);
    expect(await feedJobs()).toHaveLength(5);
  });

  it('push preferences and push consent apply at send time, like every other kind', async () => {
    const w = await world();
    const [a, b, c] = w.memberIds;
    for (const userId of [a, b, c]) await setRsvp(userId, w.event.id, 'going');
    await registerToken(a, 'ExponentPushToken[feed-a]');
    await registerToken(b, 'ExponentPushToken[feed-b]');
    // b turned event updates off; c never consented to push.
    await asUser(b, (db) => db.query('select public.set_notification_preferences(null, null, null, false)'));
    await createPost(w.organizerId, w.event.id);
    const claimed = (await claimJobs('feed-test')).filter((j) => j.kind === 'event_post');
    const byUser = Object.fromEntries(claimed.map((j) => [j.user_id, j]));
    expect(byUser[a]).toMatchObject({ kind: 'event_post', push_allowed: true, tokens: ['ExponentPushToken[feed-a]'] });
    expect(byUser[b]).toMatchObject({ push_allowed: false, skip_reason: 'category_disabled', tokens: [] });
    expect(byUser[c]).toMatchObject({ push_allowed: false, skip_reason: 'no_push_consent', tokens: [] });
  });
});

describe('read cursor and unread counts', () => {
  it('unread counts posts and replies of others after the cursor; marking read resets it and reads the notifications', async () => {
    const w = await world();
    const [m1, m2] = w.memberIds;
    await setRsvp(m1, w.event.id, 'going');
    const post = await createPost(w.organizerId, w.event.id, 'First');
    await replyTo(m2, post.id, 'Reply of m2');
    await replyTo(m1, post.id, 'Own reply');

    let feed = await eventFeed(m1, w.event.id);
    expect(feed).toMatchObject({
      session_id: w.event.id,
      community_id: w.communityId,
      is_organizer: false,
      is_open: true,
      can_post: false,
      can_reply: true,
      last_read_at: null,
      post_count: 3,
      unread_count: 2,
    });
    expect(await feedUnread(m1, w.communityId)).toEqual([
      expect.objectContaining({ session_id: w.event.id, post_count: 3, unread_count: 2 }),
    ]);

    const cursor = await markFeedRead(m1, w.event.id);
    expect(cursor.user_id).toBe(m1);
    expect(await countRows('notifications', "user_id = $1 and kind = 'event_post' and read_at is null", [m1])).toBe(0);
    // Other kinds are untouched (the training_created notification stays unread).
    expect(await countRows('notifications', "user_id = $1 and kind = 'training_created' and read_at is null", [m1])).toBe(1);
    feed = await eventFeed(m1, w.event.id);
    expect(feed.unread_count).toBe(0);
    expect(feed.last_read_at).not.toBeNull();
    expect(feed.posts[0].is_unread).toBe(false);
    expect(await feedUnread(m1, w.communityId)).toEqual([expect.objectContaining({ unread_count: 0 })]);

    await createPost(w.organizerId, w.event.id, 'Second');
    feed = await eventFeed(m1, w.event.id);
    expect(feed.unread_count).toBe(1);
    expect(feed.posts.map((p) => [p.body, p.is_unread])).toEqual([
      ['Second', true],
      ['First', false],
    ]);
    // The organizer's own posts are never unread for them; m2's and m1's replies are.
    const organizerFeed = await eventFeed(w.organizerId, w.event.id);
    expect(organizerFeed).toMatchObject({ is_organizer: true, can_post: true, unread_count: 2 });

    // The cursor never moves backwards.
    await admin.query("update public.event_feed_reads set last_read_at = last_read_at + interval '1 day' where user_id = $1", [m1]);
    const future = (await admin.query('select last_read_at from public.event_feed_reads where user_id = $1', [m1])).rows[0].last_read_at;
    const again = await markFeedRead(m1, w.event.id);
    expect(again.last_read_at).toEqual(future);
  });

  it('unread per event: one row per event with visible posts, only the caller\'s community', async () => {
    const w = await world();
    const second = await createTraining(w.organizerId, w.communityId, { title: 'Second event' });
    await createTraining(w.organizerId, w.communityId, { title: 'Quiet event' });
    const p1 = await createPost(w.organizerId, w.event.id, 'A');
    await createPost(w.organizerId, second.id, 'B');
    await createPost(w.organizerId, second.id, 'C');
    await replyTo(w.memberIds[0], p1.id, 'r');
    const elsewhere = await createTraining(w.other.organizerId, w.other.communityId);
    await createPost(w.other.organizerId, elsewhere.id, 'Other community');
    await markFeedRead(w.memberIds[1], second.id);

    const rows = await feedUnread(w.memberIds[1], w.communityId);
    expect(rows.map((r) => [r.session_id, r.post_count, r.unread_count]).sort()).toEqual(
      [
        [w.event.id, 2, 2],
        [second.id, 2, 0],
      ].sort(),
    );
    expect(rows[0].session_id).toBe(w.event.id); // latest activity first (the reply)
    // The organizer of the other community gets not_a_member for this community.
    await expect(feedUnread(w.other.organizerId, w.communityId)).rejects.toMatchObject(raised('not_a_member'));
  });

  it('the feed nests replies, orders them, names authors, says what can be deleted and hides deleted posts', async () => {
    const w = await world();
    const [m1, m2] = w.memberIds;
    const p1 = await createPost(w.organizerId, w.event.id, 'Older post');
    const p2 = await createPost(w.organizerId, w.event.id, 'Newer post');
    const r1 = await replyTo(m1, p1.id, 'first reply');
    const r2 = await replyTo(m2, p1.id, 'second reply');
    const gone = await replyTo(m2, p1.id, 'deleted reply');
    await deletePost(w.organizerId, gone.id);
    const hidden = await createPost(w.organizerId, w.event.id, 'Hidden post');
    await replyTo(m1, hidden.id, 'reply to hidden');
    await deletePost(w.organizerId, hidden.id);

    const feed = await eventFeed(m2, w.event.id);
    expect(feed.post_count).toBe(4);
    expect(feed.posts.map((p) => p.id)).toEqual([p2.id, p1.id]);
    expect(feed.posts[1].replies.map((r) => r.id)).toEqual([r1.id, r2.id]);
    expect(feed.posts[1]).toMatchObject({ author_id: w.organizerId, author_name: 'Olga Organizer', author_role: 'organizer', body: 'Older post', parent_id: null, can_delete: false });
    expect(feed.posts[1].replies[0]).toMatchObject({ author_id: m1, author_name: 'Member 1', author_role: 'member', parent_id: p1.id, is_unread: true, can_delete: false });
    expect(feed.posts[1].replies[1]).toMatchObject({ is_unread: false, can_delete: true });
    expect(feed.posts[0].replies).toEqual([]);
    expect(JSON.stringify(feed)).not.toContain('Hidden post');
    expect(JSON.stringify(feed)).not.toContain('reply to hidden');
    const organizerFeed = await eventFeed(w.organizerId, w.event.id);
    expect(organizerFeed.posts.every((p) => p.can_delete && p.replies.every((r) => r.can_delete))).toBe(true);
  });

  it('outsiders and removed members cannot read or mark; unknown events are not_found', async () => {
    const w = await world();
    await createPost(w.organizerId, w.event.id, 'Members only');
    for (const userId of [w.removed, w.other.organizerId, w.other.memberIds[0]]) {
      await expect(eventFeed(userId, w.event.id)).rejects.toMatchObject(raised('not_a_member'));
      await expect(markFeedRead(userId, w.event.id)).rejects.toMatchObject(raised('not_a_member'));
      await expect(feedUnread(userId, w.communityId)).rejects.toMatchObject(raised('not_a_member'));
    }
    await expect(eventFeed(w.memberIds[0], UNKNOWN)).rejects.toMatchObject(raised('not_found'));
    await expect(markFeedRead(w.memberIds[0], UNKNOWN)).rejects.toMatchObject(raised('not_found'));
    await expect(feedUnread(w.memberIds[0], null)).rejects.toMatchObject(raised('not_a_member'));
    await expect(feedUnread(w.memberIds[0], UNKNOWN)).rejects.toMatchObject(raised('not_a_member'));
    for (const sql of [
      'select public.get_event_feed($1)',
      'select public.mark_event_feed_read($1)',
      'select public.get_event_feed_unread($1)',
    ]) {
      await expect(asAnon((db) => db.query(sql, [w.event.id])), sql).rejects.toMatchObject(denied);
    }
    expect(await countRows('event_feed_reads')).toBe(0);
  });

  it('RLS: members of the community read posts; others see nothing; read cursors are private; tables are select-only', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id);
    await replyTo(w.memberIds[0], post.id);
    await markFeedRead(w.memberIds[0], w.event.id);
    await markFeedRead(w.memberIds[1], w.event.id);
    const count = (userId: string, table: string) =>
      asUser(userId, async (db) => (await db.query(`select count(*)::int as n from public.${table}`)).rows[0].n as number);
    expect(await count(w.memberIds[2], 'event_posts')).toBe(2);
    expect(await count(w.removed, 'event_posts')).toBe(0);
    expect(await count(w.other.organizerId, 'event_posts')).toBe(0);
    expect(await count(w.memberIds[0], 'event_feed_reads')).toBe(1);
    expect(await count(w.organizerId, 'event_feed_reads')).toBe(0);
    await expect(
      asAnon((db) => db.query('select count(*) from public.event_posts')),
    ).rejects.toMatchObject(denied);
    for (const sql of [
      "update public.event_posts set body = 'hijack' where id = $1",
      'delete from public.event_posts where id = $1',
      "insert into public.event_posts (id, session_id, community_id, body) select gen_random_uuid(), session_id, community_id, 'x' from public.event_posts where id = $1",
    ]) {
      await expect(asUser(w.organizerId, (db) => db.query(sql, [post.id])), sql).rejects.toMatchObject(denied);
    }
    await expect(
      asUser(w.memberIds[0], (db) =>
        db.query(
          'insert into public.event_feed_reads (session_id, user_id, last_read_at) values ($1, $2, now())',
          [w.event.id, w.memberIds[2]],
        ),
      ),
    ).rejects.toMatchObject(denied);
  });

  it('moving the cursor waits for a post still being written; a post started after the cursor is unread', async () => {
    const w = await world();
    const [m1] = w.memberIds;
    await asUser(w.organizerId, async (db) => {
      await db.query('begin');
      await db.query('select public.create_event_post($1, $2)', [w.event.id, 'In flight']);
      const mark = markFeedRead(m1, w.event.id);
      await waitForBlocked('mark_event_feed_read');
      await db.query('commit');
      await mark;
    });
    expect((await eventFeed(m1, w.event.id)).unread_count).toBe(0);
    await asUser(m1, async (db) => {
      await db.query('begin');
      await db.query('select public.mark_event_feed_read($1)', [w.event.id]);
      const post = createPost(w.organizerId, w.event.id, 'After');
      await waitForBlocked('create_event_post');
      await db.query('commit');
      await post;
    });
    expect((await eventFeed(m1, w.event.id)).unread_count).toBe(1);
  });

  it('posts and cursor moves at once: no lock errors, and the unread count matches the stored cursor', async () => {
    const w = await world();
    const second = await addMember(w.communityId, { role: 'organizer', name: 'Sam Second' });
    const [m1] = w.memberIds;
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i += 1) {
      ops.push(createPost(i % 2 === 0 ? w.organizerId : second, w.event.id, `Storm ${i}`));
      ops.push(markFeedRead(m1, w.event.id));
    }
    await Promise.all(ops);
    const { rows } = await admin.query<{ unread: number }>(
      `select count(*)::int as unread from public.event_posts p, public.event_feed_reads r
       where r.user_id = $1 and r.session_id = p.session_id and p.created_at > r.last_read_at`,
      [m1],
    );
    expect((await eventFeed(m1, w.event.id)).unread_count).toBe(rows[0].unread);
    expect(await countRows('event_posts')).toBe(10);
  });
});

describe('GDPR', () => {
  it('the export lists the caller\'s own posts and read cursors, nothing of other members', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id, 'Organizer words');
    const reply = await replyTo(w.memberIds[0], post.id, 'Member words');
    const gone = await replyTo(w.memberIds[0], post.id, 'Removed words');
    await deletePost(w.organizerId, gone.id);
    await replyTo(w.memberIds[1], post.id, 'Someone else');
    await markFeedRead(w.memberIds[0], w.event.id);

    const ex = (await exportMyData(w.memberIds[0])) as unknown as {
      authored: { event_posts: Record<string, unknown>[] };
      event_feed_reads: Record<string, unknown>[];
      truncated: Record<string, boolean>;
    };
    expect(ex.authored.event_posts).toEqual([
      expect.objectContaining({ post_id: reply.id, session_id: w.event.id, parent_id: post.id, body: 'Member words', event_title: 'Hill repeats', deleted_at: null }),
      expect.objectContaining({ post_id: gone.id, body: null }),
    ]);
    expect(ex.event_feed_reads).toEqual([expect.objectContaining({ session_id: w.event.id, event_title: 'Hill repeats' })]);
    expect(ex.truncated).toMatchObject({ event_posts: false, event_feed_reads: false });
    const text = JSON.stringify(ex);
    expect(text).not.toContain('Organizer words');
    expect(text).not.toContain('Someone else');

    const refs = await referencesTo(w.memberIds[0]);
    expect(refs['public.event_posts.author_id']).toBe(ex.authored.event_posts.length);
    expect(refs['public.event_feed_reads.user_id']).toBe(ex.event_feed_reads.length);

    const organizerExport = (await exportMyData(w.organizerId)) as unknown as { authored: { event_posts: { body: string }[] } };
    expect(organizerExport.authored.event_posts.map((p) => p.body)).toEqual(['Organizer words']);
  });

  it('account deletion: replies go (with the notifications quoting them), top-level posts stay without author', async () => {
    const w = await world();
    const victimOrganizer = await addMember(w.communityId, { role: 'organizer', name: 'Vera Victim' });
    const [m1, m2] = w.memberIds;
    await setRsvp(m1, w.event.id, 'going');
    const victimPost = await createPost(victimOrganizer, w.event.id, 'Victim post');
    const otherReply = await replyTo(m1, victimPost.id, 'Reply to victim');
    const organizerPost = await createPost(w.organizerId, w.event.id, 'Organizer post');
    const victimReply = await replyTo(victimOrganizer, organizerPost.id, 'Victim reply');
    await markFeedRead(victimOrganizer, w.event.id);
    expect(await countRows('notifications', 'dedupe_key = $1', [`event_reply:${victimReply.id}`])).toBe(1);

    await deleteMyAccount(victimOrganizer);

    expect(await referencesTo(victimOrganizer)).toEqual({});
    expect(await storedPost(victimReply.id)).toBeUndefined();
    expect(await countRows('notifications', 'dedupe_key = $1', [`event_reply:${victimReply.id}`])).toBe(0);
    expect(await storedPost(victimPost.id)).toMatchObject({ author_id: null, body: 'Victim post' });
    expect(await storedPost(otherReply.id)).toMatchObject({ author_id: m1, body: 'Reply to victim' });
    expect(await countRows('event_feed_reads')).toBe(0);
    // Other members' notifications about the kept post stay.
    expect(await countRows('notifications', 'dedupe_key = $1', [`event_post:${victimPost.id}`])).toBe(1);

    const feed = await eventFeed(m2, w.event.id);
    const kept = feed.posts.find((p) => p.id === victimPost.id);
    expect(kept).toMatchObject({ author_id: null, author_name: null, author_role: null });
    expect(kept?.replies.map((r) => r.id)).toEqual([otherReply.id]);
    expect(feed.posts.find((p) => p.id === organizerPost.id)?.replies).toEqual([]);
  });

  it('leaving / removal keeps the member\'s replies (history), as for announcements and attendance', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id);
    const reply = await replyTo(w.memberIds[0], post.id, 'Kept');
    await asUser(w.memberIds[0], (db) => db.query('select public.leave_community($1)', [w.communityId]));
    expect(await storedPost(reply.id)).toMatchObject({ author_id: w.memberIds[0], body: 'Kept', deleted_at: null });
    const feed = await eventFeed(w.memberIds[1], w.event.id);
    expect(feed.posts[0].replies[0]).toMatchObject({ id: reply.id, author_name: 'Member 1', author_role: null });
  });

  it('a deleted account\'s still-valid token gets only the functions\' own errors', async () => {
    const w = await world();
    const victim = w.memberIds[0];
    const post = await createPost(w.organizerId, w.event.id);
    await deleteMyAccount(victim);
    const calls: [string, unknown[]][] = [
      ['select public.create_event_post($1, $2)', [w.event.id, 'Ghost']],
      ['select public.reply_to_event_post($1, $2)', [post.id, 'Ghost']],
      ['select public.delete_event_post($1)', [post.id]],
      ['select public.mark_event_feed_read($1)', [w.event.id]],
      ['select public.get_event_feed($1)', [w.event.id]],
      ['select public.get_event_feed_unread($1)', [w.communityId]],
    ];
    const outcomes = [];
    for (const [sql, params] of calls) {
      outcomes.push(await asUser(victim, (db) => db.query(sql, params)).then(() => 'ok', errorKey));
    }
    expect(outcomes).toEqual([
      'P0001:forbidden',
      'P0001:not_a_member',
      'P0001:forbidden',
      'P0001:not_a_member',
      'P0001:not_a_member',
      'P0001:not_a_member',
    ]);
    expect(await referencesTo(victim)).toEqual({});
  });
});

describe('schema', () => {
  it('event_posts is published to Realtime with RLS on; read cursors are not published', async () => {
    const { rows } = await admin.query<{ tablename: string }>(
      "select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'",
    );
    const tables = rows.map((r) => r.tablename);
    expect(tables).toContain('event_posts');
    expect(tables).not.toContain('event_feed_reads');
    const { rows: rls } = await admin.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
       where oid in ('public.event_posts'::regclass, 'public.event_feed_reads'::regclass) order by relname`,
    );
    expect(rls).toEqual([
      { relname: 'event_feed_reads', relrowsecurity: true },
      { relname: 'event_posts', relrowsecurity: true },
    ]);
  });

  it('the notification kinds exist', async () => {
    const { rows } = await admin.query<{ v: string }>(
      "select unnest(enum_range(null::public.notification_kind))::text as v",
    );
    expect(rows.map((r) => r.v)).toEqual(expect.arrayContaining(['event_post', 'event_reply']));
  });

  it('the body check refuses an empty or oversized body and a deleted post with text', async () => {
    const w = await world();
    const post = await createPost(w.organizerId, w.event.id);
    for (const sql of [
      "update public.event_posts set body = '' where id = $1",
      "update public.event_posts set body = repeat('x', 1001) where id = $1",
      'update public.event_posts set deleted_at = now() where id = $1',
      'update public.event_posts set body = null where id = $1',
    ]) {
      await expect(admin.query(sql, [post.id]), sql).rejects.toMatchObject({ code: '23514' });
    }
  });
});
