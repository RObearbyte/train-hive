import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { exportMyData, referencesTo } from './account-deletion-helpers';
import { confirmedSession, recordAttendance } from './attendance-helpers';
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
  createUser,
  INSUFFICIENT_PRIVILEGE,
  RAISED,
  resetData,
  rpc,
  setRsvp,
} from './helpers';
import { registerToken, expoToken } from './notifications-helpers';
import { errorKey } from './qa-helpers';

/**
 * GDPR G3: retention of inactive anonymous accounts (migration 20261202000100_retention.sql).
 * Disabled by default; when enabled, 24 months without activity gives a notice, and 30 days later
 * a still-inactive account is erased through private.erase_user (the delete_my_account path).
 */

beforeEach(resetData);
afterAll(closeDb);

const DAY = 24 * 3600 * 1000;
const INACTIVE_DAYS = 800; // > 24 months

interface Preview {
  enabled: boolean;
  inactive_after_months: number;
  notice_days: number;
  anonymous_accounts: number;
  inactive_accounts: number;
  inactive_without_notice: number;
  notices_pending: number;
  due_for_erasure: number;
  blocked_last_organizer: number;
  communities_deleted_with_due: number;
  communities_of_inactive_sole_members: number;
  last_run: Record<string, unknown> | null;
}

interface RunResult {
  enabled: boolean;
  notices_created: number;
  notices_cleared: number;
  accounts_erased: number;
  communities_deleted: number;
  blocked_last_organizer: number;
  deferred: number;
  due_remaining: number;
}

interface AppOpen {
  inactivity_erasure_enabled: boolean;
  inactive_after_months: number;
  notice_days: number;
  notice: { noticed_at: string; erase_after: string } | null;
}

const preview = () => asService((db) => rpc<Preview>(db, 'retention_preview'));
const run = () => asService((db) => rpc<RunResult>(db, 'run_account_retention'));
const setEnabled = (enabled: boolean | null) =>
  asService((db) => rpc<{ enabled: boolean; changed: boolean; notices_cleared: number }>(db, 'admin_set_retention_enabled', [enabled]));
const appOpen = (userId: string) => asUser(userId, (db) => rpc<AppOpen>(db, 'record_app_open'));

/**
 * Time travel: moves every trace of the user `days` into the past (auth user, ledger, profile,
 * memberships, RSVPs, attendance, notifications, tokens, ...). session_replication_role = replica
 * skips the ledger's append-only trigger for this fixture update only.
 */
async function ageAccount(userId: string, days = INACTIVE_DAYS): Promise<void> {
  const client = await admin.connect();
  const shift = `${days} days`;
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    const statements = [
      'update auth.users set created_at = created_at - $2::interval, last_sign_in_at = last_sign_in_at - $2::interval where id = $1',
      'update public.consent_records set created_at = created_at - $2::interval where user_id = $1',
      'update public.profiles set created_at = created_at - $2::interval, updated_at = updated_at - $2::interval where id = $1',
      'update public.memberships set joined_at = joined_at - $2::interval where user_id = $1',
      'update public.training_rsvps set responded_at = responded_at - $2::interval, updated_at = updated_at - $2::interval where user_id = $1',
      'update public.attendance_records set recorded_at = recorded_at - $2::interval, updated_at = updated_at - $2::interval where user_id = $1 or recorded_by = $1',
      'update public.notifications set read_at = read_at - $2::interval where user_id = $1',
      'update public.device_push_tokens set created_at = created_at - $2::interval, last_seen_at = last_seen_at - $2::interval where user_id = $1',
      'update public.announcement_reads set read_at = read_at - $2::interval where user_id = $1',
      'update public.event_feed_reads set last_read_at = last_read_at - $2::interval where user_id = $1',
      'update public.event_posts set created_at = created_at - $2::interval where author_id = $1',
      'update public.announcements set created_at = created_at - $2::interval, updated_at = updated_at - $2::interval where author_id = $1',
      'update public.training_sessions set created_at = created_at - $2::interval, updated_at = updated_at - $2::interval where organizer_id = $1',
      'update public.invitation_attempts set attempted_at = attempted_at - $2::interval where user_id = $1',
      'update private.workout_logs set updated_at = updated_at - $2::interval where user_id = $1',
      'update private.member_about_you set updated_at = updated_at - $2::interval where user_id = $1',
      'update private.data_export_log set requested_at = requested_at - $2::interval where user_id = $1',
      'update private.account_activity set last_app_open_at = last_app_open_at - $2::interval where user_id = $1',
    ];
    for (const sql of statements) await client.query(sql, [userId, shift]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** Time travel: the user's inactivity notice started `days` ago. */
async function ageNotice(userId: string, days = 31): Promise<void> {
  await admin.query(
    `update private.account_activity set inactivity_notice_at = now() - $2::interval
     where user_id = $1 and inactivity_notice_at is not null`,
    [userId, `${days} days`],
  );
}

async function lastActivity(userId: string): Promise<Date | null> {
  const { rows } = await admin.query<{ at: Date | null }>('select private.account_last_activity($1) as at', [userId]);
  return rows[0].at;
}

async function notice(userId: string): Promise<Date | null> {
  const { rows } = await admin.query<{ at: Date | null }>(
    'select inactivity_notice_at as at from private.account_activity where user_id = $1',
    [userId],
  );
  return rows[0]?.at ?? null;
}

async function userExists(userId: string): Promise<boolean> {
  const { rows } = await admin.query('select 1 from auth.users where id = $1', [userId]);
  return rows.length === 1;
}

async function snapshotRetentionState(): Promise<string> {
  const { rows } = await admin.query<{ s: string }>(
    `select jsonb_build_object(
       'activity', (select coalesce(jsonb_agg(to_jsonb(a) order by a.user_id), '[]') from private.account_activity a),
       'runs', (select count(*) from private.retention_runs),
       'users', (select count(*) from auth.users),
       'settings', (select to_jsonb(s) from private.retention_settings s)
     )::text as s`,
  );
  return rows[0].s;
}

const cutoffMs = () => Date.now() - 730 * DAY;

describe('retention: privileges', () => {
  it('only service_role reaches preview, job and kill switch; only a user reaches record_app_open', async () => {
    const { organizerId } = await createPack();
    for (const sql of [
      'select public.retention_preview()',
      'select public.run_account_retention()',
      'select public.admin_set_retention_enabled(true)',
    ]) {
      await expect(asAnon((db) => db.query(sql)), sql).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(asUser(organizerId, (db) => db.query(sql)), sql).rejects.toMatchObject({
        code: INSUFFICIENT_PRIVILEGE,
      });
    }
    await expect(asAnon((db) => db.query('select public.record_app_open()'))).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    await expect(asService((db) => db.query('select public.record_app_open()'))).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    // The kill switch stayed off.
    expect((await preview()).enabled).toBe(false);
  });

  it('record_app_open: not_authenticated without a user or for a deleted account', async () => {
    const ghost = await createUser();
    await admin.query('delete from auth.users where id = $1', [ghost]);
    await expect(appOpen(ghost)).rejects.toMatchObject({ code: RAISED, message: 'not_authenticated' });
    await expect(
      asUser('00000000-0000-0000-0000-000000000000', (db) => rpc(db, 'record_app_open')),
    ).rejects.toMatchObject({ code: RAISED, message: 'not_authenticated' });
  });

  it('admin_set_retention_enabled(null) is validation_failed:enabled', async () => {
    await expect(setEnabled(null)).rejects.toMatchObject({ code: RAISED, message: 'validation_failed:enabled' });
  });
});

describe('retention: disabled by default', () => {
  it('the kill switch is off after the migration and nothing is noticed or erased while it is off', async () => {
    const { rows } = await admin.query<{ on: boolean }>(
      'select inactive_erasure_enabled as on from private.retention_settings',
    );
    expect(rows).toEqual([{ on: false }]);

    const { communityId } = await createPack(1);
    const inactive = await addMember(communityId, { name: 'Long Gone' });
    await ageAccount(inactive);
    // Even a notice planted 90 days ago (as if left over) is ignored while disabled.
    await admin.query(
      "insert into private.account_activity (user_id, inactivity_notice_at) values ($1, now() - interval '90 days')",
      [inactive],
    );
    const before = await snapshotRetentionState();

    for (let i = 0; i < 3; i += 1) {
      expect(await run()).toEqual({
        enabled: false,
        notices_created: 0,
        notices_cleared: 0,
        accounts_erased: 0,
        communities_deleted: 0,
        blocked_last_organizer: 0,
        deferred: 0,
        due_remaining: 0,
      });
    }
    expect(await userExists(inactive)).toBe(true);
    expect(await snapshotRetentionState()).toBe(before);
    expect((await preview()).last_run).toBeNull();
  });
});

describe('retention: preview (dry run, counts only)', () => {
  it('counts inactive, noticed, due, blocked and sole-member accounts and writes nothing', async () => {
    // Pack A: active organizer, one active and two inactive members.
    const a = await createPack(1);
    const goneA1 = await addMember(a.communityId, { name: 'Gone A1' });
    const goneA2 = await addMember(a.communityId, { name: 'Gone A2' });
    // Pack B: its only organizer is inactive while an active member remains (blocked).
    const b = await createPack(1);
    // Pack C: one inactive member alone (deleted with the account).
    const c = await createPack(0);
    // An inactive account that never joined anything.
    const neverJoined = await createUser();
    for (const id of [goneA1, goneA2, b.organizerId, c.organizerId, neverJoined]) await ageAccount(id);
    // A linked (non-anonymous) account is out of scope.
    const linked = await createUser();
    await admin.query('update auth.users set is_anonymous = false where id = $1', [linked]);
    await ageAccount(linked);

    for (const id of [goneA1, b.organizerId, neverJoined]) {
      expect((await lastActivity(id))!.getTime()).toBeLessThan(cutoffMs());
    }
    expect((await lastActivity(a.organizerId))!.getTime()).toBeGreaterThan(cutoffMs());

    const before = await snapshotRetentionState();
    const p = await preview();
    expect(p).toMatchObject({
      enabled: false,
      inactive_after_months: 24,
      notice_days: 30,
      anonymous_accounts: 8,
      inactive_accounts: 5,
      inactive_without_notice: 5,
      notices_pending: 0,
      due_for_erasure: 0,
      blocked_last_organizer: 1,
      communities_deleted_with_due: 0,
      communities_of_inactive_sole_members: 1,
      last_run: null,
    });
    expect(await snapshotRetentionState()).toBe(before);
    // Counts only: no id of anyone.
    const text = JSON.stringify(p);
    for (const id of [goneA1, goneA2, b.organizerId, c.organizerId, neverJoined, a.communityId, c.communityId]) {
      expect(text).not.toContain(id);
    }

    // Once enabled and the notices ran out, the preview names what the next run erases.
    await setEnabled(true);
    await run();
    for (const id of [goneA1, goneA2, b.organizerId, c.organizerId, neverJoined]) await ageNotice(id);
    expect(await preview()).toMatchObject({
      enabled: true,
      inactive_accounts: 5,
      inactive_without_notice: 0,
      notices_pending: 5,
      due_for_erasure: 4,
      blocked_last_organizer: 1,
      communities_deleted_with_due: 1,
      last_run: expect.objectContaining({ notices_created: 5, accounts_erased: 0 }),
    });
  });
});

describe('retention: enabled', () => {
  it('erases only truly inactive accounts, after the 30-day notice, like delete_my_account', async () => {
    const { communityId, organizerId, memberIds, session } = await confirmedSession(2, 2);
    const [gone, active] = memberIds;
    await recordAttendance(organizerId, session.id, gone, 'present');
    await recordAttendance(organizerId, session.id, active, 'present');
    await ageAccount(gone);
    expect((await lastActivity(gone))!.getTime()).toBeLessThan(cutoffMs());

    expect(await setEnabled(true)).toEqual({ enabled: true, changed: true, notices_cleared: 0 });

    // Day 0: a notice, no erasure.
    expect(await run()).toMatchObject({ enabled: true, notices_created: 1, accounts_erased: 0 });
    expect(await notice(gone)).not.toBeNull();
    expect(await notice(active)).toBeNull();
    expect(await notice(organizerId)).toBeNull();

    // Day 29: still nothing.
    await ageNotice(gone, 29);
    expect(await run()).toMatchObject({ notices_created: 0, accounts_erased: 0 });
    expect(await userExists(gone)).toBe(true);

    // Day 31: erased.
    await ageNotice(gone, 31);
    const anonymousBefore = await countRows('attendance_records', 'session_id = $1 and user_id is null', [session.id]);
    expect(await run()).toMatchObject({
      enabled: true,
      notices_created: 0,
      notices_cleared: 0,
      accounts_erased: 1,
      communities_deleted: 0,
      blocked_last_organizer: 0,
      deferred: 0,
      due_remaining: 0,
    });
    expect(await userExists(gone)).toBe(false);
    expect(await referencesTo(gone)).toEqual({});
    // Attendance stays, anonymous (same as delete_my_account).
    expect(await countRows('attendance_records', 'session_id = $1 and user_id is null', [session.id])).toBe(
      anonymousBefore + 1,
    );
    expect(await countRows('attendance_records', "session_id = $1 and status = 'present'", [session.id])).toBe(2);
    // Everyone else untouched.
    for (const id of [active, organizerId]) expect(await userExists(id)).toBe(true);
    expect(await countRows('memberships', "community_id = $1 and status = 'active'", [communityId])).toBe(2);
  });

  it('is idempotent: running again right away changes nothing', async () => {
    const { communityId } = await createPack(1);
    const gone = await addMember(communityId, { name: 'Gone' });
    await ageAccount(gone);
    await setEnabled(true);
    await run();
    await ageNotice(gone);
    expect(await run()).toMatchObject({ accounts_erased: 1 });
    const after = await snapshotRetentionState();
    const again = await run();
    expect(again).toMatchObject({
      notices_created: 0,
      notices_cleared: 0,
      accounts_erased: 0,
      communities_deleted: 0,
      due_remaining: 0,
    });
    // Only the run log grew (one more row).
    const state = JSON.parse(await snapshotRetentionState()) as Record<string, unknown>;
    const prior = JSON.parse(after) as Record<string, unknown>;
    expect(state.activity).toEqual(prior.activity);
    expect(state.users).toEqual(prior.users);
    expect(state.runs).toBe((prior.runs as number) + 1);
  });

  type Act = (userId: string, sessionId: string, communityId: string) => Promise<unknown>;
  const acts: [string, Act][] = [
    ['record_app_open', (u) => appOpen(u)],
    ['an RSVP', (u, s) => setRsvp(u, s, 'not_going')],
    ['a push token registration', (u) => registerToken(u, expoToken(u))],
    ['a consent', (u) => asUser(u, (db) => rpc(db, 'record_consent', ['push_notifications']))],
    ['reading notifications', (u, _s, c) => asUser(u, (db) => rpc(db, 'mark_all_notifications_read', [c]))],
    ['a data export', (u) => exportMyData(u)],
  ];

  it.each(acts)('%s after the notice keeps the account and ends the notice', async (_label, act) => {
    const { communityId, organizerId } = await createPack(0);
    const gone = await addMember(communityId, { name: 'Back Again' });
    // The member gets a training_created notification (unread).
    const session = await createTraining(organizerId, communityId);
    const sessionId = session.id;
    await ageAccount(gone);
    expect((await lastActivity(gone))!.getTime()).toBeLessThan(cutoffMs());
    await setEnabled(true);
    await run();
    await ageNotice(gone);
    expect(await notice(gone)).not.toBeNull();

    await act(gone, sessionId, communityId);

    expect((await lastActivity(gone))!.getTime()).toBeGreaterThan(cutoffMs());
    const result = await run();
    expect(result.accounts_erased).toBe(0);
    expect(await userExists(gone)).toBe(true);
    expect(await notice(gone)).toBeNull();
  });

  it('record_app_open returns the pending notice once, then ends it; it writes at most once an hour', async () => {
    const { communityId } = await createPack(0);
    const gone = await addMember(communityId, { name: 'Gone' });
    await ageAccount(gone);
    await setEnabled(true);
    await run();
    const noticedAt = await notice(gone);
    expect(noticedAt).not.toBeNull();

    const first = await appOpen(gone);
    expect(first).toEqual({
      inactivity_erasure_enabled: true,
      inactive_after_months: 24,
      notice_days: 30,
      notice: { noticed_at: expect.any(String), erase_after: expect.any(String) },
    });
    expect(new Date(first.notice!.erase_after).getTime() - new Date(first.notice!.noticed_at).getTime()).toBe(
      30 * DAY,
    );
    expect(await notice(gone)).toBeNull();
    expect((await appOpen(gone)).notice).toBeNull();

    // Throttle: a second open within the hour does not rewrite last_app_open_at.
    const read = async () =>
      (
        await admin.query<{ at: Date }>('select last_app_open_at as at from private.account_activity where user_id = $1', [
          gone,
        ])
      ).rows[0].at.getTime();
    await admin.query(
      "update private.account_activity set last_app_open_at = last_app_open_at - interval '30 minutes' where user_id = $1",
      [gone],
    );
    const halfHourAgo = await read();
    await appOpen(gone);
    expect(await read()).toBe(halfHourAgo);
    await admin.query(
      "update private.account_activity set last_app_open_at = last_app_open_at - interval '2 hours' where user_id = $1",
      [gone],
    );
    await appOpen(gone);
    expect(await read()).toBeGreaterThan(Date.now() - 60_000);

    // The export shows the row; a user who never opened the app has none.
    const ex = await exportMyData(gone);
    expect(ex.extensions.account_activity).toEqual({ last_app_open_at: expect.any(String), inactivity_notice_at: null });
  });

  it('never erases the last organizer of a community with other active members (blocked, notice kept)', async () => {
    const { organizerId, memberIds } = await createPack(1);
    await ageAccount(organizerId);
    await setEnabled(true);
    await run();
    await ageNotice(organizerId);
    expect(await run()).toMatchObject({ accounts_erased: 0, blocked_last_organizer: 1, due_remaining: 0 });
    expect(await userExists(organizerId)).toBe(true);
    expect(await notice(organizerId)).not.toBeNull();
    expect(await userExists(memberIds[0])).toBe(true);
  });

  it('a sole inactive member is erased together with the community (as delete_my_account does)', async () => {
    const { communityId, organizerId } = await createPack(0);
    await ageAccount(organizerId);
    await setEnabled(true);
    await run();
    await ageNotice(organizerId);
    expect(await run()).toMatchObject({ accounts_erased: 1, communities_deleted: 1 });
    expect(await countRows('communities', 'id = $1', [communityId])).toBe(0);
  });

  it('an account that never joined anything is erased too; a linked account never gets a notice', async () => {
    const lone = await createUser();
    const linked = await createUser();
    await admin.query('update auth.users set is_anonymous = false where id = $1', [linked]);
    await ageAccount(lone);
    await ageAccount(linked);
    await setEnabled(true);
    expect(await run()).toMatchObject({ notices_created: 1 });
    expect(await notice(linked)).toBeNull();
    await ageNotice(lone);
    expect(await run()).toMatchObject({ accounts_erased: 1 });
    expect(await userExists(lone)).toBe(false);
    expect(await userExists(linked)).toBe(true);
    expect(await countRows('consent_records', 'user_id = $1', [lone])).toBe(0);
  });

  it('switching off clears every notice; switching on again starts a fresh 30-day window', async () => {
    const { communityId } = await createPack(0);
    const gone = await addMember(communityId, { name: 'Gone' });
    await ageAccount(gone);
    await setEnabled(true);
    await run();
    await ageNotice(gone, 60);

    expect(await setEnabled(false)).toEqual({ enabled: false, changed: true, notices_cleared: 1 });
    expect(await setEnabled(false)).toEqual({ enabled: false, changed: false, notices_cleared: 0 });
    expect(await notice(gone)).toBeNull();
    expect((await run()).enabled).toBe(false);

    expect(await setEnabled(true)).toEqual({ enabled: true, changed: true, notices_cleared: 0 });
    expect(await setEnabled(true)).toEqual({ enabled: true, changed: false, notices_cleared: 0 });
    expect(await run()).toMatchObject({ notices_created: 1, accounts_erased: 0 });
    expect(await userExists(gone)).toBe(true);
  });

  it('record_app_open racing the erasure: the account is either kept or gone, never half-erased', async () => {
    for (let round = 0; round < 4; round += 1) {
      await resetData();
      const { communityId } = await createPack(0);
      const gone = await addMember(communityId, { name: 'Racer' });
      await ageAccount(gone);
      await setEnabled(true);
      await run();
      await ageNotice(gone);

      const [job, open] = await Promise.allSettled([run(), appOpen(gone)]);
      expect(job.status).toBe('fulfilled');
      const erased = (job as PromiseFulfilledResult<RunResult>).value.accounts_erased;
      if (erased === 1) {
        expect(await userExists(gone)).toBe(false);
        expect(await referencesTo(gone)).toEqual({});
        if (open.status === 'rejected') {
          expect(errorKey(open.reason)).toBe(`${RAISED}:not_authenticated`);
        } else {
          // It committed before the job read the due list... and the job still erased? Never.
          throw new Error('record_app_open succeeded but the account was erased');
        }
      } else {
        expect(erased).toBe(0);
        expect(open.status).toBe('fulfilled');
        expect(await userExists(gone)).toBe(true);
        expect(await notice(gone)).toBeNull();
      }
    }
  });
});

describe('retention register (docs/RECORD_OF_PROCESSING.md)', () => {
  it('every table in public and private has a row in the retention register', async () => {
    const doc = readFileSync(path.resolve(__dirname, '..', '..', 'docs', 'RECORD_OF_PROCESSING.md'), 'utf8');
    const { rows } = await admin.query<{ name: string }>(
      `select n.nspname || '.' || c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('public', 'private') and c.relkind in ('r', 'p')
       order by 1`,
    );
    expect(rows.length).toBeGreaterThan(25);
    const missing = rows.map((r) => r.name).filter((name) => !doc.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });
});
