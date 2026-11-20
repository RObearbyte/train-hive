import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addMember,
  admin,
  asAnon,
  asUser,
  cancelTraining,
  closeDb,
  countRows,
  createPack,
  createTraining,
  finalize,
  hoursFromNow,
  makeDue,
  resetData,
  rpc,
  rpcRow,
  setRsvp,
  updateTraining,
} from './helpers';
import {
  type NotificationRow,
  createAnnouncement,
  enqueueReminders,
  jobs,
  notifications,
  recipients,
  sorted,
} from './notifications-helpers';
import { formOf, raised } from './qa-helpers';

beforeEach(resetData);
afterAll(closeDb);

/** A pack with an organizer, a second organizer, `n` members, a removed member and an outsider. */
async function pack(n = 4) {
  const p = await createPack(n);
  const secondOrganizer = await addMember(p.communityId, { role: 'organizer', name: 'Second Organizer' });
  const removed = await addMember(p.communityId, { status: 'removed', name: 'Gone Member' });
  const other = await createPack(1);
  return { ...p, secondOrganizer, removed, outsider: other.memberIds[0], otherCommunity: other.communityId };
}

describe('training notifications: recipients', () => {
  it('created: every active member except the creator, once, with a deep link', async () => {
    const p = await pack();
    const session = await createTraining(p.organizerId, p.communityId, { title: 'Hill repeats' });
    expect(await recipients('training_created', session.id)).toEqual(sorted([...p.memberIds, p.secondOrganizer]));
    const [n] = await notifications('user_id = $1', [p.memberIds[0]]);
    expect(n).toMatchObject({
      kind: 'training_created',
      title: 'New training: Hill repeats',
      deep_link: `/trainings/${session.id}`,
      related_session_id: session.id,
      related_announcement_id: null,
      dedupe_key: `training_created:${session.id}`,
      community_id: p.communityId,
    });
    expect(n.body).toContain('Herastrau Park');
    expect(await countRows('notifications', 'community_id = $1', [p.otherCommunity])).toBe(0);
    expect((await jobs()).map((j) => j.status)).toEqual(Array(5).fill('pending'));
  });

  it('RSVP changes never notify anyone', async () => {
    const p = await pack();
    const session = await createTraining(p.organizerId, p.communityId);
    const before = await countRows('notifications');
    await setRsvp(p.memberIds[0], session.id, 'going');
    await setRsvp(p.memberIds[1], session.id, 'not_going');
    await setRsvp(p.memberIds[0], session.id, 'no_response');
    await setRsvp(p.memberIds[2], session.id, 'going');
    // Removal releases an RSVP (going_count update) and must not notify either.
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [p.memberIds[2]]);
    expect(await countRows('notifications')).toBe(before);
    expect(await countRows('notification_delivery_jobs')).toBe(before);
  });

  it('material update: everyone except the editor and members who said not_going; description-only edits are silent', async () => {
    const p = await pack();
    const session = await createTraining(p.organizerId, p.communityId);
    await setRsvp(p.memberIds[0], session.id, 'going');
    await setRsvp(p.memberIds[1], session.id, 'not_going');

    await updateTraining(p.secondOrganizer, session.id, formOf(session, { description: 'Bring water.', meeting_instructions: 'North gate.', map_url: null, activity_type: 'trail_running' }));
    expect(await recipients('training_updated', session.id)).toEqual([]);
    // An identical resend changes nothing and notifies nobody.
    await updateTraining(p.secondOrganizer, session.id, formOf(session, { description: 'Bring water.', meeting_instructions: 'North gate.', map_url: null, activity_type: 'trail_running' }));
    expect(await recipients('training_updated', session.id)).toEqual([]);

    const moved = await updateTraining(p.secondOrganizer, session.id, formOf(session, { location_name: 'Tineretului Park' }));
    const expected = sorted([p.organizerId, p.memberIds[0], p.memberIds[2], p.memberIds[3]]);
    expect(await recipients('training_updated', session.id)).toEqual(expected);
    const [n] = await notifications("kind = 'training_updated' and user_id = $1", [p.memberIds[0]]);
    expect(n.body).toMatch(/^New location\. .* · Tineretului Park$/);

    // A second, different material edit notifies again (new dedupe key); each edit once.
    await updateTraining(p.secondOrganizer, session.id, formOf(moved, { starts_at: hoursFromNow(80), ends_at: hoursFromNow(81) }));
    const rows = await notifications("kind = 'training_updated' and user_id = $1", [p.memberIds[0]]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.dedupe_key)).size).toBe(2);
    expect(rows[1].body).toMatch(/^New time\./);
    expect(await countRows('notifications', "kind = 'training_updated'")).toBe(8);
    // Title, address and coordinates are material too.
    for (const change of [{ title: 'Renamed' }, { address: 'Side gate' }, { latitude: 44.5, longitude: 26.1 }]) {
      const current = await admin.query('select * from public.training_sessions where id = $1', [session.id]).then((r) => r.rows[0]);
      const before = await countRows('notifications', "kind = 'training_updated'");
      await updateTraining(p.secondOrganizer, session.id, formOf(current, change));
      expect(await countRows('notifications', "kind = 'training_updated'"), JSON.stringify(change)).toBe(before + 4);
    }
  });

  it('confirmed by the finalizer: going members and the session organizer, exactly once across re-runs', async () => {
    const p = await pack();
    const session = await createTraining(p.organizerId, p.communityId, { min_participants: 2 });
    await setRsvp(p.memberIds[0], session.id, 'going');
    await setRsvp(p.memberIds[1], session.id, 'going');
    await setRsvp(p.memberIds[2], session.id, 'not_going');
    await makeDue(session.id);
    expect(await finalize()).toBe(1);
    expect(await finalize()).toBe(0);
    expect(await recipients('training_confirmed', session.id)).toEqual(sorted([p.organizerId, p.memberIds[0], p.memberIds[1]]));
    const [n] = await notifications("kind = 'training_confirmed' and user_id = $1", [p.memberIds[0]]);
    expect(n.dedupe_key).toBe(`training_confirmed:${session.id}`);
    expect(n.title).toBe('Training confirmed: Morning run');
  });

  it('cancelled by the finalizer: everyone except not_going (organizer included), exactly once', async () => {
    const p = await pack();
    const session = await createTraining(p.organizerId, p.communityId, { min_participants: 3 });
    await setRsvp(p.memberIds[0], session.id, 'going');
    await setRsvp(p.memberIds[1], session.id, 'not_going');
    await makeDue(session.id);
    await Promise.all([finalize(), finalize(), finalize()]);
    await finalize();
    expect(await recipients('training_cancelled', session.id)).toEqual(
      sorted([p.organizerId, p.secondOrganizer, p.memberIds[0], p.memberIds[2], p.memberIds[3]]),
    );
    const [n] = await notifications("kind = 'training_cancelled' and user_id = $1", [p.memberIds[0]]);
    expect(n.body).toMatch(/Not enough participants: 1 of 3 needed.$/);
    expect(await recipients('training_confirmed', session.id)).toEqual([]);
  });

  it('cancelled by an organizer: everyone except the canceller and not_going, once even when repeated', async () => {
    const p = await pack();
    const session = await createTraining(p.organizerId, p.communityId);
    await setRsvp(p.memberIds[1], session.id, 'not_going');
    await cancelTraining(p.secondOrganizer, session.id);
    await cancelTraining(p.secondOrganizer, session.id);
    await cancelTraining(p.organizerId, session.id);
    expect(await recipients('training_cancelled', session.id)).toEqual(sorted([p.organizerId, p.memberIds[0], p.memberIds[2], p.memberIds[3]]));
    const [n] = await notifications("kind = 'training_cancelled' and user_id = $1", [p.memberIds[0]]);
    expect(n.body).toMatch(/cancelled by the organizer\.$/);
  });

  it('cancelling a confirmed session notifies once more as cancelled, nothing else', async () => {
    const p = await pack(2);
    const session = await createTraining(p.organizerId, p.communityId, { min_participants: 1 });
    await setRsvp(p.memberIds[0], session.id, 'going');
    await makeDue(session.id);
    await finalize();
    await cancelTraining(p.organizerId, session.id);
    expect(await recipients('training_confirmed', session.id)).toEqual(sorted([p.organizerId, p.memberIds[0]]));
    expect(await recipients('training_cancelled', session.id)).toEqual(sorted([p.secondOrganizer, ...p.memberIds]));
  });

  it('members removed before the event get nothing; members who join later get only later events', async () => {
    const p = await pack(2);
    const session = await createTraining(p.organizerId, p.communityId);
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [p.memberIds[0]]);
    const late = await addMember(p.communityId, { name: 'Late Joiner' });
    await cancelTraining(p.organizerId, session.id);
    expect(await recipients('training_created', session.id)).toEqual(sorted([p.secondOrganizer, ...p.memberIds]));
    expect(await recipients('training_cancelled', session.id)).toEqual(sorted([p.secondOrganizer, p.memberIds[1], late]));
  });
});

describe('training reminders', () => {
  /** A confirmed session starting `hours` from now, with the first `going` members going. */
  async function confirmedStartingIn(hours: number, going = 2) {
    const p = await pack(3);
    const session = await createTraining(p.organizerId, p.communityId, { min_participants: 1 });
    for (const id of p.memberIds.slice(0, going)) await setRsvp(id, session.id, 'going');
    await makeDue(session.id);
    await finalize();
    // The confirmation was more than an hour ago (it suppresses the 2h reminder otherwise).
    await admin.query(
      "update public.notifications set created_at = now() - interval '3 hours' where related_session_id = $1",
      [session.id],
    );
    await admin.query(
      `update public.training_sessions set starts_at = now() + make_interval(mins => $2), ends_at = null where id = $1`,
      [session.id, Math.round(hours * 60)],
    );
    return { ...p, session };
  }

  const reminders = (sessionId: string) =>
    notifications("kind = 'training_reminder' and related_session_id = $1", [sessionId]);

  it('24h reminder: going members only, exactly once per window, with a start-time key', async () => {
    const p = await confirmedStartingIn(23.5);
    expect(await enqueueReminders()).toBe(2);
    expect(await enqueueReminders()).toBe(0);
    const rows = await reminders(p.session.id);
    expect(rows.map((r) => r.user_id)).toEqual(sorted(p.memberIds.slice(0, 2)));
    const start = (await admin.query('select starts_at from public.training_sessions where id = $1', [p.session.id])).rows[0].starts_at as Date;
    expect(rows[0].dedupe_key).toBe(`training_reminder_24h:${p.session.id}:${Math.floor(start.getTime() / 1000)}`);
    expect(rows[0].title).toBe('Tomorrow: Morning run');
  });

  it('2h reminder for confirmed sessions; rescheduling into the window again creates a new one', async () => {
    const p = await confirmedStartingIn(1.5);
    expect(await enqueueReminders()).toBe(2);
    expect(await enqueueReminders()).toBe(0);
    expect((await reminders(p.session.id)).map((r) => r.title)).toEqual(['Starting soon: Morning run', 'Starting soon: Morning run']);

    await admin.query("update public.training_sessions set starts_at = now() + interval '100 minutes' where id = $1", [p.session.id]);
    expect(await enqueueReminders()).toBe(2);
    expect(await enqueueReminders()).toBe(0);
    expect(await reminders(p.session.id)).toHaveLength(4);
  });

  it('a 24h reminder also goes to going members of a still-scheduled session; outside the windows nothing', async () => {
    const p = await pack(2);
    const soon = await createTraining(p.organizerId, p.communityId, { starts_at: hoursFromNow(23.5), ends_at: null, rsvp_deadline: hoursFromNow(20) });
    const far = await createTraining(p.organizerId, p.communityId, { starts_at: hoursFromNow(30), ends_at: null, rsvp_deadline: hoursFromNow(20) });
    const midway = await createTraining(p.organizerId, p.communityId, { starts_at: hoursFromNow(10), ends_at: null, rsvp_deadline: hoursFromNow(1) });
    for (const s of [soon, far, midway]) await setRsvp(p.memberIds[0], s.id, 'going');
    expect(await enqueueReminders()).toBe(1);
    expect((await reminders(soon.id)).map((r) => r.user_id)).toEqual([p.memberIds[0]]);
    expect(await reminders(far.id)).toEqual([]);
    expect(await reminders(midway.id)).toEqual([]);
  });

  it('no 2h reminder for scheduled or cancelled sessions, removed members, or right after the confirmation', async () => {
    const p = await confirmedStartingIn(1.5, 3);
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [p.memberIds[2]]);
    // memberIds[1] was confirmed 10 minutes ago: the confirmation already told them.
    await admin.query(
      "update public.notifications set created_at = now() - interval '10 minutes' where kind = 'training_confirmed' and user_id = $1",
      [p.memberIds[1]],
    );
    expect(await enqueueReminders()).toBe(1);
    expect((await reminders(p.session.id)).map((r) => r.user_id)).toEqual([p.memberIds[0]]);

    const q = await confirmedStartingIn(1.5);
    await cancelTraining(q.organizerId, q.session.id);
    const scheduled = await createTraining(q.organizerId, q.communityId, { min_participants: 1 });
    await setRsvp(q.memberIds[0], scheduled.id, 'going');
    await admin.query("update public.training_sessions set starts_at = now() + interval '90 minutes', ends_at = null, rsvp_deadline = now() + interval '30 minutes' where id = $1", [scheduled.id]);
    expect(await enqueueReminders()).toBe(0);
  });

  it('concurrent runs insert each reminder once', async () => {
    const p = await confirmedStartingIn(23.5, 3);
    const counts = await Promise.all(Array.from({ length: 6 }, () => enqueueReminders()));
    expect(counts.reduce((x, y) => x + y, 0)).toBe(3);
    expect(await reminders(p.session.id)).toHaveLength(3);
    expect(await countRows('notification_delivery_jobs', 'notification_id in (select id from public.notifications where kind = $1)', ['training_reminder'])).toBe(3);
  });

  it('is service_role only', async () => {
    const { organizerId } = await createPack();
    await expect(asUser(organizerId, (db) => rpc(db, 'enqueue_due_training_reminders'))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('dedupe', () => {
  it('(user_id, dedupe_key) is unique in the table itself', async () => {
    const p = await pack(1);
    const session = await createTraining(p.organizerId, p.communityId);
    await expect(
      admin.query(
        `insert into public.notifications (user_id, community_id, kind, title, body, deep_link, related_session_id, dedupe_key)
         values ($1, $2, 'training_created', 't', 'b', '/trainings/' || $3::uuid::text, $3, $4)`,
        [p.memberIds[0], p.communityId, session.id, `training_created:${session.id}`],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    // And one job per notification.
    const [job] = await jobs('user_id = $1', [p.memberIds[0]]);
    await expect(
      admin.query("insert into public.notification_delivery_jobs (notification_id, user_id, expires_at) values ($1, $2, now() + interval '1 day')", [job.notification_id, job.user_id]),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('in-app notifications: read state and RLS', () => {
  it('users see only their own notifications, of communities they are active in', async () => {
    const p = await pack(2);
    const session = await createTraining(p.organizerId, p.communityId);
    await createAnnouncement(p.organizerId, p.communityId);
    const other = await createPack(1);
    await createTraining(other.organizerId, other.communityId);

    const visible = (user: string) =>
      asUser(user, (db) => db.query<NotificationRow>('select * from public.notifications order by kind')).then((r) => r.rows);
    const mine = await visible(p.memberIds[0]);
    expect(mine.map((n) => n.kind)).toEqual(['training_created', 'announcement_published']);
    expect(mine.every((n) => n.user_id === p.memberIds[0])).toBe(true);
    expect(await visible(p.organizerId)).toEqual([]);
    expect((await visible(other.memberIds[0])).map((n) => n.community_id)).toEqual([other.communityId]);

    // A removed member no longer sees theirs (the rows stay).
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [p.memberIds[0]]);
    expect(await visible(p.memberIds[0])).toEqual([]);
    expect(await countRows('notifications', 'user_id = $1', [p.memberIds[0]])).toBe(2);
    expect(session.id).toBeTruthy();
  });

  it('mark_notification_read: own only, idempotent; mark_all per community', async () => {
    const p = await pack(1);
    const s1 = await createTraining(p.organizerId, p.communityId);
    await createTraining(p.organizerId, p.communityId);
    await createAnnouncement(p.organizerId, p.communityId);
    const other = await createPack(1);
    await createTraining(other.organizerId, other.communityId);
    // The member of pack p also belongs to the other community.
    await admin.query('insert into public.memberships (community_id, user_id) values ($1, $2)', [other.communityId, p.memberIds[0]]);
    await createTraining(other.organizerId, other.communityId);

    const [n] = await notifications("user_id = $1 and related_session_id = $2", [p.memberIds[0], s1.id]);
    const first = await asUser(p.memberIds[0], (db) => rpcRow<NotificationRow>(db, 'mark_notification_read', [n.id]));
    expect(first.read_at).toBeInstanceOf(Date);
    const again = await asUser(p.memberIds[0], (db) => rpcRow<NotificationRow>(db, 'mark_notification_read', [n.id]));
    expect(again.read_at).toEqual(first.read_at);
    for (const user of [p.secondOrganizer, other.memberIds[0]]) {
      await expect(asUser(user, (db) => rpcRow(db, 'mark_notification_read', [n.id]))).rejects.toMatchObject(raised('not_found'));
    }

    expect(await asUser(p.memberIds[0], (db) => rpc<number>(db, 'mark_all_notifications_read', [p.communityId]))).toBe(2);
    expect(await asUser(p.memberIds[0], (db) => rpc<number>(db, 'mark_all_notifications_read', [p.communityId]))).toBe(0);
    // The other community's notification is untouched.
    expect(await countRows('notifications', 'user_id = $1 and read_at is null', [p.memberIds[0]])).toBe(1);
    await expect(asUser(other.memberIds[0], (db) => rpc(db, 'mark_all_notifications_read', [p.communityId]))).rejects.toMatchObject(raised('not_a_member'));
    await expect(asAnon((db) => rpc(db, 'mark_all_notifications_read', [p.communityId]))).rejects.toMatchObject({ code: '42501' });
  });

  it('clients cannot write notifications, and see nothing of the push outbox', async () => {
    const p = await pack(1);
    const session = await createTraining(p.organizerId, p.communityId);
    const [n] = await notifications('user_id = $1', [p.memberIds[0]]);
    const attempts: [string, unknown[]][] = [
      ["insert into public.notifications (user_id, community_id, kind, title, body, deep_link, related_session_id, dedupe_key) values ($1, $2, 'training_created', 't', 'b', '/x', $3, 'k')", [p.memberIds[0], p.communityId, session.id]],
      ['update public.notifications set read_at = now() where id = $1', [n.id]],
      ['delete from public.notifications where id = $1', [n.id]],
      ['select * from public.notification_delivery_jobs', []],
      ["update public.notification_delivery_jobs set status = 'sent'", []],
      ['delete from public.notification_delivery_jobs', []],
    ];
    for (const user of [p.memberIds[0], p.organizerId]) {
      for (const [sql, params] of attempts) {
        await expect(asUser(user, (db) => db.query(sql, params)), sql).rejects.toMatchObject({ code: '42501' });
      }
    }
    await expect(asAnon((db) => db.query('select * from public.notifications'))).rejects.toMatchObject({ code: '42501' });
  });

  it('deleting an account deletes its notifications and push jobs', async () => {
    const p = await pack(2);
    await createTraining(p.organizerId, p.communityId);
    await admin.query('delete from auth.users where id = $1', [p.memberIds[0]]);
    expect(await countRows('notifications', 'user_id = $1', [p.memberIds[0]])).toBe(0);
    expect(await countRows('notification_delivery_jobs', 'user_id = $1', [p.memberIds[0]])).toBe(0);
    expect(await countRows('notifications')).toBe(2);
  });
});

describe('realtime publication', () => {
  it('publishes announcements and notifications with RLS enabled; not reads, tokens, preferences or jobs', async () => {
    const { rows } = await admin.query<{ tablename: string }>(
      "select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'",
    );
    const tables = rows.map((r) => r.tablename);
    expect(tables).toEqual(expect.arrayContaining(['announcements', 'notifications']));
    for (const hidden of ['announcement_reads', 'device_push_tokens', 'notification_preferences', 'notification_delivery_jobs']) {
      expect(tables).not.toContain(hidden);
    }
    const rls = await admin.query<{ relname: string; relrowsecurity: boolean; relreplident: string }>(
      `select relname, relrowsecurity, relreplident from pg_class
       where oid in ('public.announcements'::regclass, 'public.notifications'::regclass) order by relname`,
    );
    expect(rls.rows).toEqual([
      { relname: 'announcements', relrowsecurity: true, relreplident: 'd' },
      { relname: 'notifications', relrowsecurity: true, relreplident: 'd' },
    ]);
    const policies = await admin.query<{ tablename: string; policyname: string; cmd: string; roles: string[] }>(
      `select tablename, policyname, cmd, roles::text[] as roles from pg_policies
       where schemaname = 'public'
         and tablename in ('announcements', 'announcement_reads', 'notifications', 'notification_delivery_jobs', 'device_push_tokens', 'notification_preferences')
       order by 1`,
    );
    expect(policies.rows).toEqual([
      { tablename: 'announcement_reads', policyname: 'announcement_reads_select_own', cmd: 'SELECT', roles: ['authenticated'] },
      { tablename: 'announcements', policyname: 'announcements_select_members', cmd: 'SELECT', roles: ['authenticated'] },
      { tablename: 'device_push_tokens', policyname: 'device_push_tokens_select_own', cmd: 'SELECT', roles: ['authenticated'] },
      { tablename: 'notification_preferences', policyname: 'notification_preferences_select_own', cmd: 'SELECT', roles: ['authenticated'] },
      { tablename: 'notifications', policyname: 'notifications_select_own', cmd: 'SELECT', roles: ['authenticated'] },
    ]);
    const jobsRls = await admin.query("select relrowsecurity from pg_class where oid = 'public.notification_delivery_jobs'::regclass");
    expect(jobsRls.rows[0].relrowsecurity).toBe(true);
  });

  it('schedules nothing without pg_cron (the scheduling migration is a no-op here)', async () => {
    const cron = await admin.query("select 1 from pg_namespace where nspname = 'cron'");
    expect(cron.rows).toEqual([]);
  });
});
