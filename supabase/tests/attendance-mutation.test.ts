import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { admin, asUser, cancelTraining, closeDb, getSession, hoursFromNow, resetData, updateTraining } from './helpers';
import {
  addWalkIn,
  auditOf,
  confirmedSession,
  finalizeAttendance,
  recordAttendance,
} from './attendance-helpers';
import { errorKey, formOf, waitForBlocked } from './qa-helpers';

/**
 * Mutation checks for attendance rules, in the style of qa-mutation.test.ts: each case breaks
 * ONE rule in the live test database, runs a probe that asserts the rule, and restores the
 * original. The probe must hold on the pristine schema and must notice the mutant.
 */

type Probe = () => Promise<boolean>;

async function rejectsWith(expected: string, op: () => Promise<unknown>): Promise<boolean> {
  try {
    await op();
    return false;
  } catch (error) {
    return errorKey(error) === expected;
  }
}

async function withMutatedFunction<T>(
  signature: string,
  search: string,
  replacement: string,
  fn: () => Promise<T>,
): Promise<T> {
  const { rows } = await admin.query<{ def: string }>('select pg_get_functiondef($1::regprocedure) as def', [
    signature,
  ]);
  const original = rows[0].def;
  expect(original, `${signature} no longer contains: ${search}`).toContain(search);
  await admin.query(original.replaceAll(search, replacement));
  try {
    return await fn();
  } finally {
    await admin.query(original);
  }
}

async function withSql<T>(breakSql: string, restoreSql: string, fn: () => Promise<T>): Promise<T> {
  await admin.query(breakSql);
  try {
    return await fn();
  } finally {
    await admin.query(restoreSql);
  }
}

// Probes ---------------------------------------------------------------------------------------

const notEndedIsRejected: Probe = async () => {
  const { organizerId, memberIds, session } = await confirmedSession(1, 1, { ended: false });
  return rejectsWith('P0001:session_not_ended', () => recordAttendance(organizerId, session.id, memberIds[0], 'present'));
};

const cancelledTakesNoAttendance: Probe = async () => {
  const { organizerId, memberIds, session } = await confirmedSession(1, 1);
  await admin.query(
    "update public.training_sessions set status = 'cancelled', cancel_reason = 'organizer', cancelled_at = now() where id = $1",
    [session.id],
  );
  return rejectsWith('P0001:session_not_confirmed', () => recordAttendance(organizerId, session.id, memberIds[0], 'present'));
};

const removedMemberGetsNoNewRecord: Probe = async () => {
  const { organizerId, memberIds, session } = await confirmedSession(1, 1);
  await admin.query("update public.memberships set status = 'removed' where user_id = $1", [memberIds[0]]);
  return rejectsWith('P0001:attendee_not_a_member', () => recordAttendance(organizerId, session.id, memberIds[0], 'present'));
};

const repeatedMarkWritesNoAudit: Probe = async () => {
  const { organizerId, memberIds, session } = await confirmedSession(1, 1);
  await recordAttendance(organizerId, session.id, memberIds[0], 'present');
  await recordAttendance(organizerId, session.id, memberIds[0], 'present');
  return (await auditOf(session.id)).length === 1;
};

const memberCannotMark: Probe = async () => {
  const { memberIds, session } = await confirmedSession(2, 2);
  return rejectsWith('P0001:forbidden', () => recordAttendance(memberIds[0], session.id, memberIds[1], 'absent'));
};

const memberSeesOnlyOwnRecords: Probe = async () => {
  const { organizerId, memberIds, session } = await confirmedSession(2, 2);
  await recordAttendance(organizerId, session.id, memberIds[0], 'present');
  await recordAttendance(organizerId, session.id, memberIds[1], 'absent');
  const { rows } = await asUser(memberIds[0], (db) =>
    db.query<{ user_id: string }>('select user_id from public.attendance_records'),
  );
  return rows.length === 1 && rows[0].user_id === memberIds[0];
};

const goingMemberIsNotAWalkIn: Probe = async () => {
  const { organizerId, memberIds, session } = await confirmedSession(1, 1);
  return rejectsWith('P0001:attendee_has_going_rsvp', () => addWalkIn(organizerId, session.id, memberIds[0]));
};

/** The organizer is removed while `run` waits for the session lock; the call must be refused. */
async function refusedAfterRemovalMidWait(
  fragment: string,
  run: (organizerId: string, sessionId: string, memberIds: string[]) => Promise<unknown>,
): Promise<boolean> {
  const { organizerId, memberIds, session } = await confirmedSession(1, 1);
  const gate = await admin.connect();
  let result: Promise<string> = Promise.resolve('not started');
  try {
    await gate.query('begin');
    await gate.query('select 1 from public.training_sessions where id = $1 for update', [session.id]);
    result = run(organizerId, session.id, memberIds).then(() => 'ok', errorKey);
    await waitForBlocked(fragment);
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [organizerId]);
    await gate.query('commit');
  } finally {
    await gate.query('rollback');
    gate.release();
  }
  return (await result) === 'P0001:forbidden';
}

const markRefusedAfterRemovalMidWait: Probe = () =>
  refusedAfterRemovalMidWait('record_attendance', (o, s, m) => recordAttendance(o, s, m[0], 'present'));

const cancelRefusedAfterRemovalMidWait: Probe = () =>
  refusedAfterRemovalMidWait('cancel_training', (o, s) => cancelTraining(o, s));

const sessionWithAttendanceIsNotCancellable: Probe = async () => {
  const { organizerId, memberIds, session } = await confirmedSession(1, 1);
  await recordAttendance(organizerId, session.id, memberIds[0], 'absent');
  return rejectsWith('P0001:session_has_attendance', () => cancelTraining(organizerId, session.id));
};

const endedSessionTimesAreFrozen: Probe = async () => {
  const { organizerId, session } = await confirmedSession(1, 1);
  const current = await getSession(session.id);
  return rejectsWith('P0001:validation_failed:ends_at', () =>
    updateTraining(organizerId, session.id, formOf(current, { ends_at: hoursFromNow(24) })),
  );
};

const runningSessionWithoutEndIsNotEnded: Probe = async () => {
  const { organizerId, memberIds, session } = await confirmedSession(1, 1, { ended: false });
  await admin.query(
    `update public.training_sessions
     set rsvp_deadline = now() - interval '3 hours', starts_at = now() - interval '1 hour', ends_at = null
     where id = $1`,
    [session.id],
  );
  return rejectsWith('P0001:session_not_ended', () => recordAttendance(organizerId, session.id, memberIds[0], 'present'));
};

/** finalize_attendance and the deletion of a going member's account, racing on a held session. */
const finalizeDoesNotDeadlockWithDeletion: Probe = async () => {
  const { organizerId, memberIds, session } = await confirmedSession(1, 1);
  const gate = await admin.connect();
  let results: Promise<string>[] = [];
  try {
    await gate.query('begin');
    await gate.query('select 1 from public.training_sessions where id = $1 for update', [session.id]);
    const finalizeCall = finalizeAttendance(organizerId, session.id).then(() => 'ok', errorKey);
    await waitForBlocked('finalize_attendance');
    const deletion = admin.query('delete from auth.users where id = $1', [memberIds[0]]).then(() => 'ok', errorKey);
    await waitForBlocked('delete from auth.users');
    results = [finalizeCall, deletion];
    await gate.query('commit');
  } finally {
    await gate.query('rollback');
    gate.release();
  }
  const outcome = await Promise.all(results);
  return outcome.every((r) => r === 'ok');
};

// Mutants --------------------------------------------------------------------------------------

const RECORD = 'public.record_attendance(uuid, uuid, public.attendance_status, text)';
const LOCK_SESSION = 'private.lock_session_for_attendance(uuid)';
const POLICY = 'attendance_records_select_own_or_organizer';
const CANCEL = 'public.cancel_training(uuid, text)';
const UPDATE = 'public.update_training(uuid, jsonb)';
const SESSION_ENDED = 'private.session_ended(timestamptz, timestamptz, timestamptz)';

const MUTANTS: [string, Probe, (probe: Probe) => Promise<boolean>][] = [
  [
    'attendance before the end of the session',
    notEndedIsRejected,
    (probe) =>
      withMutatedFunction(
        LOCK_SESSION,
        'not private.session_ended(v_session.starts_at, v_session.ends_at, clock_timestamp())',
        'false',
        probe,
      ),
  ],
  [
    'attendance on any session status',
    cancelledTakesNoAttendance,
    (probe) => withMutatedFunction(LOCK_SESSION, "v_session.status not in ('confirmed', 'completed')", 'false', probe),
  ],
  [
    'new records for removed members',
    removedMemberGetsNoNewRecord,
    (probe) => withMutatedFunction(RECORD, "v_member_status is distinct from 'active'", 'false', probe),
  ],
  [
    'a repeated mark counted as a change',
    repeatedMarkWritesNoAudit,
    // The early return is what makes a repeated mark a no-op: without it the record is
    // rewritten and, with old = new, the audit guard must still keep the log clean. Breaking
    // the guard as well must be noticed, either by the probe or by the table check.
    (probe) =>
      withMutatedFunction(RECORD, 'if v_old = p_status then', 'if false then', () =>
        withMutatedFunction(RECORD, 'if v_old <> p_status then', "if v_old <> p_status or p_status = 'present' then", () =>
          withSql(
            'alter table public.attendance_audit_log drop constraint attendance_audit_log_change_check',
            'delete from public.attendance_audit_log where old_status = new_status; ' +
              'alter table public.attendance_audit_log add constraint attendance_audit_log_change_check check (old_status <> new_status)',
            probe,
          ),
        ),
      ),
  ],
  [
    'is_organizer without the role check (attendance)',
    memberCannotMark,
    (probe) => withMutatedFunction('public.is_organizer(uuid)', "and m.role = 'organizer'", '', probe),
  ],
  [
    'attendance_records readable by every active member',
    memberSeesOnlyOwnRecords,
    (probe) =>
      withSql(
        `alter policy ${POLICY} on public.attendance_records using (public.is_active_member(community_id))`,
        `alter policy ${POLICY} on public.attendance_records using (
           (user_id = (select auth.uid()) and public.is_active_member(community_id))
           or public.is_organizer(community_id))`,
        probe,
      ),
  ],
  [
    'finalize_attendance without the profile locks (lock order)',
    finalizeDoesNotDeadlockWithDeletion,
    (probe) =>
      withMutatedFunction('public.finalize_attendance(uuid)', 'order by p.id\n  for key share;', 'order by p.id;', probe),
  ],
  [
    'attendance without the organizer re-check after the lock wait',
    markRefusedAfterRemovalMidWait,
    (probe) =>
      withMutatedFunction(LOCK_SESSION, 'if not public.is_organizer(v_session.community_id) then', 'if false then', probe),
  ],
  [
    'cancel_training without the organizer re-check after the lock wait',
    cancelRefusedAfterRemovalMidWait,
    (probe) =>
      withMutatedFunction(
        CANCEL,
        '-- Re-checked after the lock wait: the caller may have been removed or demoted meanwhile.\n  if not public.is_organizer(v_community_id) then',
        'if false then',
        probe,
      ),
  ],
  [
    'cancel_training on a session with attendance',
    sessionWithAttendanceIsNotCancellable,
    (probe) => withMutatedFunction(CANCEL, "and a.status in ('present', 'absent')", 'and false', probe),
  ],
  [
    'update_training that moves the times of an ended confirmed session',
    endedSessionTimesAreFrozen,
    (probe) => withMutatedFunction(UPDATE, "if v_session.status = 'confirmed'", 'if false', probe),
  ],
  [
    'a session without an end counted as ended at its start',
    runningSessionWithoutEndIsNotEnded,
    (probe) => withMutatedFunction(SESSION_ENDED, "p_starts_at + interval '2 hours'", 'p_starts_at', probe),
  ],
  [
    'walk-in for a going member',
    goingMemberIsNotAWalkIn,
    (probe) =>
      withMutatedFunction(
        'public.add_walk_in_attendee(uuid, uuid)',
        "raise exception using errcode = 'P0001', message = 'attendee_has_going_rsvp';",
        'null;',
        probe,
      ),
  ],
];

beforeEach(resetData);
afterAll(closeDb);

describe('attendance mutation checks', () => {
  it.each(MUTANTS)('%s is noticed', async (_name, probe, mutate) => {
    expect(await probe(), 'the rule holds on the pristine schema').toBe(true);
    await resetData();
    expect(await mutate(probe), 'the probe notices the mutant').toBe(false);
    await resetData();
    expect(await probe(), 'the rule holds again after the mutant is reverted').toBe(true);
  });

  it('leaves the attendance policy as the migration created it', async () => {
    const { rows } = await admin.query<{ qual: string }>(
      `select qual from pg_policies where policyname = '${POLICY}'`,
    );
    expect(rows[0].qual).toContain('auth.uid()');
    expect(rows[0].qual).toContain('is_organizer');
  });
});
