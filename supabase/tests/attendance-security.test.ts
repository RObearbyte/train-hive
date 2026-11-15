import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addMember,
  admin,
  asAnon,
  asRole,
  asUser,
  closeDb,
  countRows,
  createPack,
  createUser,
  getSession,
  INSUFFICIENT_PRIVILEGE,
  resetData,
} from './helpers';
import {
  addWalkIn,
  attendanceSheet,
  auditOf,
  confirmedSession,
  finalizeAttendance,
  recordAttendance,
  recordsOf,
} from './attendance-helpers';
import { raised } from './qa-helpers';

const denied = { code: INSUFFICIENT_PRIVILEGE };

/**
 * Community A: an organizer, three going members (m0 marked present, m1 marked absent, m2 not
 * marked) and one member without an RSVP (m3). Community B: its own organizer and member.
 */
async function arrange() {
  const a = await confirmedSession(4, 3);
  const [m0, m1] = a.memberIds;
  await recordAttendance(a.organizerId, a.session.id, m0, 'present');
  await recordAttendance(a.organizerId, a.session.id, m1, 'absent');
  const b = await createPack(1);
  const outsider = await createUser();
  // A user who is a member of A and the organizer of B.
  const dual = b.organizerId;
  await admin.query("insert into public.memberships (community_id, user_id) values ($1, $2)", [a.communityId, dual]);
  return { a, b, outsider, dual };
}

/** Every attendance RPC call an attacker could try against session `sessionId`. */
function calls(sessionId: string, targetId: string): [string, (caller: string) => Promise<unknown>][] {
  return [
    ['record_attendance', (caller) => recordAttendance(caller, sessionId, targetId, 'absent')],
    ['add_walk_in_attendee', (caller) => addWalkIn(caller, sessionId, targetId)],
    ['finalize_attendance', (caller) => finalizeAttendance(caller, sessionId)],
    ['get_attendance_sheet', (caller) => attendanceSheet(caller, sessionId)],
  ];
}

beforeEach(resetData);
afterAll(closeDb);

describe('attendance RPCs are organizer-only', () => {
  it('members, outsiders, organizers of another community and removed organizers get forbidden and change nothing', async () => {
    const { a, b, outsider, dual } = await arrange();
    const removedOrganizer = await addMember(a.communityId, { role: 'organizer', status: 'removed', name: 'Gone Organizer' });
    const records = await recordsOf(a.session.id);
    const audit = await auditOf(a.session.id);
    const session = await getSession(a.session.id);

    const callers = {
      'member (attendee themself)': a.memberIds[0],
      'member without RSVP': a.memberIds[3],
      outsider,
      'organizer of B who is a member of A': dual,
      'member of B': b.memberIds[0],
      'removed organizer of A': removedOrganizer,
    };
    for (const [who, caller] of Object.entries(callers)) {
      for (const [name, call] of calls(a.session.id, a.memberIds[0])) {
        await expect(call(caller), `${who}: ${name}`).rejects.toMatchObject(raised('forbidden'));
      }
      // Including on themselves as the attendee.
      await expect(recordAttendance(caller, a.session.id, caller, 'present'), who).rejects.toMatchObject(
        raised('forbidden'),
      );
    }

    expect(await recordsOf(a.session.id)).toEqual(records);
    expect(await auditOf(a.session.id)).toEqual(audit);
    expect(await getSession(a.session.id)).toEqual(session);
  });

  it('a signed-in request without a user id gets not_authenticated', async () => {
    const { a } = await arrange();
    for (const [name] of calls(a.session.id, a.memberIds[0])) {
      const sql =
        name === 'record_attendance'
          ? `select public.${name}($1, $2, 'present')`
          : name === 'add_walk_in_attendee'
            ? `select public.${name}($1, $2)`
            : `select public.${name}($1)`;
      const params = sql.includes('$2') ? [a.session.id, a.memberIds[0]] : [a.session.id];
      await expect(
        asRole('authenticated', { role: 'authenticated' }, (db) => db.query(sql, params)),
        name,
      ).rejects.toMatchObject(raised('not_authenticated'));
    }
  });

  it('anon cannot call any of them (privilege error, before any check)', async () => {
    const { a } = await arrange();
    const sqls: [string, unknown[]][] = [
      ["select public.record_attendance($1, $2, 'present')", [a.session.id, a.memberIds[0]]],
      ['select public.add_walk_in_attendee($1, $2)', [a.session.id, a.memberIds[3]]],
      ['select public.finalize_attendance($1)', [a.session.id]],
      ['select public.get_attendance_sheet($1)', [a.session.id]],
    ];
    for (const [sql, params] of sqls) {
      await expect(asAnon((db) => db.query(sql, params)), sql).rejects.toMatchObject(denied);
    }
  });

  it('a session id of another community answers forbidden to its non-organizers, not_found for unknown ids', async () => {
    const { a, b } = await arrange();
    await expect(recordAttendance(b.organizerId, a.session.id, b.memberIds[0], 'present')).rejects.toMatchObject(
      raised('forbidden'),
    );
    const unknown = '00000000-0000-4000-8000-000000000000';
    for (const [name, call] of calls(unknown, a.memberIds[0])) {
      await expect(call(a.organizerId), name).rejects.toMatchObject(raised('not_found'));
    }
  });
});

describe('attendance reads under RLS', () => {
  it('a member sees only their own records; the history join works', async () => {
    const { a } = await arrange();
    const [m0, m1, m2] = a.memberIds;
    const own = await asUser(m0, (db) =>
      db.query<{ user_id: string; status: string; title: string; session_status: string }>(
        `select a.user_id, a.status, s.title, s.status as session_status
         from public.attendance_records a
         join public.training_sessions s on s.id = a.session_id`,
      ),
    );
    expect(own.rows).toEqual([{ user_id: m0, status: 'present', title: a.session.title, session_status: 'confirmed' }]);
    expect((await asUser(m1, (db) => db.query('select status from public.attendance_records'))).rows).toEqual([
      { status: 'absent' },
    ]);
    // Not marked yet: no row, so nothing.
    expect((await asUser(m2, (db) => db.query('select id from public.attendance_records'))).rows).toEqual([]);
  });

  it('organizers see every record of their community and the audit log; nobody else sees the audit log', async () => {
    const { a, b, outsider, dual } = await arrange();
    const organizerView = await asUser(a.organizerId, (db) =>
      db.query<{ user_id: string }>('select user_id from public.attendance_records order by user_id'),
    );
    expect(organizerView.rows.map((r) => r.user_id)).toEqual([a.memberIds[0], a.memberIds[1]].sort());
    expect((await asUser(a.organizerId, (db) => db.query('select id from public.attendance_audit_log'))).rows).toHaveLength(2);

    for (const userId of [a.memberIds[0], a.memberIds[3], b.organizerId, b.memberIds[0], outsider, dual]) {
      const { rows } = await asUser(userId, (db) => db.query('select id from public.attendance_audit_log'));
      expect(rows, userId).toEqual([]);
    }
    for (const userId of [b.organizerId, b.memberIds[0], outsider]) {
      const { rows } = await asUser(userId, (db) => db.query('select id from public.attendance_records'));
      expect(rows, userId).toEqual([]);
    }
    // dual is a plain member of A: sees only their own (none).
    expect((await asUser(dual, (db) => db.query('select id from public.attendance_records'))).rows).toEqual([]);
  });

  it('a removed organizer loses the organizer view', async () => {
    const { a } = await arrange();
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [a.organizerId]);
    expect((await asUser(a.organizerId, (db) => db.query('select id from public.attendance_records'))).rows).toEqual([]);
    expect((await asUser(a.organizerId, (db) => db.query('select id from public.attendance_audit_log'))).rows).toEqual([]);
  });
});

describe('direct writes to attendance tables are denied', () => {
  it('for the organizer and for the attendee, with realistic values', async () => {
    const { a } = await arrange();
    const [m0] = a.memberIds;
    const record = (await recordsOf(a.session.id)).find((r) => r.user_id === m0)!;
    const statements: [string, unknown[]][] = [
      [
        `insert into public.attendance_records (session_id, community_id, user_id, status, had_rsvp_going)
         values ($1, $2, $3, 'present', true)`,
        [a.session.id, a.communityId, a.memberIds[2]],
      ],
      ["update public.attendance_records set status = 'absent' where id = $1", [record.id]],
      ['delete from public.attendance_records where id = $1', [record.id]],
      [
        `insert into public.attendance_audit_log (session_id, community_id, user_id, old_status, new_status, action)
         values ($1, $2, $3, 'absent', 'present', 'correct')`,
        [a.session.id, a.communityId, m0],
      ],
      ['delete from public.attendance_audit_log where session_id = $1', [a.session.id]],
      ['update public.attendance_audit_log set changed_by = null where session_id = $1', [a.session.id]],
      ["update public.training_sessions set status = 'completed', attendance_finalized_at = now() where id = $1", [a.session.id]],
    ];
    for (const caller of [a.organizerId, m0]) {
      for (const [sql, params] of statements) {
        await expect(asUser(caller, (db) => db.query(sql, params)), sql).rejects.toMatchObject(denied);
      }
    }
    expect(record.status).toBe('present');
    expect((await recordsOf(a.session.id)).find((r) => r.user_id === m0)!.status).toBe('present');
    expect(await countRows('attendance_audit_log')).toBe(2);
    expect((await getSession(a.session.id)).status).toBe('confirmed');
  });

  it('private attendance helpers are out of reach', async () => {
    const { a } = await arrange();
    const sqls: [string, unknown[]][] = [
      ['select private.authorize_attendance($1)', [a.session.id]],
      ['select private.lock_session_for_attendance($1)', [a.session.id]],
      ['select private.lock_attendance_people($1, $2, $3)', [a.organizerId, a.memberIds[0], a.communityId]],
      ["select private.clean_attendance_reason('x')", []],
    ];
    for (const [sql, params] of sqls) {
      await expect(asUser(a.organizerId, (db) => db.query(sql, params)), sql).rejects.toMatchObject(denied);
    }
  });
});
