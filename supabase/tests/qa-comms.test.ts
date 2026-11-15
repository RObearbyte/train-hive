import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addMember,
  admin,
  asAnon,
  asService,
  asUser,
  cancelTraining,
  closeDb,
  countRows,
  createPack,
  createTraining,
  finalize,
  hoursFromNow,
  INSUFFICIENT_PRIVILEGE,
  makeDue,
  resetData,
  rpc,
  rpcRow,
  setRsvp,
  updateTraining,
} from './helpers';
import {
  cancelAnnouncement,
  claimJobs,
  createAnnouncement,
  enqueueReminders,
  expoToken,
  makeAnnouncementDue,
  notifications,
  publishDue,
  recipients,
  registerToken,
  sorted,
  updateAnnouncement,
} from './notifications-helpers';
import { formOf } from './qa-helpers';

/**
 * QA (M3-Q1): adversarial review of announcements, notifications, push tokens and the outbox.
 * Defects are marked `DEFECT Q4-n` and use `it.fails`, so they turn red when fixed.
 */

beforeEach(resetData);
afterAll(closeDb);

const forbidden = { code: 'P0001', message: 'forbidden' };
const notFound = { code: 'P0001', message: 'not_found' };
const notMember = { code: 'P0001', message: 'not_a_member' };
const denied = { code: INSUFFICIENT_PRIVILEGE };

async function twoCommunities() {
  const a = await createPack(2);
  const b = await createPack(2);
  const removedA = await addMember(a.communityId, { status: 'removed', name: 'Gone' });
  return { a, b, removedA };
}

const selectAs = <T extends Record<string, unknown>>(user: string, sql: string) =>
  asUser(user, (db) => db.query<T>(sql)).then((r) => r.rows);

describe('QA isolation matrix: announcements', () => {
  it('visibility per role and per community, scheduled and cancelled hidden from members', async () => {
    const { a, b, removedA } = await twoCommunities();
    const pub = await createAnnouncement(a.organizerId, a.communityId, { title: 'A published' });
    const sched = await createAnnouncement(a.organizerId, a.communityId, { title: 'A scheduled', scheduledFor: hoursFromNow(5) });
    const canc = await createAnnouncement(a.organizerId, a.communityId, { title: 'A cancelled', scheduledFor: hoursFromNow(6) });
    await cancelAnnouncement(a.organizerId, canc.id);
    const pubB = await createAnnouncement(b.organizerId, b.communityId, { title: 'B published' });

    const ids = async (u: string) => sorted((await selectAs<{ id: string }>(u, 'select id from public.announcements')).map((r) => r.id));
    expect(await ids(a.memberIds[0])).toEqual([pub.id]);
    expect(await ids(a.organizerId)).toEqual(sorted([pub.id, sched.id, canc.id]));
    expect(await ids(b.organizerId)).toEqual([pubB.id]);
    expect(await ids(b.memberIds[0])).toEqual([pubB.id]);
    expect(await ids(removedA)).toEqual([]);
    await expect(asAnon((db) => db.query('select id from public.announcements'))).rejects.toMatchObject(denied);
  });

  it('an organizer of another community cannot create, edit, cancel, or read state in this one', async () => {
    const { a, b } = await twoCommunities();
    const sched = await createAnnouncement(a.organizerId, a.communityId, { scheduledFor: hoursFromNow(5) });
    const pub = await createAnnouncement(a.organizerId, a.communityId);

    await expect(createAnnouncement(b.organizerId, a.communityId)).rejects.toMatchObject(forbidden);
    await expect(updateAnnouncement(b.organizerId, sched.id, 'x', 'y', null)).rejects.toMatchObject(forbidden);
    await expect(cancelAnnouncement(b.organizerId, sched.id)).rejects.toMatchObject(forbidden);
    await expect(asUser(b.memberIds[0], (db) => rpc(db, 'mark_announcement_read', [pub.id]))).rejects.toMatchObject(notFound);
    await expect(asUser(b.memberIds[0], (db) => rpc(db, 'unread_announcement_count', [a.communityId]))).rejects.toMatchObject(notMember);
    await expect(asUser(b.memberIds[0], (db) => rpc(db, 'mark_announcements_read', [a.communityId]))).rejects.toMatchObject(notMember);
    await expect(asUser(b.memberIds[0], (db) => rpc(db, 'mark_all_notifications_read', [a.communityId]))).rejects.toMatchObject(notMember);
    await expect(cancelAnnouncement(a.memberIds[0], sched.id)).rejects.toMatchObject(forbidden);
    expect(await countRows('announcements', "status = 'scheduled'")).toBe(1);
    expect(await countRows('announcement_reads')).toBe(0);
  });

  it('a demoted organizer loses every announcement power at once; the scheduled one still publishes', async () => {
    const { a } = await twoCommunities();
    const second = await addMember(a.communityId, { role: 'organizer' });
    const sched = await createAnnouncement(second, a.communityId, { scheduledFor: hoursFromNow(5) });
    await admin.query("update public.memberships set role = 'member' where user_id = $1", [second]);
    await expect(updateAnnouncement(second, sched.id, 'x', 'y', null)).rejects.toMatchObject(forbidden);
    await expect(cancelAnnouncement(second, sched.id)).rejects.toMatchObject(forbidden);
    expect(await selectAs(second, 'select id from public.announcements')).toEqual([]);
    await makeAnnouncementDue(sched.id);
    expect(await publishDue()).toBe(1);
    // The author is excluded from the fan-out, everyone else active gets it.
    expect(await recipients('announcement_published', sched.id)).toEqual(sorted([a.organizerId, ...a.memberIds]));
  });
});

describe('QA isolation matrix: notifications, tokens, preferences, jobs', () => {
  it("nobody reads another user's notifications, tokens or preferences; jobs are unreadable", async () => {
    const { a, b } = await twoCommunities();
    await createAnnouncement(a.organizerId, a.communityId);
    await registerToken(a.memberIds[0], expoToken('m0'));
    await asUser(a.memberIds[0], (db) => rpcRow(db, 'set_notification_preferences', [false, null, null, null]));

    for (const other of [a.memberIds[1], a.organizerId, b.organizerId, b.memberIds[0]]) {
      expect(await selectAs(other, 'select * from public.device_push_tokens')).toEqual([]);
      expect(await selectAs(other, 'select * from public.notification_preferences')).toEqual([]);
      const mine = await selectAs<{ user_id: string }>(other, 'select user_id from public.notifications');
      expect(mine.every((r) => r.user_id === other)).toBe(true);
      await expect(asUser(other, (db) => db.query('select * from public.notification_delivery_jobs'))).rejects.toMatchObject(denied);
    }
    const prefs = await asUser(a.memberIds[1], (db) => rpcRow<{ push_enabled: boolean }>(db, 'get_notification_preferences'));
    expect(prefs.push_enabled).toBe(true);
    expect(await asUser(a.organizerId, (db) => rpc(db, 'unregister_push_token', [expoToken('m0')]))).toBe(false);
    expect(await countRows('device_push_tokens')).toBe(1);
    const [n] = await notifications('user_id = $1', [a.memberIds[0]]);
    await expect(asUser(a.memberIds[1], (db) => rpc(db, 'mark_notification_read', [n.id]))).rejects.toMatchObject(notFound);
    await expect(asUser(b.memberIds[0], (db) => rpc(db, 'mark_notification_read', [n.id]))).rejects.toMatchObject(notFound);
    expect((await notifications('id = $1', [n.id]))[0].read_at).toBeNull();
  });

  it('a removed member: no new notifications, old ones hidden and unreadable, visible again when reinstated', async () => {
    const { a } = await twoCommunities();
    const m = a.memberIds[0];
    await createAnnouncement(a.organizerId, a.communityId, { title: 'Before' });
    const [before] = await notifications('user_id = $1', [m]);
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [m]);
    await createAnnouncement(a.organizerId, a.communityId, { title: 'During' });
    await createTraining(a.organizerId, a.communityId);
    expect(await countRows('notifications', 'user_id = $1', [m])).toBe(1);
    expect(await selectAs(m, 'select id from public.notifications')).toEqual([]);
    await expect(asUser(m, (db) => rpc(db, 'mark_notification_read', [before.id]))).rejects.toMatchObject(notFound);
    await expect(asUser(m, (db) => rpc(db, 'mark_announcements_read', [a.communityId]))).rejects.toMatchObject(notMember);
    await admin.query("update public.memberships set status = 'active' where user_id = $1", [m]);
    const titles = await selectAs<{ title: string }>(m, 'select title from public.notifications');
    expect(titles.map((r) => r.title)).toEqual(['Before']);
  });

  it('claim_notification_jobs reports not_a_member and no tokens for a removed recipient', async () => {
    const { a } = await twoCommunities();
    await registerToken(a.memberIds[0], expoToken('gone'));
    await createAnnouncement(a.organizerId, a.communityId);
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [a.memberIds[0]]);
    const claimed = (await claimJobs('w1')).find((j) => j.user_id === a.memberIds[0])!;
    expect(claimed.skip_reason).toBe('not_a_member');
    expect(claimed.tokens).toEqual([]);
    expect(claimed.push_allowed).toBe(false);
  });
});

describe('QA fan-out recipient exactness', () => {
  it('training_created excludes the creator, removed members and other communities; a reinstated member is included', async () => {
    const { a, b, removedA } = await twoCommunities();
    const flip = await addMember(a.communityId, { status: 'removed' });
    await admin.query("update public.memberships set status = 'active' where user_id = $1", [flip]);
    const s = await createTraining(a.organizerId, a.communityId);
    expect(await recipients('training_created', s.id)).toEqual(sorted([...a.memberIds, flip]));
    expect(await recipients('training_created', s.id)).not.toContain(removedA);
    expect(await countRows('notifications', 'community_id = $1', [b.communityId])).toBe(0);
  });

  it('confirmed: going members plus the organizer, never a removed organizer or a removed going member', async () => {
    const { a } = await twoCommunities();
    const s = await createTraining(a.organizerId, a.communityId, { min_participants: 1 });
    await setRsvp(a.memberIds[0], s.id, 'going');
    await setRsvp(a.memberIds[1], s.id, 'going');
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [a.memberIds[1]]);
    await makeDue(s.id);
    await finalize();
    expect(await recipients('training_confirmed', s.id)).toEqual(sorted([a.memberIds[0], a.organizerId]));

    const s2 = await createTraining(a.organizerId, a.communityId, { min_participants: 1 });
    await setRsvp(a.memberIds[0], s2.id, 'going');
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [a.organizerId]);
    await makeDue(s2.id);
    await finalize();
    expect(await recipients('training_confirmed', s2.id)).toEqual([a.memberIds[0]]);
  });

  it('cancelled by a second organizer: the original organizer is told, the canceller is not', async () => {
    const { a } = await twoCommunities();
    const second = await addMember(a.communityId, { role: 'organizer' });
    const s = await createTraining(a.organizerId, a.communityId);
    await setRsvp(a.memberIds[1], s.id, 'not_going');
    await cancelTraining(second, s.id);
    expect(await recipients('training_cancelled', s.id)).toEqual(sorted([a.organizerId, a.memberIds[0]]));
  });

  it('an edit repeated unchanged fires nothing; changing back and forth fires once per real change', async () => {
    const { a } = await twoCommunities();
    const s = await createTraining(a.organizerId, a.communityId);
    const count = () => countRows('notifications', "kind = 'training_updated'");
    const renamed = await updateTraining(a.organizerId, s.id, formOf(s, { title: 'Renamed' }));
    expect(await count()).toBe(2);
    await updateTraining(a.organizerId, s.id, formOf(renamed, { title: 'Renamed' }));
    expect(await count()).toBe(2);
    const back = await updateTraining(a.organizerId, s.id, formOf(renamed, { title: s.title }));
    expect(await count()).toBe(4);
    await updateTraining(a.organizerId, s.id, formOf(back, { title: `  ${s.title}  ` }));
    expect(await count()).toBe(4);
    await updateTraining(a.organizerId, s.id, formOf(back, { ends_at: null }));
    expect(await count()).toBe(6);
  });

  it('RSVP storms never notify', async () => {
    const { a } = await twoCommunities();
    const s = await createTraining(a.organizerId, a.communityId);
    const before = await countRows('notifications');
    for (const m of a.memberIds) {
      await setRsvp(m, s.id, 'going');
      await setRsvp(m, s.id, 'not_going');
      await setRsvp(m, s.id, 'going');
    }
    expect(await countRows('notifications')).toBe(before);
  });
});

describe('QA reminders: windows, rescheduling, DST text', () => {
  async function scheduledWithGoing(minutesAhead: number) {
    const { a } = await twoCommunities();
    const s = await createTraining(a.organizerId, a.communityId);
    await setRsvp(a.memberIds[0], s.id, 'going');
    await setRsvp(a.memberIds[1], s.id, 'going');
    await admin.query(
      `update public.training_sessions
         set rsvp_deadline = now() - interval '1 hour',
             starts_at = now() + make_interval(mins => $2), ends_at = null where id = $1`,
      [s.id, minutesAhead],
    );
    return { ...a, session: s };
  }
  const reminders = (id: string) => notifications("kind = 'training_reminder' and related_session_id = $1", [id]);

  it('24h window is (23h, 24h]: edges', async () => {
    for (const [minutes, expected] of [[24 * 60 + 2, 0], [24 * 60 - 2, 2], [23 * 60 + 2, 2], [23 * 60 - 2, 0]] as const) {
      await resetData();
      const p = await scheduledWithGoing(minutes);
      expect(await enqueueReminders(), `${minutes} min`).toBe(expected);
      expect(await reminders(p.session.id)).toHaveLength(expected);
    }
  });

  it('a rescheduled session gets fresh reminders; an unchanged start does not repeat', async () => {
    const p = await scheduledWithGoing(23 * 60 + 30);
    expect(await enqueueReminders()).toBe(2);
    expect(await enqueueReminders()).toBe(0);
    await admin.query("update public.training_sessions set starts_at = starts_at + interval '5 minutes' where id = $1", [p.session.id]);
    expect(await enqueueReminders()).toBe(2);
    expect(await enqueueReminders()).toBe(0);
    const keys = (await reminders(p.session.id)).map((r) => r.dedupe_key);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(2);
  });

  it('a cancelled session inside the window gets no reminder', async () => {
    const p = await scheduledWithGoing(23 * 60 + 30);
    await cancelTraining(p.organizerId, p.session.id);
    expect(await enqueueReminders()).toBe(0);
  });

  it('the wall-clock text follows the session zone across DST changes (create_training body)', async () => {
    const { a } = await twoCommunities();
    const body = async (zone: string, startsAt: string, endsAt: string) => {
      const s = await createTraining(a.organizerId, a.communityId, {
        timezone: zone, starts_at: startsAt, ends_at: endsAt, rsvp_deadline: hoursFromNow(48), min_participants: 1,
      });
      const [n] = await notifications("kind = 'training_created' and related_session_id = $1 and user_id = $2", [s.id, a.memberIds[0]]);
      return n.body;
    };
    expect(await body('America/New_York', '2027-03-14T06:59:00Z', '2027-03-14T08:30:00Z')).toMatch(/^Sun 14 Mar, 01:59 · /);
    expect(await body('America/New_York', '2027-03-14T07:01:00Z', '2027-03-14T08:30:00Z')).toMatch(/^Sun 14 Mar, 03:01 · /);
    expect(await body('Europe/Bucharest', '2027-03-28T00:59:00Z', '2027-03-28T03:00:00Z')).toMatch(/^Sun 28 Mar, 02:59 · /);
    expect(await body('Europe/Bucharest', '2027-03-28T01:01:00Z', '2027-03-28T03:00:00Z')).toMatch(/^Sun 28 Mar, 04:01 · /);
    // Repeated hour on fall back: two instants read identically (no offset in the text).
    const first = await body('America/New_York', '2027-11-07T05:30:00Z', '2027-11-07T08:30:00Z');
    const second = await body('America/New_York', '2027-11-07T06:30:00Z', '2027-11-07T08:30:00Z');
    expect(first.split(' · ')[0]).toBe('Sun 07 Nov, 01:30');
    expect(second.split(' · ')[0]).toBe('Sun 07 Nov, 01:30');
  });
});

describe('QA text and payload fuzzing (server)', () => {
  const create = (a: { organizerId: string; communityId: string }, title: string, body = 'ok') =>
    createAnnouncement(a.organizerId, a.communityId, { title, body });

  it('counts code points: 100 emoji fit, 101 do not; body 2000 vs 2001', async () => {
    const { a } = await twoCommunities();
    const ok = await create(a, '😀'.repeat(100), '😀'.repeat(2000));
    expect(Array.from(ok.title)).toHaveLength(100);
    await expect(create(a, '😀'.repeat(101))).rejects.toMatchObject({ message: 'validation_failed:title' });
    await expect(create(a, 'x', '😀'.repeat(2001))).rejects.toMatchObject({ message: 'validation_failed:body' });
  });

  it('collapses newlines and tabs in titles; keeps them in bodies; the notification body is one line', async () => {
    const { a } = await twoCommunities();
    const row = await create(a, '  Big\n\tnews   today ', 'line1\n\nline2\t\tx');
    expect(row.title).toBe('Big news today');
    expect(row.body).toBe('line1\n\nline2\t\tx');
    const [n] = await notifications('related_announcement_id = $1 and user_id = $2', [row.id, a.memberIds[0]]);
    expect(n.body).toBe('line1 line2 x');
    expect(n.deep_link).toBe(`/announcements/${row.id}`);
  });

  it('blank input is rejected: spaces, tabs, newlines', async () => {
    const { a } = await twoCommunities();
    for (const t of ['', ' ', '\n', '\t \r\n']) {
      await expect(create(a, t), JSON.stringify(t)).rejects.toMatchObject({ message: 'validation_failed:title' });
      await expect(create(a, 'x', t), JSON.stringify(t)).rejects.toMatchObject({ message: 'validation_failed:body' });
    }
  });

  it('is inert for markup, SQL and format-looking text (stored verbatim, never interpreted)', async () => {
    const { a } = await twoCommunities();
    const nasty = `'; drop table public.notifications; -- <script>alert(1)</script> %s {{x}} $1 \\u0000`;
    const row = await create(a, nasty, nasty);
    expect(row.title).toBe(nasty);
    expect(await countRows('notifications', 'related_announcement_id = $1', [row.id])).toBe(2);
  });

  // DEFECT Q4-5 (low): invisible-only titles pass validation and render as an empty heading in
  // the feed, the notification center and the push banner.
  it.fails('DEFECT Q4-5: a title of only zero-width or no-break spaces is rejected', async () => {
    const { a } = await twoCommunities();
    for (const t of ['​​', '  ', '⠀']) {
      await expect(create(a, t), JSON.stringify(t)).rejects.toMatchObject({ message: 'validation_failed:title' });
    }
  });

  // DEFECT Q4-5 (same cause): control and bidi-override characters are stored and pushed.
  it.fails('DEFECT Q4-5: control characters and bidi overrides are rejected or stripped', async () => {
    const { a } = await twoCommunities();
    const row = await create(a, 'Pay now‮ fdp.exe\u0007');
    expect(row.title).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f‪-‮⁦-⁩]/);
  });

  // DEFECT Q4-6 (low, defense in depth): the table check for deep_link accepts a protocol-relative
  // URL and parent-directory segments. Only definer functions write the column and they build
  // fixed routes, and the app allowlists links, so this is not reachable today.
  it.fails('DEFECT Q4-6: notifications.deep_link only accepts the documented routes', async () => {
    const { a } = await twoCommunities();
    const s = await createTraining(a.organizerId, a.communityId);
    for (const link of ['//evil.example/x', '/trainings/../../admin', '/x?next=//evil.example']) {
      await expect(
        admin.query(
          `insert into public.notifications (user_id, community_id, kind, title, body, deep_link, related_session_id, dedupe_key)
           values ($1, $2, 'training_created', 't', 'b', $3, $4, $5)`,
          [a.memberIds[0], a.communityId, link, s.id, `fuzz:${link}`],
        ),
        link,
      ).rejects.toBeTruthy();
    }
  });

  it('push token format fuzz: only exact Expo tokens pass', async () => {
    const { a } = await twoCommunities();
    const bad = ['', ' ', 'ExponentPushToken[]', 'ExponentPushToken[a b]', 'ExponentPushToken[a]]', 'exponentpushtoken[a]',
      'ExponentPushToken[a]\n', 'ExponentPushToken[é]', `ExponentPushToken[${'a'.repeat(200)}]`, "ExponentPushToken[a'];--",
      'ExponentPushToken[a]ExponentPushToken[b]', 'fcm:abc'];
    for (const t of bad) {
      await expect(registerToken(a.memberIds[0], t), JSON.stringify(t)).rejects.toMatchObject({ message: 'validation_failed:token' });
    }
    await registerToken(a.memberIds[0], 'ExpoPushToken[Abc_1:2.3-x]');
    await registerToken(a.memberIds[0], `ExponentPushToken[${'a'.repeat(200 - 'ExponentPushToken[]'.length)}]`);
    expect(await countRows('device_push_tokens')).toBe(2);
    await expect(registerToken(a.memberIds[0], expoToken('p'), 'desktop')).rejects.toMatchObject({ message: 'validation_failed:platform' });
  });
});

describe('QA token ownership (bearer-token risk, documented)', () => {
  it("whoever registers a token receives that device's pushes; the previous owner is silently cut off", async () => {
    const { a } = await twoCommunities();
    const [victim, attacker] = a.memberIds;
    const token = expoToken('victim-phone');
    await registerToken(victim, token);
    await registerToken(attacker, token);
    await createAnnouncement(a.organizerId, a.communityId);
    const claimed = await claimJobs('w');
    const forVictim = claimed.find((j) => j.user_id === victim)!;
    const forAttacker = claimed.find((j) => j.user_id === attacker)!;
    expect(forVictim.tokens).toEqual([]);
    expect(forVictim.skip_reason).toBe('no_tokens');
    // The attacker never receives the victim's content; the victim's phone receives the attacker's.
    expect(forAttacker.tokens).toEqual([token]);
  });

  it('concurrent registrations: swapping tokens between users and a 15-token storm never error or deadlock', async () => {
    const { a } = await twoCommunities();
    const [u1, u2] = a.memberIds;
    const t1 = expoToken('s1');
    const t2 = expoToken('s2');
    await registerToken(u1, t1);
    await registerToken(u2, t2);
    await Promise.all([registerToken(u1, t2), registerToken(u2, t1), registerToken(u1, t1), registerToken(u2, t2)]);
    const rows = await admin.query<{ token: string }>('select token from public.device_push_tokens');
    expect(rows.rows.map((r) => r.token).sort()).toEqual([t1, t2].sort());
    await Promise.all(Array.from({ length: 15 }, (_, i) => registerToken(u1, expoToken(`storm-${i}`))));
    expect(await countRows('device_push_tokens', 'user_id = $1', [u1])).toBeLessThanOrEqual(10);
  });
});

describe('QA abuse and growth (observations)', () => {
  it('O-1: nothing limits announcement volume; each one fans out per member and per push job', async () => {
    const a = await createPack(3);
    for (let i = 0; i < 25; i += 1) await createAnnouncement(a.organizerId, a.communityId, { title: `Spam ${i}` });
    expect(await countRows('notifications', "kind = 'announcement_published'")).toBe(25 * 3);
    expect(await countRows('notification_delivery_jobs')).toBe(25 * 3);
  });

  it('O-2: the purge never removes in-app notifications, so the table grows without bound', async () => {
    const a = await createPack(2);
    await createAnnouncement(a.organizerId, a.communityId);
    await admin.query("update public.notifications set created_at = now() - interval '400 days'");
    await asService((db) => rpc(db, 'purge_old_notification_data'));
    expect(await countRows('notifications')).toBe(2);
  });

  it('O-3: the push badge count includes hidden notifications of a community the user left', async () => {
    const a = await createPack(2);
    await createAnnouncement(a.organizerId, a.communityId, { title: 'one' });
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [a.memberIds[0]]);
    const row = (await claimJobs('w')).find((j) => j.user_id === a.memberIds[0])!;
    expect(row.unread_count).toBe(1);
    expect(await selectAs(a.memberIds[0], 'select id from public.notifications')).toEqual([]);
  });

  it('read-state asymmetry: mark_all_notifications_read leaves announcements unread (feeds Q4-4)', async () => {
    const a = await createPack(2);
    await createAnnouncement(a.organizerId, a.communityId);
    const m = a.memberIds[0];
    expect(await asUser(m, (db) => rpc(db, 'mark_all_notifications_read', [a.communityId]))).toBe(1);
    expect(await asUser(m, (db) => rpc(db, 'unread_announcement_count', [a.communityId]))).toBe(1);
  });
});

describe('QA realtime publication', () => {
  it('every published public table has RLS on; no secret-bearing table is published', async () => {
    const { rows } = await admin.query<{ tablename: string; rls: boolean }>(
      `select pt.tablename, c.relrowsecurity as rls
         from pg_publication_tables pt
         join pg_class c on c.relname = pt.tablename and c.relnamespace = 'public'::regnamespace
        where pt.pubname = 'supabase_realtime' and pt.schemaname = 'public'`,
    );
    if (rows.length === 0) return;
    expect(rows.filter((r) => !r.rls).map((r) => r.tablename)).toEqual([]);
    const names = rows.map((r) => r.tablename);
    for (const secret of ['device_push_tokens', 'notification_delivery_jobs', 'notification_preferences', 'announcement_reads', 'invitation_codes']) {
      expect(names).not.toContain(secret);
    }
  });
});
