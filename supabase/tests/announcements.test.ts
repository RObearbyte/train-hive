import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addMember,
  admin,
  asAnon,
  asUser,
  closeDb,
  countRows,
  createPack,
  hoursFromNow,
  resetData,
  rpc,
  rpcRow,
} from './helpers';
import {
  type Announcement,
  cancelAnnouncement,
  createAnnouncement,
  makeAnnouncementDue,
  publishDue,
  recipients,
  sorted,
  updateAnnouncement,
} from './notifications-helpers';
import { errorKey, raised, waitForBlocked } from './qa-helpers';

beforeEach(resetData);
afterAll(closeDb);

describe('create_announcement', () => {
  it('publishes immediately when no time is given, and notifies every other active member', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const second = await addMember(communityId, { role: 'organizer', name: 'Second Organizer' });
    await addMember(communityId, { status: 'removed', name: 'Gone Member' });
    const other = await createPack(1);

    const a = await createAnnouncement(organizerId, communityId, { title: '  Club   news ', body: '\n Body text \n' });
    expect(a).toMatchObject({ status: 'published', author_id: organizerId, title: 'Club news', body: 'Body text', scheduled_for: null });
    expect(a.published_at).toBeInstanceOf(Date);

    // Not the author, not the removed member, not the other community.
    expect(await recipients('announcement_published', a.id)).toEqual(sorted([...memberIds, second]));
    const [n] = await admin.query('select * from public.notifications where user_id = $1', [memberIds[0]]).then((r) => r.rows);
    expect(n).toMatchObject({
      kind: 'announcement_published',
      title: 'Club news',
      body: 'Body text',
      deep_link: `/announcements/${a.id}`,
      dedupe_key: `announcement:${a.id}`,
      related_session_id: null,
      read_at: null,
    });
    expect(await countRows('notifications', 'community_id = $1', [other.communityId])).toBe(0);
    // One push job per notification.
    expect(await countRows('notification_delivery_jobs', "status = 'pending'")).toBe(3);
  });

  it('schedules for a future time without publishing or notifying', async () => {
    const { communityId, organizerId } = await createPack(2);
    const a = await createAnnouncement(organizerId, communityId, { scheduledFor: hoursFromNow(2) });
    expect(a).toMatchObject({ status: 'scheduled', published_at: null });
    expect(await countRows('notifications')).toBe(0);
  });

  it('only active organizers of the community may create', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const removedOrganizer = await addMember(communityId, { role: 'organizer', status: 'removed', name: 'Gone Organizer' });
    const other = await createPack();
    for (const user of [memberIds[0], removedOrganizer, other.organizerId]) {
      await expect(createAnnouncement(user, communityId)).rejects.toMatchObject(raised('forbidden'));
    }
    await expect(
      asUser(organizerId, (db) => rpcRow(db, 'create_announcement', ['00000000-0000-0000-0000-000000000000', 't', 'b', null])),
    ).rejects.toMatchObject(raised('forbidden'));
    await expect(
      asUser('00000000-0000-0000-0000-000000000001', (db) => rpcRow(db, 'create_announcement', [communityId, 't', 'b', null])),
    ).rejects.toMatchObject(raised('forbidden'));
    await expect(asAnon((db) => rpcRow(db, 'create_announcement', [communityId, 't', 'b', null]))).rejects.toMatchObject({ code: '42501' });
    expect(await countRows('announcements')).toBe(0);
  });

  it('validates title (1-100, single line), body (1-2000) and the scheduled time', async () => {
    const { communityId, organizerId } = await createPack();
    const cases: [Record<string, unknown>, string][] = [
      [{ title: '   ' }, 'validation_failed:title'],
      [{ title: null }, 'validation_failed:title'],
      [{ title: 'x'.repeat(101) }, 'validation_failed:title'],
      [{ body: ' \n ' }, 'validation_failed:body'],
      [{ body: 'x'.repeat(2001) }, 'validation_failed:body'],
      [{ scheduledFor: hoursFromNow(-1) }, 'validation_failed:scheduled_for'],
      [{ scheduledFor: new Date(Date.now() - 1000).toISOString() }, 'validation_failed:scheduled_for'],
      [{ scheduledFor: hoursFromNow(24 * 366) }, 'validation_failed:scheduled_for'],
    ];
    for (const [options, expected] of cases) {
      await expect(createAnnouncement(organizerId, communityId, options as never), expected).rejects.toMatchObject(raised(expected));
    }
    expect(await countRows('announcements')).toBe(0);
    // Boundaries accepted.
    const ok = await createAnnouncement(organizerId, communityId, { title: 'x'.repeat(100), body: 'y'.repeat(2000) });
    expect(ok.status).toBe('published');
  });

  it('a removed organizer waiting on the membership lock is refused', async () => {
    const { communityId, organizerId } = await createPack();
    const gate = await admin.connect();
    let result: Promise<string>;
    try {
      await gate.query('begin');
      await gate.query("update public.memberships set status = 'removed' where user_id = $1", [organizerId]);
      result = createAnnouncement(organizerId, communityId).then(() => 'ok', errorKey);
      await waitForBlocked('create_announcement');
      await gate.query('commit');
    } finally {
      await gate.query('rollback');
      gate.release();
    }
    expect(await result).toBe('P0001:forbidden');
    expect(await countRows('announcements')).toBe(0);
  });
});

describe('update_announcement / cancel_announcement', () => {
  it('edits a scheduled announcement; null time publishes it now', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const a = await createAnnouncement(organizerId, communityId, { scheduledFor: hoursFromNow(2) });
    const later = hoursFromNow(5);
    const edited = await updateAnnouncement(organizerId, a.id, 'New title', 'New body', later);
    expect(edited).toMatchObject({ status: 'scheduled', title: 'New title', body: 'New body' });
    expect(edited.scheduled_for?.toISOString()).toBe(later);
    expect(await countRows('notifications')).toBe(0);

    const published = await updateAnnouncement(organizerId, a.id, 'Now', 'Right now', null);
    expect(published.status).toBe('published');
    expect(published.published_at).toBeInstanceOf(Date);
    expect(published.scheduled_for?.toISOString()).toBe(later);
    expect(await recipients('announcement_published', a.id)).toEqual(memberIds);
  });

  it('refuses edits and cancellation of published announcements; cancel is idempotent', async () => {
    const { communityId, organizerId } = await createPack(1);
    const published = await createAnnouncement(organizerId, communityId);
    await expect(updateAnnouncement(organizerId, published.id, 't', 'b', hoursFromNow(1))).rejects.toMatchObject(raised('announcement_not_editable'));
    await expect(cancelAnnouncement(organizerId, published.id)).rejects.toMatchObject(raised('announcement_not_cancellable'));

    const scheduled = await createAnnouncement(organizerId, communityId, { scheduledFor: hoursFromNow(1) });
    const cancelled = await cancelAnnouncement(organizerId, scheduled.id);
    expect(cancelled.status).toBe('cancelled');
    const again = await cancelAnnouncement(organizerId, scheduled.id);
    expect(again.cancelled_at).toEqual(cancelled.cancelled_at);
    await expect(updateAnnouncement(organizerId, scheduled.id, 't', 'b', hoursFromNow(1))).rejects.toMatchObject(raised('announcement_not_editable'));

    // A cancelled announcement is never published.
    await makeAnnouncementDue(scheduled.id);
    expect(await publishDue()).toBe(0);
    expect(await recipients('announcement_published', scheduled.id)).toEqual([]);
  });

  it('only organizers of the community; unknown ids are not_found', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const other = await createPack();
    const a = await createAnnouncement(organizerId, communityId, { scheduledFor: hoursFromNow(1) });
    for (const user of [memberIds[0], other.organizerId]) {
      await expect(updateAnnouncement(user, a.id, 't', 'b', hoursFromNow(2))).rejects.toMatchObject(raised('forbidden'));
      await expect(cancelAnnouncement(user, a.id)).rejects.toMatchObject(raised('forbidden'));
    }
    const missing = '00000000-0000-0000-0000-000000000000';
    await expect(updateAnnouncement(organizerId, missing, 't', 'b', null)).rejects.toMatchObject(raised('not_found'));
    await expect(cancelAnnouncement(organizerId, missing)).rejects.toMatchObject(raised('not_found'));
    await expect(updateAnnouncement(organizerId, a.id, ' ', 'b', hoursFromNow(2))).rejects.toMatchObject(raised('validation_failed:title'));
    await expect(updateAnnouncement(organizerId, a.id, 't', 'b', hoursFromNow(-1))).rejects.toMatchObject(raised('validation_failed:scheduled_for'));
    expect((await admin.query('select status, title from public.announcements')).rows).toEqual([{ status: 'scheduled', title: 'Club news' }]);
  });

  it('an organizer demoted while waiting for the row lock is refused', async () => {
    const { communityId, organizerId } = await createPack();
    const a = await createAnnouncement(organizerId, communityId, { scheduledFor: hoursFromNow(1) });
    const gate = await admin.connect();
    let result: Promise<string>;
    try {
      await gate.query('begin');
      await gate.query('select 1 from public.announcements where id = $1 for update', [a.id]);
      result = cancelAnnouncement(organizerId, a.id).then(() => 'ok', errorKey);
      await waitForBlocked('cancel_announcement');
      await gate.query("update public.memberships set role = 'member' where user_id = $1", [organizerId]);
      await gate.query('commit');
    } finally {
      await gate.query('rollback');
      gate.release();
    }
    expect(await result).toBe('P0001:forbidden');
    expect((await admin.query('select status from public.announcements')).rows[0].status).toBe('scheduled');
  });
});

describe('publish_due_announcements', () => {
  it('publishes at the due time, not before, and exactly once', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const a = await createAnnouncement(organizerId, communityId, { scheduledFor: new Date(Date.now() + 1500).toISOString() });
    expect(await publishDue()).toBe(0);
    expect(await countRows('notifications')).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(await publishDue()).toBe(1);
    expect(await publishDue()).toBe(0);
    const stored = (await admin.query<Announcement>('select * from public.announcements where id = $1', [a.id])).rows[0];
    expect(stored.status).toBe('published');
    expect(stored.published_at!.getTime()).toBeGreaterThanOrEqual(stored.scheduled_for!.getTime());
    expect(await recipients('announcement_published', a.id)).toEqual(sorted(memberIds));
    expect(await countRows('notification_delivery_jobs')).toBe(2);
  });

  it('concurrent runs publish each due announcement once and notify each member once', async () => {
    const { communityId, organizerId, memberIds } = await createPack(5);
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const a = await createAnnouncement(organizerId, communityId, { title: `News ${i}`, scheduledFor: hoursFromNow(1) });
      await makeAnnouncementDue(a.id);
      ids.push(a.id);
    }
    const counts = await Promise.all(Array.from({ length: 8 }, () => publishDue()));
    expect(counts.reduce((x, y) => x + y, 0)).toBe(6);
    expect(await countRows('notifications')).toBe(6 * memberIds.length);
    expect(await countRows('notification_delivery_jobs')).toBe(6 * memberIds.length);
    expect(await countRows('announcements', "status = 'published'")).toBe(6);
  });

  it('organizer cancel racing the publisher: exactly one of them wins, in both orders', async () => {
    // Cancel holds the row: the publisher skips it, the announcement stays cancelled.
    {
      const { communityId, organizerId } = await createPack(1);
      const a = await createAnnouncement(organizerId, communityId, { scheduledFor: hoursFromNow(1) });
      await makeAnnouncementDue(a.id);
      const results = await Promise.all([
        cancelAnnouncement(organizerId, a.id).then((r) => r.status, errorKey),
        publishDue().then(String, errorKey),
      ]);
      const stored = (await admin.query('select status from public.announcements where id = $1', [a.id])).rows[0].status;
      if (stored === 'cancelled') {
        expect(results[0]).toBe('cancelled');
        expect(await countRows('notifications')).toBe(0);
      } else {
        expect(stored).toBe('published');
        expect(results).toEqual(['P0001:announcement_not_cancellable', '1']);
        expect(await countRows('notifications')).toBe(1);
      }
      await resetData();
    }
    // Deterministic: the publisher holds the row lock first, the cancel waits and then refuses.
    {
      const { communityId, organizerId } = await createPack(1);
      const a = await createAnnouncement(organizerId, communityId, { scheduledFor: hoursFromNow(1) });
      await makeAnnouncementDue(a.id);
      const gate = await admin.connect();
      let cancel: Promise<string>;
      try {
        await gate.query('begin');
        await gate.query('select public.publish_due_announcements()');
        cancel = cancelAnnouncement(organizerId, a.id).then((r) => r.status, errorKey);
        await waitForBlocked('cancel_announcement');
        await gate.query('commit');
      } finally {
        await gate.query('rollback');
        gate.release();
      }
      expect(await cancel).toBe('P0001:announcement_not_cancellable');
      expect(await countRows('notifications')).toBe(1);
    }
    // Deterministic: the cancel holds the row lock; the publisher skips it and publishes nothing.
    {
      await resetData();
      const { communityId, organizerId } = await createPack(1);
      const a = await createAnnouncement(organizerId, communityId, { scheduledFor: hoursFromNow(1) });
      await makeAnnouncementDue(a.id);
      const gate = await admin.connect();
      try {
        await gate.query('begin');
        await gate.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: organizerId, role: 'authenticated' })]);
        await gate.query('select public.cancel_announcement($1)', [a.id]);
        expect(await publishDue()).toBe(0);
        await gate.query('commit');
      } finally {
        await gate.query('rollback');
        gate.release();
      }
      expect(await publishDue()).toBe(0);
      expect((await admin.query('select status from public.announcements')).rows[0].status).toBe('cancelled');
      expect(await countRows('notifications')).toBe(0);
    }
  });

  it('is service_role only', async () => {
    const { organizerId } = await createPack();
    await expect(asUser(organizerId, (db) => rpc(db, 'publish_due_announcements'))).rejects.toMatchObject({ code: '42501' });
    await expect(asAnon((db) => rpc(db, 'publish_due_announcements'))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('announcement visibility (RLS)', () => {
  it('members see published ones of their community; organizers also scheduled and cancelled', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const other = await createPack(1);
    const removed = await addMember(communityId, { status: 'removed', name: 'Gone Member' });
    const published = await createAnnouncement(organizerId, communityId, { title: 'Published' });
    await createAnnouncement(organizerId, communityId, { title: 'Scheduled', scheduledFor: hoursFromNow(1) });
    const toCancel = await createAnnouncement(organizerId, communityId, { title: 'Cancelled', scheduledFor: hoursFromNow(1) });
    await cancelAnnouncement(organizerId, toCancel.id);
    await createAnnouncement(other.organizerId, other.communityId, { title: 'Elsewhere' });

    const titles = (user: string) =>
      asUser(user, (db) => db.query<{ title: string }>('select title from public.announcements order by title')).then((r) => r.rows.map((x) => x.title));
    expect(await titles(memberIds[0])).toEqual(['Published']);
    expect(await titles(organizerId)).toEqual(['Cancelled', 'Published', 'Scheduled']);
    expect(await titles(removed)).toEqual([]);
    expect(await titles(other.memberIds[0])).toEqual(['Elsewhere']);
    expect(published.id).toBeTruthy();
  });

  it('clients cannot write announcements or read state directly', async () => {
    const { communityId, organizerId } = await createPack();
    const a = await createAnnouncement(organizerId, communityId);
    const attempts: [string, unknown[]][] = [
      ["insert into public.announcements (community_id, title, body, status, published_at) values ($1, 't', 'b', 'published', now())", [communityId]],
      ["update public.announcements set title = 'x' where id = $1", [a.id]],
      ['delete from public.announcements where id = $1', [a.id]],
      ['insert into public.announcement_reads (announcement_id, user_id) values ($1, $2)', [a.id, organizerId]],
    ];
    for (const [sql, params] of attempts) {
      await expect(asUser(organizerId, (db) => db.query(sql, params)), sql).rejects.toMatchObject({ code: '42501' });
    }
  });
});

describe('read state', () => {
  it('per user: mark one, mark all, unread count, and the notification follows', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const [a1, a2, a3] = [
      await createAnnouncement(organizerId, communityId, { title: 'One' }),
      await createAnnouncement(organizerId, communityId, { title: 'Two' }),
      await createAnnouncement(organizerId, communityId, { title: 'Three' }),
    ];
    await createAnnouncement(organizerId, communityId, { title: 'Later', scheduledFor: hoursFromNow(1) });
    const unread = (user: string) => asUser(user, (db) => rpc<number>(db, 'unread_announcement_count', [communityId]));

    expect(await unread(memberIds[0])).toBe(3);
    // The author has nothing unread.
    expect(await unread(organizerId)).toBe(0);

    const first = await asUser(memberIds[0], (db) => rpcRow<{ read_at: Date }>(db, 'mark_announcement_read', [a1.id]));
    const repeat = await asUser(memberIds[0], (db) => rpcRow<{ read_at: Date }>(db, 'mark_announcement_read', [a1.id]));
    expect(repeat.read_at).toEqual(first.read_at);
    expect(await unread(memberIds[0])).toBe(2);
    expect(await unread(memberIds[1])).toBe(3);
    const n1 = (await admin.query('select read_at from public.notifications where user_id = $1 and related_announcement_id = $2', [memberIds[0], a1.id])).rows[0];
    expect(n1.read_at).toBeInstanceOf(Date);

    expect(await asUser(memberIds[0], (db) => rpc<number>(db, 'mark_announcements_read', [communityId]))).toBe(2);
    expect(await asUser(memberIds[0], (db) => rpc<number>(db, 'mark_announcements_read', [communityId]))).toBe(0);
    expect(await unread(memberIds[0])).toBe(0);
    expect(await countRows('notifications', 'user_id = $1 and read_at is null', [memberIds[0]])).toBe(0);
    expect(await countRows('notifications', 'user_id = $1 and read_at is null', [memberIds[1]])).toBe(3);

    // Members see only their own read rows.
    const own = await asUser(memberIds[1], (db) => db.query('select * from public.announcement_reads'));
    expect(own.rows).toEqual([]);
    const mine = await asUser(memberIds[0], (db) => db.query<{ announcement_id: string }>('select announcement_id from public.announcement_reads order by announcement_id'));
    expect(mine.rows.map((r) => r.announcement_id)).toEqual(sorted([a1.id, a2.id, a3.id]));
  });

  it('scheduled, cancelled or foreign announcements cannot be marked; outsiders get not_a_member', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const other = await createPack(1);
    const scheduled = await createAnnouncement(organizerId, communityId, { scheduledFor: hoursFromNow(1) });
    const published = await createAnnouncement(organizerId, communityId);
    await expect(asUser(memberIds[0], (db) => rpcRow(db, 'mark_announcement_read', [scheduled.id]))).rejects.toMatchObject(raised('not_found'));
    await expect(asUser(other.memberIds[0], (db) => rpcRow(db, 'mark_announcement_read', [published.id]))).rejects.toMatchObject(raised('not_found'));
    await expect(asUser(other.memberIds[0], (db) => rpc(db, 'mark_announcements_read', [communityId]))).rejects.toMatchObject(raised('not_a_member'));
    await expect(asUser(other.memberIds[0], (db) => rpc(db, 'unread_announcement_count', [communityId]))).rejects.toMatchObject(raised('not_a_member'));
    await expect(asAnon((db) => rpc(db, 'unread_announcement_count', [communityId]))).rejects.toMatchObject({ code: '42501' });
    expect(await countRows('announcement_reads')).toBe(0);
  });
});
