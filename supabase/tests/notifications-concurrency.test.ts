import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addMember,
  admin,
  asService,
  asUser,
  cancelTraining,
  closeDb,
  countRows,
  createPack,
  createTraining,
  finalize,
  getSession,
  makeDue,
  resetData,
  rpc,
  type RsvpResponse,
  type Session,
  setRsvp,
  updateTraining,
} from './helpers';
import {
  cancelAnnouncement,
  claimJobs,
  completeJob,
  createAnnouncement,
  enqueueReminders,
  expoToken,
  makeAnnouncementDue,
  publishDue,
  recipients,
  registerToken,
  sorted,
} from './notifications-helpers';
import { errorKey, formOf, Outcomes, waitForBlocked } from './qa-helpers';

beforeEach(resetData);
afterAll(closeDb);

describe('training notifications under concurrency', () => {
  it('concurrent finalizer runs decide and notify each session exactly once', async () => {
    const p = await createPack(4);
    const sessions = [];
    for (let i = 0; i < 6; i += 1) {
      const s = await createTraining(p.organizerId, p.communityId, { title: `Run ${i}`, min_participants: 2 });
      // Even sessions reach the minimum, odd ones do not.
      await setRsvp(p.memberIds[0], s.id, 'going');
      if (i % 2 === 0) await setRsvp(p.memberIds[1], s.id, 'going');
      await makeDue(s.id);
      sessions.push(s);
    }
    const decided = await Promise.all(Array.from({ length: 8 }, () => finalize()));
    expect(decided.reduce((a, b) => a + b, 0)).toBe(6);
    await finalize();

    for (const [i, s] of sessions.entries()) {
      if (i % 2 === 0) {
        expect(await recipients('training_confirmed', s.id)).toEqual(sorted([p.organizerId, p.memberIds[0], p.memberIds[1]]));
        expect(await recipients('training_cancelled', s.id)).toEqual([]);
      } else {
        expect(await recipients('training_cancelled', s.id)).toEqual(sorted([p.organizerId, ...p.memberIds]));
        expect(await recipients('training_confirmed', s.id)).toEqual([]);
      }
    }
    expect(await countRows('notification_delivery_jobs')).toBe(await countRows('notifications'));
  });

  it('organizer cancel racing the finalizer: one decision, its notification once', async () => {
    for (let round = 0; round < 4; round += 1) {
      await resetData();
      const p = await createPack(3);
      const s = await createTraining(p.organizerId, p.communityId, { min_participants: 1 });
      await setRsvp(p.memberIds[0], s.id, 'going');
      await makeDue(s.id);
      const results = await Promise.all([
        cancelTraining(p.organizerId, s.id).then(() => 'ok', errorKey),
        finalize().then(String, errorKey),
        finalize().then(String, errorKey),
      ]);
      expect(results.filter((r) => r.startsWith('40'))).toEqual([]);
      const stored = await getSession(s.id);
      expect(stored.status).toBe('cancelled');
      expect(await recipients('training_cancelled', s.id)).toHaveLength(stored.cancel_reason === 'organizer' ? 3 : 4);
      const confirmed = await recipients('training_confirmed', s.id);
      // Confirmed first (finalizer won), then cancelled by the organizer; or cancelled directly.
      expect(confirmed.length === 0 || confirmed.length === 2).toBe(true);
      const dupes = await admin.query('select user_id, kind, count(*) from public.notifications group by 1, 2 having count(*) > 1');
      expect(dupes.rows).toEqual([]);
    }
  });

  it('concurrent material edits: every committed edit notifies once', async () => {
    const p = await createPack(3);
    const s = await createTraining(p.organizerId, p.communityId);
    const second = await addMember(p.communityId, { role: 'organizer', name: 'Second' });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        updateTraining(i % 2 === 0 ? p.organizerId : second, s.id, formOf(s, { location_name: `Place ${i}` })).then(() => 'ok', errorKey),
      ),
    );
    expect(results).toEqual(Array(6).fill('ok'));
    // Each edit's recipients: everyone but its editor (3 members + the other organizer).
    expect(await countRows('notifications', "kind = 'training_updated'")).toBe(6 * 4);
    const keys = await admin.query("select count(distinct dedupe_key)::int as n from public.notifications where kind = 'training_updated'");
    expect(keys.rows[0].n).toBe(6);
  });

  it('cancel vs deleting a member\'s account while the session is locked: no deadlock, no orphan', async () => {
    const p = await createPack(2);
    const s = await createTraining(p.organizerId, p.communityId, { min_participants: 1 });
    const victim = p.memberIds[0];
    await setRsvp(victim, s.id, 'going');

    const gate = await admin.connect();
    let cancel: Promise<string>;
    let deletion: Promise<string>;
    try {
      await gate.query('begin');
      await gate.query('select 1 from public.training_sessions where id = $1 for update', [s.id]);
      cancel = cancelTraining(p.organizerId, s.id).then(() => 'ok', errorKey);
      await waitForBlocked('cancel_training');
      // The deletion locks the profile, then waits for the session (RSVP release / uncount).
      deletion = admin.query('delete from auth.users where id = $1', [victim]).then(() => 'ok', errorKey);
      await waitForBlocked('delete from auth.users');
      await gate.query('commit');
    } finally {
      await gate.query('rollback');
      gate.release();
    }
    expect(await Promise.all([cancel, deletion])).toEqual(['ok', 'ok']);
    expect(await recipients('training_cancelled', s.id)).toEqual([p.memberIds[1]]);
    expect(await countRows('notifications', 'user_id = $1', [victim])).toBe(0);
  });

  it('finalizer vs member removal and account deletion: no deadlock', async () => {
    for (let round = 0; round < 3; round += 1) {
      await resetData();
      const p = await createPack(6);
      const sessions = [];
      for (let i = 0; i < 3; i += 1) {
        const s = await createTraining(p.organizerId, p.communityId, { min_participants: 2 });
        for (const id of p.memberIds) await setRsvp(id, s.id, 'going');
        await makeDue(s.id);
        sessions.push(s);
      }
      const outcomes = new Outcomes();
      await Promise.all([
        outcomes.run('finalize', /^$/, () => finalize()),
        outcomes.run('remove', /^$/, () => admin.query("update public.memberships set status = 'removed' where user_id = $1", [p.memberIds[0]])),
        outcomes.run('delete', /^$/, () => admin.query('delete from auth.users where id = $1', [p.memberIds[1]])),
        outcomes.run('delete', /^$/, () => admin.query('delete from auth.users where id = $1', [p.memberIds[2]])),
        outcomes.run('finalize', /^$/, () => finalize()),
      ]);
      expect(outcomes.unexpected, `round ${round}`).toEqual([]);
      for (const s of sessions) expect((await getSession(s.id)).status).toBe('confirmed');
    }
  });
});

describe('deadlock probe: training edits, announcements, claims, reminders, removal and deletion', () => {
  it('a mixed storm finishes with business errors only and consistent outbox state', async () => {
    for (let round = 0; round < 3; round += 1) {
      await resetData();
      const p = await createPack(8);
      const second = await addMember(p.communityId, { role: 'organizer', name: 'Second Organizer' });
      for (const id of p.memberIds) await registerToken(id, expoToken(`${round}-${id}`));
      const open = await createTraining(p.organizerId, p.communityId, { min_participants: 1 });
      const due = await createTraining(p.organizerId, p.communityId, { min_participants: 2 });
      const confirmed = await createTraining(p.organizerId, p.communityId, { min_participants: 1 });
      for (const id of p.memberIds.slice(0, 4)) {
        await setRsvp(id, due.id, 'going');
        await setRsvp(id, confirmed.id, 'going');
      }
      await makeDue(due.id);
      await makeDue(confirmed.id);
      await finalize();
      // Bring both decided-or-due sessions into the reminder window.
      await admin.query("update public.training_sessions set starts_at = now() + interval '90 minutes', ends_at = null where id = $1", [confirmed.id]);
      const scheduled: { id: string }[] = [];
      for (let i = 0; i < 4; i += 1) {
        const a = await createAnnouncement(p.organizerId, p.communityId, { title: `Planned ${i}`, scheduledFor: new Date(Date.now() + 3_600_000).toISOString() });
        await makeAnnouncementDue(a.id);
        scheduled.push(a);
      }
      // `due` was decided by the finalizer above; make a fresh due one for this storm.
      const late = await createTraining(p.organizerId, p.communityId, { min_participants: 3 });
      for (const id of p.memberIds.slice(2, 6)) await setRsvp(id, late.id, 'going');
      await makeDue(late.id);
      // The forms an organizer would send now (after the time travel above).
      const forms = new Map<string, Session>();
      for (const s of [open, confirmed, late]) forms.set(s.id, await getSession(s.id));

      const allowed =
        /^P0001:(session_not_editable|session_not_cancellable|rsvp_closed|not_a_member|session_full|announcement_not_cancellable|not_found)$/;
      const outcomes = new Outcomes();
      const pick = <T,>(items: T[]): T => items[Math.floor(Math.random() * items.length)];
      const organizers = [p.organizerId, second];
      const ops: (() => Promise<unknown>)[] = [];
      for (let i = 0; i < 60; i += 1) {
        const roll = Math.random();
        if (roll < 0.15) {
          const target = pick([open, confirmed, late]);
          ops.push(() => outcomes.run('edit', allowed, () => updateTraining(pick(organizers), target.id, formOf(forms.get(target.id)!, { location_name: `Spot ${i}` }))));
        } else if (roll < 0.2) {
          ops.push(() => outcomes.run('cancel', allowed, () => cancelTraining(pick(organizers), pick([open, late]).id)));
        } else if (roll < 0.35) {
          ops.push(() => outcomes.run('rsvp', allowed, () => setRsvp(pick(p.memberIds), open.id, pick<RsvpResponse>(['going', 'not_going', 'no_response']))));
        } else if (roll < 0.42) {
          ops.push(() => outcomes.run('finalize', allowed, () => finalize()));
        } else if (roll < 0.5) {
          ops.push(() => outcomes.run('publish', allowed, () => publishDue()));
        } else if (roll < 0.55) {
          ops.push(() => outcomes.run('announce', allowed, () => createAnnouncement(pick(organizers), p.communityId, { title: `Now ${i}` })));
        } else if (roll < 0.6) {
          ops.push(() => outcomes.run('cancel_announcement', allowed, () => cancelAnnouncement(pick(organizers), pick(scheduled).id)));
        } else if (roll < 0.72) {
          ops.push(() =>
            outcomes.run('dispatch', allowed, async () => {
              const claimed = await claimJobs(`w${i}`, 10);
              for (const job of claimed) {
                await completeJob(job.job_id, job.tokens.length > 0 ? pick(['sent', 'failed']) : 'skipped', 'storm');
              }
            }),
          );
        } else if (roll < 0.78) {
          ops.push(() => outcomes.run('reminders', allowed, () => enqueueReminders()));
        } else if (roll < 0.85) {
          ops.push(() => outcomes.run('token', allowed, () => registerToken(pick(p.memberIds), expoToken(`${round}-${i}`))));
        } else if (roll < 0.92) {
          const member = pick(p.memberIds);
          ops.push(() => outcomes.run('read_all', allowed, () => asUser(member, (db) => rpc(db, 'mark_all_notifications_read', [p.communityId]))));
        } else {
          ops.push(() => outcomes.run('purge', allowed, () => asService((db) => rpc(db, 'purge_old_notification_data'))));
        }
      }
      ops.push(() => outcomes.run('remove', /^$/, () => admin.query("update public.memberships set status = 'removed' where user_id = $1", [p.memberIds[6]])));
      ops.push(() => outcomes.run('demote', /^$/, () => admin.query("update public.memberships set role = 'member' where user_id = $1", [second])));
      ops.push(() => outcomes.run('delete', /^$/, () => admin.query('delete from auth.users where id = $1', [p.memberIds[7]])));
      ops.push(() => outcomes.run('delete', /^$/, () => admin.query('delete from auth.users where id = $1', [p.memberIds[3]])));
      ops.sort(() => Math.random() - 0.5);
      // The demoted organizer may legitimately get `forbidden` once the demotion committed.
      const forbiddenOk = new RegExp(`${allowed.source.slice(0, -2)}|forbidden)$`);
      await Promise.all(ops.map((op) => op()));
      const unexpected = outcomes.unexpected.filter((u) => !forbiddenOk.test(u.split(' -> ')[1]));
      expect(unexpected, `round ${round}`).toEqual([]);

      // Outbox invariants.
      expect(await countRows('notification_delivery_jobs')).toBe(await countRows('notifications'));
      const mismatched = await admin.query(
        'select 1 from public.notification_delivery_jobs j join public.notifications n on n.id = j.notification_id where j.user_id <> n.user_id',
      );
      expect(mismatched.rows).toEqual([]);
      const once = await admin.query(
        `select related_session_id, kind, user_id from public.notifications
         where kind in ('training_created', 'training_confirmed', 'training_cancelled', 'announcement_published')
         group by 1, 2, user_id, related_announcement_id having count(*) > 1`,
      );
      expect(once.rows, `round ${round}`).toEqual([]);
      // Nothing for the removed member after removal and nothing visible for the deleted ones
      // once the purge has run.
      await asService((db) => rpc(db, 'purge_old_notification_data'));
      expect(await countRows('notifications', 'user_id = any($1)', [[p.memberIds[7], p.memberIds[3]]])).toBe(0);
    }
  });
});
