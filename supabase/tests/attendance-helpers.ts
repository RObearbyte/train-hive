import {
  admin,
  asUser,
  createPack,
  createTraining,
  finalize,
  makeDue,
  rpc,
  rpcRow,
  setRsvp,
  type Session,
} from './helpers';

/**
 * Shared helpers for the attendance suites (`attendance*.test.ts`). Not a test file.
 */

export type AttendanceStatus = 'present' | 'absent' | 'unrecorded';

export interface AttendanceRecord {
  id: string;
  session_id: string;
  community_id: string;
  user_id: string;
  status: AttendanceStatus;
  recorded_by: string | null;
  recorded_at: Date;
  updated_at: Date;
  had_rsvp_going: boolean;
  is_walk_in: boolean;
}

export interface AuditRow {
  session_id: string;
  community_id: string;
  user_id: string;
  changed_by: string | null;
  changed_at: Date;
  old_status: AttendanceStatus;
  new_status: AttendanceStatus;
  reason: string | null;
  action: 'record' | 'correct' | 'walk_in_add';
}

export interface SheetEntry {
  user_id: string;
  display_name: string;
  membership_status: 'active' | 'removed' | null;
  rsvp_response: 'going' | 'not_going' | 'no_response';
  attendance_status: AttendanceStatus;
  has_record: boolean;
  is_walk_in: boolean;
  had_rsvp_going: boolean | null;
  updated_at: string | null;
}

export interface Sheet {
  session_id: string;
  status: Session['status'];
  ended: boolean;
  attendance_finalized_at: string | null;
  attendance_finalized_by: string | null;
  entries: SheetEntry[];
}

/**
 * Time travel: the session started two hours ago and ended one hour ago, or (without an end)
 * started three hours ago, so it is past the 2-hour rule for sessions without `ends_at`.
 */
export async function makeEnded(sessionId: string, options: { withEnd?: boolean } = {}): Promise<void> {
  const { withEnd = true } = options;
  await admin.query(
    `update public.training_sessions
     set rsvp_deadline = now() - interval '4 hours',
         starts_at = now() - case when $2::boolean then interval '2 hours' else interval '3 hours' end,
         ends_at = case when $2::boolean then now() - interval '1 hour' end
     where id = $1`,
    [sessionId, withEnd],
  );
}

/**
 * A pack with an organizer and `memberCount` members, and a training that went through the real
 * lifecycle: the first `goingCount` members RSVP going, the deadline passes, the finalizer
 * confirms it. With `ended` (default) the session has also ended.
 */
export async function confirmedSession(
  memberCount: number,
  goingCount: number,
  options: { ended?: boolean; withEnd?: boolean } = {},
): Promise<{ communityId: string; organizerId: string; memberIds: string[]; session: Session }> {
  const { ended = true, withEnd = true } = options;
  const pack = await createPack(memberCount);
  const session = await createTraining(pack.organizerId, pack.communityId, { min_participants: 1 });
  for (const memberId of pack.memberIds.slice(0, goingCount)) {
    await setRsvp(memberId, session.id, 'going');
  }
  if (goingCount === 0) {
    // Nobody going would cancel it: confirm through the organizer going instead.
    await setRsvp(pack.organizerId, session.id, 'going');
  }
  await makeDue(session.id);
  await finalize();
  if (ended) await makeEnded(session.id, { withEnd });
  return { ...pack, session };
}

export function recordAttendance(
  callerId: string,
  sessionId: string,
  attendeeId: string,
  status: AttendanceStatus,
  reason?: string | null,
): Promise<AttendanceRecord> {
  return asUser(callerId, (db) =>
    reason === undefined
      ? rpcRow<AttendanceRecord>(db, 'record_attendance', [sessionId, attendeeId, status])
      : rpcRow<AttendanceRecord>(db, 'record_attendance', [sessionId, attendeeId, status, reason]),
  );
}

export function addWalkIn(callerId: string, sessionId: string, attendeeId: string): Promise<AttendanceRecord> {
  return asUser(callerId, (db) => rpcRow<AttendanceRecord>(db, 'add_walk_in_attendee', [sessionId, attendeeId]));
}

export function finalizeAttendance(callerId: string, sessionId: string): Promise<Session> {
  return asUser(callerId, (db) => rpcRow<Session>(db, 'finalize_attendance', [sessionId]));
}

export function attendanceSheet(callerId: string, sessionId: string): Promise<Sheet> {
  return asUser(callerId, (db) => rpc<Sheet>(db, 'get_attendance_sheet', [sessionId]));
}

/** Attendance rows of a session as stored (superuser), by user id. */
export async function recordsOf(sessionId: string): Promise<AttendanceRecord[]> {
  const { rows } = await admin.query<AttendanceRecord>(
    'select * from public.attendance_records where session_id = $1 order by user_id',
    [sessionId],
  );
  return rows;
}

/** Audit rows of a session as stored (superuser), oldest first. */
export async function auditOf(sessionId: string, userId?: string): Promise<AuditRow[]> {
  const { rows } = await admin.query<AuditRow>(
    `select session_id, community_id, user_id, changed_by, changed_at, old_status, new_status, reason, action
     from public.attendance_audit_log
     where session_id = $1 and ($2::uuid is null or user_id = $2)
     order by changed_at, id`,
    [sessionId, userId ?? null],
  );
  return rows;
}
