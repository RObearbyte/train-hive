import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addMember,
  admin,
  asUser,
  cancelTraining,
  closeDb,
  createPack,
  createTraining,
  finalize,
  getSession,
  hoursFromNow,
  makeDue,
  resetData,
  setRsvp,
  updateTraining,
} from './helpers';
import {
  addWalkIn,
  attendanceSheet,
  auditOf,
  confirmedSession,
  finalizeAttendance,
  makeEnded,
  recordAttendance,
  recordsOf,
  type AttendanceStatus,
} from './attendance-helpers';
import { errorKey, formOf, Outcomes, raised, waitForBlocked } from './qa-helpers';

/**
 * QA (M2-Q1): independent attendance tests. They target what the developers' suites do not
 * cover: the interplay with the Milestone 1 RPCs (update_training, cancel_training, set_rsvp),
 * lock queues in both orders, a removed organizer whose call was already waiting, snapshot
 * integrity, append-only audit rows, information leakage through joins, the realtime
 * publication, sessions without an end time, and a mixed concurrent storm.
 *
 * `it.fails` tests are demonstrated defects (DEFECT Q3-n, see docs/QA_REPORT.md): they pass
 * while the defect exists and turn red when it is fixed (then remove `.fails`).
 */

beforeEach(resetData);
afterAll(closeDb);

/**
 * Holds the session row lock, starts the steps in order (each one waits for the lock), then
 * releases. Postgres grants the waiting lock requests in arrival order, so the steps run in the
 * order given. Resolves to one outcome per step: 'ok' or `<SQLSTATE>:<message>`.
 */
async function queued(
  sessionId: string,
  steps: { fragment: string; run: () => Promise<unknown> }[],
): Promise<string[]> {
  const gate = await admin.connect();
  const results: Promise<string>[] = [];
  try {
    await gate.query('begin');
    await gate.query('select 1 from public.training_sessions where id = $1 for update', [sessionId]);
    for (const step of steps) {
      results.push(step.run().then(() => 'ok', errorKey));
      await waitForBlocked(step.fragment);
    }
    await gate.query('commit');
  } finally {
    await gate.query('rollback');
    gate.release();
  }
  return Promise.all(results);
}

describe('attendance and update_training (a confirmed, ended session with marks)', () => {
  it('an edit of unrelated fields keeps every record and audit row', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(2, 2);
    await recordAttendance(organizerId, session.id, memberIds[0], 'present');
    await recordAttendance(organizerId, session.id, memberIds[1], 'absent');
    const before = await recordsOf(session.id);
    const auditBefore = await auditOf(session.id);
    const current = await getSession(session.id);
    await updateTraining(organizerId, session.id, formOf(current, { title: 'Renamed after the fact' }));
    expect(await recordsOf(session.id)).toEqual(before);
    expect(await auditOf(session.id)).toEqual(auditBefore);
    expect((await getSession(session.id)).status).toBe('confirmed');
  });

  // DEFECT Q3-1: update_training only refuses `cancelled` / `completed`. On a confirmed session
  // that already ended and has marks, the end can be pushed into the future (the start is
  // unchanged, so no future-check applies). The session is then "not ended" again: further marks
  // and the finalization are refused, while the marks already taken stay.
  it.fails('DEFECT Q3-1: a session with attendance marks cannot be made "not ended" again by editing its end', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1);
    await recordAttendance(organizerId, session.id, memberIds[0], 'present');
    const current = await getSession(session.id);
    await expect(
      updateTraining(organizerId, session.id, formOf(current, { ends_at: hoursFromNow(24) })),
    ).rejects.toBeDefined();
  });

  // DEFECT Q3-1 (second path): the start can move to the future too, so marks exist for a
  // training that has not happened yet.
  it.fails('DEFECT Q3-1: a session with attendance marks cannot be moved to the future', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1);
    await recordAttendance(organizerId, session.id, memberIds[0], 'present');
    const current = await getSession(session.id);
    await expect(
      updateTraining(
        organizerId,
        session.id,
        formOf(current, { starts_at: hoursFromNow(23), ends_at: hoursFromNow(24) }),
      ),
    ).rejects.toBeDefined();
  });

  it('documents the consequence: after such an edit the sheet says not ended and marks are refused', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(2, 2);
    await recordAttendance(organizerId, session.id, memberIds[0], 'present');
    const current = await getSession(session.id);
    await updateTraining(organizerId, session.id, formOf(current, { ends_at: hoursFromNow(24) }));
    expect((await attendanceSheet(organizerId, session.id)).ended).toBe(false);
    await expect(recordAttendance(organizerId, session.id, memberIds[1], 'present')).rejects.toMatchObject(
      raised('session_not_ended'),
    );
    await expect(finalizeAttendance(organizerId, session.id)).rejects.toMatchObject(raised('session_not_ended'));
    // The mark that was taken is still there.
    expect((await recordsOf(session.id)).map((r) => r.status)).toEqual(['present']);
  });
});

describe('attendance and cancel_training', () => {
  it('cancelling a confirmed, ended session keeps marks and audit, freezes them, and keeps them out of statistics', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(2, 2);
    const [m0, m1] = memberIds;
    await recordAttendance(organizerId, session.id, m0, 'present');
    await recordAttendance(organizerId, session.id, m1, 'absent');
    await cancelTraining(organizerId, session.id);

    const stored = await getSession(session.id);
    expect(stored.status).toBe('cancelled');
    expect(stored.attendance_finalized_at).toBeNull();
    expect((await recordsOf(session.id)).map((r) => r.status).sort()).toEqual(['absent', 'present']);
    expect(await auditOf(session.id)).toHaveLength(2);

    // Frozen: no mark, no walk-in, no finalization, no correction on a cancelled session.
    await expect(recordAttendance(organizerId, session.id, m0, 'absent')).rejects.toMatchObject(
      raised('session_not_confirmed'),
    );
    await expect(addWalkIn(organizerId, session.id, m0)).rejects.toMatchObject(raised('session_not_confirmed'));
    await expect(finalizeAttendance(organizerId, session.id)).rejects.toMatchObject(raised('session_not_confirmed'));
    expect((await recordsOf(session.id)).find((r) => r.user_id === m0)!.status).toBe('present');

    // The organizer can still read it (the sheet works for every status).
    const sheet = await attendanceSheet(organizerId, session.id);
    expect(sheet.status).toBe('cancelled');
    expect(sheet.entries.map((e) => e.attendance_status).sort()).toEqual(['absent', 'present']);

    // The member still sees the row (RLS keys on the member), but the history rule
    // "only completed sessions" leaves it out: the statistics query shape.
    const own = await asUser(m0, (db) =>
      db.query<{ n: number }>(
        `select count(*)::int as n from public.attendance_records a
         join public.training_sessions s on s.id = a.session_id`,
      ),
    );
    expect(own.rows[0].n).toBe(1);
    const eligible = await admin.query<{ n: number }>(
      `select count(*)::int as n from public.attendance_records a
       join public.training_sessions s on s.id = a.session_id
       where s.status = 'completed'`,
    );
    expect(eligible.rows[0].n).toBe(0);
  });

  it('finalize and cancel are exclusive: a finalized session cannot be cancelled, a cancelled one cannot be finalized', async () => {
    const a = await confirmedSession(1, 1);
    await finalizeAttendance(a.organizerId, a.session.id);
    await expect(cancelTraining(a.organizerId, a.session.id)).rejects.toMatchObject(raised('session_not_cancellable'));
    await resetData();
    const b = await confirmedSession(1, 1);
    await cancelTraining(b.organizerId, b.session.id);
    await expect(finalizeAttendance(b.organizerId, b.session.id)).rejects.toMatchObject(raised('session_not_confirmed'));
    const stored = await getSession(b.session.id);
    expect(stored.status).toBe('cancelled');
    expect(stored.attendance_finalized_at).toBeNull();
  });
});

describe('lock queues against the Milestone 1 RPCs (both orders, deterministic)', () => {
  it('record queued before cancel: the mark is taken, then the session is cancelled', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1);
    const outcomes = await queued(session.id, [
      { fragment: 'record_attendance', run: () => recordAttendance(organizerId, session.id, memberIds[0], 'present') },
      { fragment: 'cancel_training', run: () => cancelTraining(organizerId, session.id) },
    ]);
    expect(outcomes).toEqual(['ok', 'ok']);
    expect((await getSession(session.id)).status).toBe('cancelled');
    expect(await recordsOf(session.id)).toHaveLength(1);
    expect(await auditOf(session.id)).toHaveLength(1);
  });

  it('cancel queued before record: the mark is refused and nothing is written', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1);
    const outcomes = await queued(session.id, [
      { fragment: 'cancel_training', run: () => cancelTraining(organizerId, session.id) },
      { fragment: 'record_attendance', run: () => recordAttendance(organizerId, session.id, memberIds[0], 'present') },
    ]);
    expect(outcomes).toEqual(['ok', 'P0001:session_not_confirmed']);
    expect(await recordsOf(session.id)).toHaveLength(0);
    expect(await auditOf(session.id)).toHaveLength(0);
  });

  it('finalize queued before cancel: cancel is refused; cancel queued before finalize: finalize is refused', async () => {
    {
      const { organizerId, session } = await confirmedSession(1, 1);
      const outcomes = await queued(session.id, [
        { fragment: 'finalize_attendance', run: () => finalizeAttendance(organizerId, session.id) },
        { fragment: 'cancel_training', run: () => cancelTraining(organizerId, session.id) },
      ]);
      expect(outcomes).toEqual(['ok', 'P0001:session_not_cancellable']);
      expect((await getSession(session.id)).status).toBe('completed');
    }
    await resetData();
    {
      const { organizerId, session } = await confirmedSession(1, 1);
      const outcomes = await queued(session.id, [
        { fragment: 'cancel_training', run: () => cancelTraining(organizerId, session.id) },
        { fragment: 'finalize_attendance', run: () => finalizeAttendance(organizerId, session.id) },
      ]);
      expect(outcomes).toEqual(['ok', 'P0001:session_not_confirmed']);
      const stored = await getSession(session.id);
      expect(stored.status).toBe('cancelled');
      expect(stored.attendance_finalized_at).toBeNull();
      expect(await recordsOf(session.id)).toHaveLength(0);
    }
  });

  it('finalize queued before an edit: the edit is refused as not editable', async () => {
    const { organizerId, session } = await confirmedSession(1, 1);
    const current = await getSession(session.id);
    const outcomes = await queued(session.id, [
      { fragment: 'finalize_attendance', run: () => finalizeAttendance(organizerId, session.id) },
      { fragment: 'update_training', run: () => updateTraining(organizerId, session.id, formOf(current, { title: 'Late' })) },
    ]);
    expect(outcomes).toEqual(['ok', 'P0001:session_not_editable']);
    expect((await getSession(session.id)).title).toBe(current.title);
  });

  it('a late RSVP cannot slip in after confirmation, and cannot create a going RSVP for a walk-in', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(2, 1);
    const walkIn = memberIds[1];
    await addWalkIn(organizerId, session.id, walkIn);
    await expect(setRsvp(walkIn, session.id, 'going')).rejects.toMatchObject(raised('rsvp_closed'));
    const record = (await recordsOf(session.id)).find((r) => r.user_id === walkIn)!;
    expect(record.is_walk_in).toBe(true);
    expect(record.had_rsvp_going).toBe(false);
    // After finalization too.
    await finalizeAttendance(organizerId, session.id);
    await expect(setRsvp(walkIn, session.id, 'going')).rejects.toMatchObject(raised('rsvp_closed'));
    await expect(setRsvp(walkIn, session.id, 'not_going')).rejects.toMatchObject(raised('rsvp_closed'));
  });
});

describe('removed organizer whose call was already waiting for the session lock', () => {
  // DEFECT Q3-2: authorization (is_organizer) is evaluated before the lock wait and never
  // repeated. An organizer removed while their call waits still completes it. Same pattern as
  // update_training / cancel_training in Milestone 1; the window is the lock wait.
  async function removedMidWait(
    run: (organizerId: string, sessionId: string, memberId: string) => Promise<unknown>,
    fragment: string,
  ): Promise<{ outcome: string; recordCount: number; status: string }> {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1);
    const gate = await admin.connect();
    let result: Promise<string>;
    try {
      await gate.query('begin');
      await gate.query('select 1 from public.training_sessions where id = $1 for update', [session.id]);
      result = run(organizerId, session.id, memberIds[0]).then(() => 'ok', errorKey);
      await waitForBlocked(fragment);
      await admin.query("update public.memberships set status = 'removed' where user_id = $1", [organizerId]);
      await gate.query('commit');
    } finally {
      await gate.query('rollback');
      gate.release();
    }
    const outcome = await result;
    return { outcome, recordCount: (await recordsOf(session.id)).length, status: (await getSession(session.id)).status };
  }

  it('sanity: the same flow without the removal completes', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1);
    const [outcome] = await queued(session.id, [
      { fragment: 'record_attendance', run: () => recordAttendance(organizerId, session.id, memberIds[0], 'present') },
    ]);
    expect(outcome).toBe('ok');
  });

  it.fails('DEFECT Q3-2: record_attendance of an organizer removed during the lock wait is refused', async () => {
    const { outcome, recordCount } = await removedMidWait(
      (organizer, sessionId, member) => recordAttendance(organizer, sessionId, member, 'present'),
      'record_attendance',
    );
    expect(outcome).toBe('P0001:forbidden');
    expect(recordCount).toBe(0);
  });

  it.fails('DEFECT Q3-2: finalize_attendance of an organizer removed during the lock wait is refused', async () => {
    const { outcome, status } = await removedMidWait(
      (organizer, sessionId) => finalizeAttendance(organizer, sessionId),
      'finalize_attendance',
    );
    expect(outcome).toBe('P0001:forbidden');
    expect(status).toBe('confirmed');
  });

  it('a removed organizer is refused on a fresh call (the window is only the lock wait)', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1);
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [organizerId]);
    await expect(recordAttendance(organizerId, session.id, memberIds[0], 'present')).rejects.toMatchObject(
      raised('forbidden'),
    );
    await expect(finalizeAttendance(organizerId, session.id)).rejects.toMatchObject(raised('forbidden'));
    await expect(attendanceSheet(organizerId, session.id)).rejects.toMatchObject(raised('forbidden'));
  });
});

describe('had_rsvp_going snapshot', () => {
  it('stays true when the RSVP row later changes; the sheet shows both facts', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(2, 2);
    const [m0] = memberIds;
    await recordAttendance(organizerId, session.id, m0, 'present');
    // Not reachable through the app (RSVPs are closed once confirmed); a superuser repair or a
    // future feature could do it. The snapshot must not follow.
    await admin.query(
      "update public.training_rsvps set response = 'not_going' where session_id = $1 and user_id = $2",
      [session.id, m0],
    );
    const record = (await recordsOf(session.id)).find((r) => r.user_id === m0)!;
    expect(record.had_rsvp_going).toBe(true);
    expect(record.is_walk_in).toBe(false);
    const sheet = await attendanceSheet(organizerId, session.id);
    const entry = sheet.entries.find((e) => e.user_id === m0)!;
    expect(entry).toMatchObject({ rsvp_response: 'not_going', had_rsvp_going: true, attendance_status: 'present' });
    // The row is still correctable.
    expect((await recordAttendance(organizerId, session.id, m0, 'absent')).status).toBe('absent');
  });

  it('a member with a not_going RSVP is a walk-in, and a going RSVP is refused for walk-ins', async () => {
    const pack = await createPack(2);
    const session = await createTraining(pack.organizerId, pack.communityId, { min_participants: 1 });
    await setRsvp(pack.memberIds[0], session.id, 'going');
    await setRsvp(pack.memberIds[1], session.id, 'not_going');
    await makeDue(session.id);
    await finalize();
    await makeEnded(session.id);
    await expect(recordAttendance(pack.organizerId, session.id, pack.memberIds[1], 'present')).rejects.toMatchObject(
      raised('no_going_rsvp'),
    );
    const walkIn = await addWalkIn(pack.organizerId, session.id, pack.memberIds[1]);
    expect(walkIn).toMatchObject({ is_walk_in: true, had_rsvp_going: false, status: 'present' });
    // A walk-in can be corrected to absent (documented; see observation in the report).
    expect((await recordAttendance(pack.organizerId, session.id, pack.memberIds[1], 'absent')).status).toBe('absent');
  });
});

describe('audit trail is append-only through every RPC', () => {
  it('earlier audit rows never change while later marks, corrections, no-ops and finalization happen', async () => {
    const { organizerId, memberIds, session, communityId } = await confirmedSession(3, 3);
    const second = await addMember(communityId, { role: 'organizer', name: 'Second Organizer' });
    const [m0, m1, m2] = memberIds;
    const snapshot = async () =>
      (
        await admin.query(
          `select id, session_id, community_id, user_id, changed_by, changed_at, old_status, new_status, reason, action
           from public.attendance_audit_log order by changed_at, id`,
        )
      ).rows;

    await recordAttendance(organizerId, session.id, m0, 'present', 'first');
    const a = await snapshot();
    await recordAttendance(second, session.id, m0, 'absent', 'changed my mind');
    await recordAttendance(second, session.id, m0, 'absent', 'same again');
    await recordAttendance(organizerId, session.id, m1, 'unrecorded');
    await addWalkIn(organizerId, session.id, m1).catch(() => undefined);
    const b = await snapshot();
    expect(b.slice(0, a.length)).toEqual(a);
    expect(b).toHaveLength(2);

    await finalizeAttendance(organizerId, session.id);
    await finalizeAttendance(second, session.id);
    await recordAttendance(second, session.id, m2, 'present');
    await recordAttendance(organizerId, session.id, m0, 'present', '  fixed after finalization  ');
    const c = await snapshot();
    expect(c.slice(0, b.length)).toEqual(b);
    expect(c).toHaveLength(4);
    expect(c.map((r) => r.action)).toEqual(['record', 'correct', 'correct', 'correct']);
    expect(c[3]).toMatchObject({ reason: 'fixed after finalization', changed_by: organizerId });
    expect(c[1]).toMatchObject({ changed_by: second, old_status: 'present', new_status: 'absent' });
  });
});

describe('information leakage: a member learns nothing about other members', () => {
  it('joins, counts, filters and embeds return only the member\'s own row', async () => {
    const { organizerId, memberIds, session, communityId } = await confirmedSession(3, 3);
    const [m0, m1, m2] = memberIds;
    await recordAttendance(organizerId, session.id, m0, 'present');
    await recordAttendance(organizerId, session.id, m1, 'absent');
    await finalizeAttendance(organizerId, session.id);

    const probes: [string, unknown[]][] = [
      ['select count(*)::int as n from public.attendance_records where user_id <> $1', [m2]],
      ["select count(*)::int as n from public.attendance_records where status <> 'unrecorded'", []],
      ["select count(*)::int as n from public.attendance_records where status = 'absent'", []],
      [
        `select count(*)::int as n from public.training_rsvps r
         join public.attendance_records a on a.session_id = r.session_id and a.user_id = r.user_id
         where r.user_id <> $1`,
        [m2],
      ],
      [
        `select count(*)::int as n from public.profiles p
         join public.attendance_records a on a.user_id = p.id where p.id <> $1`,
        [m2],
      ],
      ['select count(*)::int as n from public.attendance_audit_log', []],
      [
        `select count(*)::int as n from public.training_sessions s
         where exists (select 1 from public.attendance_records a where a.session_id = s.id and a.user_id <> $1)`,
        [m2],
      ],
    ];
    for (const [sql, params] of probes) {
      const { rows } = await asUser(m2, (db) => db.query<{ n: number }>(sql, params));
      expect(rows[0].n, sql).toBe(0);
    }
    // m2's own placeholder (unrecorded, created by finalization) is the only row they see.
    const own = await asUser(m2, (db) =>
      db.query<{ status: AttendanceStatus; user_id: string }>('select user_id, status from public.attendance_records'),
    );
    expect(own.rows).toEqual([{ user_id: m2, status: 'unrecorded' }]);

    // An organizer of another community cannot see them either.
    const other = await createPack(0);
    expect((await asUser(other.organizerId, (db) => db.query('select 1 from public.attendance_records'))).rows).toEqual([]);

    // The session row a member can read carries no per-member attendance, only who/when finalized.
    const columns = await admin.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'training_sessions' and column_name like '%attend%'
       order by 1`,
    );
    expect(columns.rows.map((r) => r.column_name)).toEqual(['attendance_finalized_at', 'attendance_finalized_by']);
    expect(communityId).toBeTruthy();
  });
});

describe('realtime publication', () => {
  it('publishes attendance_records only, for every operation, and never the audit log', async () => {
    const { rows } = await admin.query<{ tablename: string }>(
      "select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'",
    );
    const tables = rows.map((r) => r.tablename);
    expect(tables).toContain('attendance_records');
    expect(tables).not.toContain('attendance_audit_log');
    expect(tables).not.toContain('invitation_attempts');

    const flags = await admin.query<{ pubinsert: boolean; pubupdate: boolean; pubdelete: boolean; pubtruncate: boolean }>(
      "select pubinsert, pubupdate, pubdelete, pubtruncate from pg_publication where pubname = 'supabase_realtime'",
    );
    expect(flags.rows[0]).toMatchObject({ pubinsert: true, pubupdate: true, pubdelete: true });
  });

  it('the published table has RLS enabled (events are filtered per subscriber) and a select policy only', async () => {
    const t = await admin.query<{ relrowsecurity: boolean; relreplident: string }>(
      "select relrowsecurity, relreplident from pg_class where oid = 'public.attendance_records'::regclass",
    );
    expect(t.rows[0].relrowsecurity).toBe(true);
    // 'd' = default identity: DELETE events carry only the primary key (no user_id, no status).
    expect(t.rows[0].relreplident).toBe('d');
    const policies = await admin.query<{ tablename: string; cmd: string; roles: string[] }>(
      `select tablename, cmd, roles::text[] as roles from pg_policies
       where schemaname = 'public' and tablename in ('attendance_records', 'attendance_audit_log') order by 1`,
    );
    expect(policies.rows).toEqual([
      { tablename: 'attendance_audit_log', cmd: 'SELECT', roles: ['authenticated'] },
      { tablename: 'attendance_records', cmd: 'SELECT', roles: ['authenticated'] },
    ]);
  });
});

describe('sessions without an end time', () => {
  it('attendance opens when the session starts and finalization is possible from then on (documented)', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1, { ended: false });
    // Started 5 minutes ago, no end time: the server treats the start as the end.
    await admin.query(
      `update public.training_sessions
       set rsvp_deadline = now() - interval '3 hours', starts_at = now() - interval '5 minutes', ends_at = null
       where id = $1`,
      [session.id],
    );
    expect((await attendanceSheet(organizerId, session.id)).ended).toBe(true);
    expect((await recordAttendance(organizerId, session.id, memberIds[0], 'present')).status).toBe('present');
    expect((await finalizeAttendance(organizerId, session.id)).status).toBe('completed');
  });

  it('one second before the start: not ended, for the sheet, the marks and the finalization', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1, { ended: false });
    await admin.query(
      `update public.training_sessions
       set rsvp_deadline = now() - interval '3 hours', starts_at = now() + interval '1 hour', ends_at = null
       where id = $1`,
      [session.id],
    );
    expect((await attendanceSheet(organizerId, session.id)).ended).toBe(false);
    await expect(recordAttendance(organizerId, session.id, memberIds[0], 'present')).rejects.toMatchObject(
      raised('session_not_ended'),
    );
    await expect(finalizeAttendance(organizerId, session.id)).rejects.toMatchObject(raised('session_not_ended'));
  });
});

describe('finalization placeholders and later removal', () => {
  it('a placeholder of a member removed afterwards stays, shows as removed, and can still be marked', async () => {
    const { organizerId, memberIds, session, communityId } = await confirmedSession(2, 2);
    await finalizeAttendance(organizerId, session.id);
    await admin.query("update public.memberships set status = 'removed' where user_id = $1 and community_id = $2", [
      memberIds[0],
      communityId,
    ]);
    const sheet = await attendanceSheet(organizerId, session.id);
    const entry = sheet.entries.find((e) => e.user_id === memberIds[0])!;
    expect(entry).toMatchObject({ membership_status: 'removed', attendance_status: 'unrecorded', has_record: true });
    const marked = await recordAttendance(organizerId, session.id, memberIds[0], 'present', 'confirmed by phone');
    expect(marked.status).toBe('present');
    expect((await auditOf(session.id, memberIds[0])).map((a) => a.action)).toEqual(['correct']);
    // Their own view stays closed.
    expect((await asUser(memberIds[0], (db) => db.query('select 1 from public.attendance_records'))).rows).toEqual([]);
  });
});

describe('mixed concurrent storm: marks, walk-ins, finalize, cancel, edits, removals, deletions', () => {
  it('no deadlock, no unexpected error, consistent end state in every round', async () => {
    for (let round = 0; round < 4; round += 1) {
      await resetData();
      const { organizerId, memberIds, session, communityId } = await confirmedSession(8, 5);
      const second = await addMember(communityId, { role: 'organizer', name: 'Second Organizer' });
      const going = memberIds.slice(0, 5);
      const others = memberIds.slice(5);
      const form = formOf(await getSession(session.id), { title: 'Edited in the storm' });
      const statuses: AttendanceStatus[] = ['present', 'absent', 'unrecorded'];
      const pick = <T,>(items: T[]): T => items[Math.floor(Math.random() * items.length)];
      const outcomes = new Outcomes();
      // Everything a business rule may legitimately answer in this storm.
      const allowed =
        /^P0001:(no_going_rsvp|session_not_confirmed|session_not_cancellable|session_not_editable|attendee_not_a_member|attendee_has_going_rsvp|session_not_ended)$/;

      const ops: (() => Promise<unknown>)[] = [];
      for (let i = 0; i < 50; i += 1) {
        const caller = i % 2 === 0 ? organizerId : second;
        const roll = Math.random();
        if (roll < 0.08) ops.push(() => outcomes.run('finalize', allowed, () => finalizeAttendance(caller, session.id)));
        else if (roll < 0.12) ops.push(() => outcomes.run('cancel', allowed, () => cancelTraining(caller, session.id)));
        else if (roll < 0.2) ops.push(() => outcomes.run('edit', allowed, () => updateTraining(caller, session.id, form)));
        else if (roll < 0.3) ops.push(() => outcomes.run('walk_in', allowed, () => addWalkIn(caller, session.id, pick(others))));
        else ops.push(() => outcomes.run('record', allowed, () => recordAttendance(caller, session.id, pick(going.concat(others[0])), pick(statuses))));
      }
      // Membership churn and an account deletion in the middle of it.
      ops.push(() =>
        outcomes.run('remove', /^$/, () =>
          admin.query("update public.memberships set status = 'removed' where user_id = $1", [going[0]]),
        ),
      );
      ops.push(() => outcomes.run('delete', /^$/, () => admin.query('delete from auth.users where id = $1', [going[1]])));
      ops.sort(() => Math.random() - 0.5);
      await Promise.all(ops.map((op) => op()));

      expect(outcomes.unexpected, `round ${round}`).toEqual([]);

      // End state invariants.
      const stored = await getSession(session.id);
      expect(['confirmed', 'completed', 'cancelled']).toContain(stored.status);
      expect(stored.status === 'completed', `round ${round}: completed iff finalized`).toBe(stored.attendance_finalized_at !== null);
      if (stored.status === 'cancelled') expect(stored.attendance_finalized_at).toBeNull();
      if (stored.status === 'completed') expect(stored.cancelled_at).toBeNull();

      const records = await recordsOf(session.id);
      expect(new Set(records.map((r) => r.user_id)).size).toBe(records.length);
      const audit = await auditOf(session.id);
      const byUser = new Map<string, typeof audit>();
      for (const row of audit) byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row]);
      const status = new Map(records.map((r) => [r.user_id, r.status]));
      for (const [userId, rows] of byUser) {
        let state: AttendanceStatus = 'unrecorded';
        for (const row of rows) {
          expect(row.old_status, `${userId} chain`).toBe(state);
          state = row.new_status;
        }
        expect(status.get(userId), `${userId} ends at the stored status`).toBe(state);
      }
      for (const [userId, s] of status) {
        if (s !== 'unrecorded') expect(byUser.has(userId), `${userId} has a mark without audit`).toBe(true);
      }
    }
  });
});
