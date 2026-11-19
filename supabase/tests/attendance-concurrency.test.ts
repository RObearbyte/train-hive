import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { addMember, admin, closeDb, countRows, getSession, resetData } from './helpers';
import {
  addWalkIn,
  type AttendanceStatus,
  auditOf,
  confirmedSession,
  finalizeAttendance,
  recordAttendance,
  recordsOf,
} from './attendance-helpers';
import { errorKey, Outcomes, waitForBlocked } from './qa-helpers';

/**
 * Attendance under concurrency. A test-only trigger (schema `qa_attendance`, installed and
 * dropped by this file) records every real status change of attendance_records as the writer
 * saw it. The audit log must contain exactly those changes: one row per real change, none for
 * no-ops, none missing.
 */

const STATUSES: AttendanceStatus[] = ['present', 'absent', 'unrecorded'];

async function installChangeTrace(): Promise<void> {
  await admin.query(`
    create schema if not exists qa_attendance;
    drop trigger if exists zz_qa_attendance_trace on public.attendance_records;
    drop table if exists qa_attendance.changes;
    create table qa_attendance.changes (
      seq bigserial primary key,
      session_id uuid not null,
      user_id uuid not null,
      old_status text not null,
      new_status text not null
    );
    create or replace function qa_attendance.trace() returns trigger
    language plpgsql security definer set search_path = '' as $fn$
    declare
      v_old text := case when tg_op = 'INSERT' then 'unrecorded' else old.status::text end;
    begin
      if v_old <> new.status::text then
        insert into qa_attendance.changes (session_id, user_id, old_status, new_status)
        values (new.session_id, new.user_id, v_old, new.status::text);
      end if;
      return null;
    end;
    $fn$;
    create trigger zz_qa_attendance_trace
      after insert or update on public.attendance_records
      for each row execute function qa_attendance.trace();
  `);
}

async function removeChangeTrace(): Promise<void> {
  await admin.query(`
    drop trigger if exists zz_qa_attendance_trace on public.attendance_records;
    drop schema if exists qa_attendance cascade;
  `);
}

/** Real changes (from the trace) and audit rows of a session, in the same shape and order. */
async function changesAndAudit(sessionId: string): Promise<{ changes: string[]; audit: string[] }> {
  const { rows: changes } = await admin.query<{ line: string }>(
    `select user_id || ' ' || old_status || '->' || new_status as line
     from qa_attendance.changes where session_id = $1 order by user_id, seq`,
    [sessionId],
  );
  const { rows: audit } = await admin.query<{ line: string }>(
    `select user_id || ' ' || old_status || '->' || new_status as line
     from public.attendance_audit_log where session_id = $1 order by user_id, changed_at, id`,
    [sessionId],
  );
  return { changes: changes.map((r) => r.line), audit: audit.map((r) => r.line) };
}

/** Per member, the audit rows form an unbroken chain from `unrecorded` to the stored status. */
async function brokenChains(sessionId: string): Promise<string[]> {
  const records = new Map((await recordsOf(sessionId)).map((r) => [r.user_id, r.status]));
  const audit = await auditOf(sessionId);
  const problems: string[] = [];
  const byUser = new Map<string, typeof audit>();
  for (const row of audit) byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row]);
  for (const [userId, rows] of byUser) {
    let state: AttendanceStatus = 'unrecorded';
    for (const row of rows) {
      if (row.old_status !== state) problems.push(`${userId}: expected old ${state}, got ${row.old_status}`);
      state = row.new_status;
    }
    if (records.get(userId) !== state) problems.push(`${userId}: chain ends at ${state}, row is ${records.get(userId)}`);
  }
  for (const [userId, status] of records) {
    if (!byUser.has(userId) && status !== 'unrecorded') problems.push(`${userId}: ${status} without audit`);
  }
  return problems;
}

const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];

beforeAll(installChangeTrace);
afterAll(async () => {
  await removeChangeTrace();
  await closeDb();
});
beforeEach(resetData);
afterEach(() => admin.query('truncate table qa_attendance.changes'));

describe('attendance concurrency', () => {
  it('concurrent finalize calls: one completion, no duplicate rows, identical results', async () => {
    const { organizerId, session, communityId } = await confirmedSession(5, 5);
    const second = await addMember(communityId, { role: 'organizer', name: 'Second Organizer' });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => finalizeAttendance(i % 2 === 0 ? organizerId : second, session.id)),
    );

    const stamps = new Set(results.map((r) => `${r.status} ${r.attendance_finalized_at!.toISOString()} ${r.attendance_finalized_by}`));
    expect(stamps.size).toBe(1);
    expect(results[0].status).toBe('completed');
    expect(await countRows('attendance_records', 'session_id = $1', [session.id])).toBe(5);
    expect(await countRows('attendance_audit_log')).toBe(0);
  });

  it('concurrent identical marks create one row and one audit row', async () => {
    const { organizerId, memberIds, session, communityId } = await confirmedSession(1, 1);
    const second = await addMember(communityId, { role: 'organizer', name: 'Second Organizer' });

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        recordAttendance(i % 2 === 0 ? organizerId : second, session.id, memberIds[0], 'present'),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await countRows('attendance_records')).toBe(1);
    expect(await auditOf(session.id)).toHaveLength(1);
  });

  it('concurrent identical walk-ins create one row and one audit row', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(2, 1);
    const results = await Promise.all(Array.from({ length: 10 }, () => addWalkIn(organizerId, session.id, memberIds[1])));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect((await auditOf(session.id)).map((a) => a.action)).toEqual(['walk_in_add']);
  });

  it('a randomized storm of marks, walk-ins and finalizations: one row per member, one audit row per real change', async () => {
    for (let round = 0; round < 3; round += 1) {
      await resetData();
      await admin.query('truncate table qa_attendance.changes');
      const { organizerId, memberIds, session, communityId } = await confirmedSession(6, 4);
      const second = await addMember(communityId, { role: 'organizer', name: 'Second Organizer' });
      const going = memberIds.slice(0, 4);
      const candidates = memberIds.slice(4);
      const outcomes = new Outcomes();
      const allowed = /^P0001:no_going_rsvp$/;

      const ops = Array.from({ length: 60 }, (_, i) => {
        const caller = i % 2 === 0 ? organizerId : second;
        const roll = Math.random();
        if (roll < 0.1) return () => outcomes.run('finalize', allowed, () => finalizeAttendance(caller, session.id));
        if (roll < 0.25) return () => outcomes.run('walk_in', allowed, () => addWalkIn(caller, session.id, pick(candidates)));
        const target = roll < 0.35 ? pick(candidates) : pick(going);
        return () => outcomes.run('record', allowed, () => recordAttendance(caller, session.id, target, pick(STATUSES)));
      });
      await Promise.all(ops.map((op) => op()));
      // Finalize at the end in case the storm never did.
      await finalizeAttendance(organizerId, session.id);

      expect(outcomes.unexpected, `round ${round}`).toEqual([]);
      const records = await recordsOf(session.id);
      expect(new Set(records.map((r) => r.user_id)).size).toBe(records.length);
      // Every going member is listed after finalization.
      for (const m of going) expect(records.some((r) => r.user_id === m), m).toBe(true);
      const { changes, audit } = await changesAndAudit(session.id);
      expect(audit, `round ${round}`).toEqual(changes);
      expect(await brokenChains(session.id)).toEqual([]);
      expect((await getSession(session.id)).status).toBe('completed');
    }
  });

  it('finalize vs deleting a going member\'s account: no deadlock, both complete', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(2, 2);
    const victim = memberIds[0];

    const gate = await admin.connect();
    let finalizeResult: Promise<string>;
    let deletion: Promise<string>;
    try {
      await gate.query('begin');
      await gate.query('select 1 from public.training_sessions where id = $1 for update', [session.id]);
      finalizeResult = finalizeAttendance(organizerId, session.id).then(() => 'ok', errorKey);
      await waitForBlocked('finalize_attendance');
      deletion = admin.query('delete from auth.users where id = $1', [victim]).then(() => 'ok', errorKey);
      await waitForBlocked('delete from auth.users');
      await gate.query('commit');
    } finally {
      await gate.query('rollback');
      gate.release();
    }
    expect(await Promise.all([finalizeResult, deletion])).toEqual(['ok', 'ok']);
    // GDPR G2: the deleted member's row stays, anonymous (user_id null; sorted last).
    expect((await recordsOf(session.id)).map((r) => r.user_id)).toEqual([memberIds[1], null]);
    expect((await getSession(session.id)).status).toBe('completed');
  });

  it('record vs deleting the attendee\'s account: no deadlock, both complete', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1);
    const victim = memberIds[0];

    const gate = await admin.connect();
    let recordResult: Promise<string>;
    let deletion: Promise<string>;
    try {
      await gate.query('begin');
      await gate.query('select 1 from public.training_sessions where id = $1 for update', [session.id]);
      recordResult = recordAttendance(organizerId, session.id, victim, 'present').then(() => 'ok', errorKey);
      await waitForBlocked('record_attendance');
      deletion = admin.query('delete from auth.users where id = $1', [victim]).then(() => 'ok', errorKey);
      await waitForBlocked('delete from auth.users');
      await gate.query('commit');
    } finally {
      await gate.query('rollback');
      gate.release();
    }
    expect(await Promise.all([recordResult, deletion])).toEqual(['ok', 'ok']);
    // GDPR G2: the record and its audit row stay, anonymous.
    expect(await countRows('attendance_records', 'user_id is null')).toBe(1);
    expect(await countRows('attendance_audit_log', 'user_id is null')).toBe(1);
    expect(await countRows('attendance_records', 'user_id is not null')).toBe(0);
  });

  it('record vs removing the attendee: serialized on the membership row in both orders', async () => {
    // Removal commits first: the waiting record call sees it.
    {
      const { organizerId, memberIds, session } = await confirmedSession(1, 1);
      const target = memberIds[0];
      const gate = await admin.connect();
      let recordResult: Promise<string>;
      try {
        await gate.query('begin');
        await gate.query("update public.memberships set status = 'removed' where user_id = $1", [target]);
        recordResult = recordAttendance(organizerId, session.id, target, 'present').then(() => 'ok', errorKey);
        await waitForBlocked('record_attendance');
        await gate.query('commit');
      } finally {
        await gate.query('rollback');
        gate.release();
      }
      expect(await recordResult).toBe('P0001:attendee_not_a_member');
      expect(await countRows('attendance_records')).toBe(0);
    }
    await resetData();
    // Record holds the membership first: the removal waits for it, and the record stands.
    {
      const { organizerId, memberIds, session } = await confirmedSession(1, 1);
      const target = memberIds[0];
      const gate = await admin.connect();
      let recordResult: Promise<string>;
      let removal: Promise<string>;
      try {
        await gate.query('begin');
        await gate.query('select 1 from public.training_sessions where id = $1 for update', [session.id]);
        recordResult = recordAttendance(organizerId, session.id, target, 'present').then(() => 'ok', errorKey);
        await waitForBlocked('record_attendance');
        removal = admin
          .query("update public.memberships set status = 'removed' where user_id = $1", [target])
          .then(() => 'ok', errorKey);
        await waitForBlocked("set status = 'removed'");
        await gate.query('commit');
      } finally {
        await gate.query('rollback');
        gate.release();
      }
      expect(await Promise.all([recordResult, removal])).toEqual(['ok', 'ok']);
      expect((await recordsOf(session.id)).map((r) => r.status)).toEqual(['present']);
    }
  });

  it('a mark that waited for the lock is checked against the real time, not its start time', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1, { ended: false });
    // Ends 400 ms from now; the call starts now and waits 800 ms for the session row.
    await admin.query(
      `update public.training_sessions
       set rsvp_deadline = clock_timestamp() - interval '2 hours',
           starts_at = clock_timestamp() - interval '1 hour',
           ends_at = clock_timestamp() + interval '400 milliseconds'
       where id = $1`,
      [session.id],
    );
    const gate = await admin.connect();
    let recordResult: Promise<string>;
    try {
      await gate.query('begin');
      await gate.query('select 1 from public.training_sessions where id = $1 for update', [session.id]);
      recordResult = asUserRecordInOneTransaction(organizerId, session.id, memberIds[0]);
      await waitForBlocked('record_attendance');
      await new Promise((resolve) => setTimeout(resolve, 800));
      await gate.query('commit');
    } finally {
      await gate.query('rollback');
      gate.release();
    }
    // now() (transaction start) was before the end; clock_timestamp() after the wait is not.
    expect(await recordResult).toBe('ok');
  });
});

/**
 * Starts a transaction BEFORE the session ends (so now() is before ends_at), then records.
 * The call must succeed because the real time after the lock wait is past the end.
 */
async function asUserRecordInOneTransaction(organizerId: string, sessionId: string, attendeeId: string): Promise<string> {
  const client = await admin.connect();
  try {
    await client.query("select set_config('request.jwt.claims', $1, false)", [
      JSON.stringify({ sub: organizerId, role: 'authenticated' }),
    ]);
    await client.query('set role authenticated');
    await client.query('begin');
    await client.query("select public.record_attendance($1, $2, 'present')", [sessionId, attendeeId]);
    await client.query('commit');
    return 'ok';
  } catch (error) {
    return errorKey(error);
  } finally {
    await client.query('rollback');
    await client.query('reset role');
    client.release();
  }
}
