import type {
  AttendanceAuditAction,
  AttendanceRecord,
  AttendanceSheet,
  AttendanceStatus,
  SessionStatus,
  TrainingSession,
} from '@/lib/database.types';
import { toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

/**
 * The organizer's sheet for a session (`get_attendance_sheet`, any session
 * status). Members get `forbidden`.
 */
export async function fetchAttendanceSheet(sessionId: string): Promise<AttendanceSheet> {
  const { data, error } = await getSupabase().rpc('get_attendance_sheet', {
    p_session_id: sessionId,
  });
  if (error) throw toAppError(error);
  // The RPC returns jsonb; its shape is the contract's AttendanceSheet.
  return data as unknown as AttendanceSheet;
}

/**
 * Sets one member's status (organizer only). `unrecorded` clears a mark.
 * Throws AppError: `session_not_confirmed`, `session_not_ended`,
 * `no_going_rsvp`, `attendee_not_a_member`, `forbidden`, `not_found`, ...
 */
export async function recordAttendance(
  sessionId: string,
  userId: string,
  status: AttendanceStatus,
  reason: string | null,
): Promise<AttendanceRecord> {
  const { data, error } = await getSupabase().rpc('record_attendance', {
    p_session_id: sessionId,
    p_user_id: userId,
    p_status: status,
    p_reason: reason,
  });
  if (error) throw toAppError(error);
  return data;
}

/** Adds a member who did not RSVP going as present. Idempotent when they already have a row. */
export async function addWalkInAttendee(
  sessionId: string,
  userId: string,
): Promise<AttendanceRecord> {
  const { data, error } = await getSupabase().rpc('add_walk_in_attendee', {
    p_session_id: sessionId,
    p_user_id: userId,
  });
  if (error) throw toAppError(error);
  return data;
}

/** Completes the session. Unrecorded members stay unrecorded (never converted to absent). */
export async function finalizeAttendance(sessionId: string): Promise<TrainingSession> {
  const { data, error } = await getSupabase().rpc('finalize_attendance', {
    p_session_id: sessionId,
  });
  if (error) throw toAppError(error);
  return data;
}

export type AuditTrailItem = {
  id: string;
  userId: string;
  /** Null when the organizer's account was deleted. */
  changedByName: string | null;
  changedAt: string;
  oldStatus: AttendanceStatus;
  newStatus: AttendanceStatus;
  reason: string | null;
  action: AttendanceAuditAction;
};

/** The audit trail of a session, oldest first (organizer-only RLS). */
export async function fetchAuditTrail(sessionId: string): Promise<AuditTrailItem[]> {
  const { data, error } = await getSupabase()
    .from('attendance_audit_log')
    // Two foreign keys point at profiles (user_id, changed_by); name the one meant.
    .select(
      'id, user_id, changed_at, old_status, new_status, reason, action, changer:profiles!attendance_audit_log_changed_by_fkey(display_name)',
    )
    .eq('session_id', sessionId)
    .order('changed_at', { ascending: true });
  if (error) throw toAppError(error);
  return data.map((row) => ({
    id: row.id,
    userId: row.user_id,
    changedByName: row.changer?.display_name ?? null,
    changedAt: row.changed_at,
    oldStatus: row.old_status,
    newStatus: row.new_status,
    reason: row.reason,
    action: row.action,
  }));
}

export type MyAttendanceItem = {
  recordId: string;
  status: AttendanceStatus;
  isWalkIn: boolean;
  session: {
    id: string;
    title: string;
    startsAt: string;
    endsAt: string | null;
    timezone: string;
    locationName: string;
    status: SessionStatus;
  };
};

/** Generous cap; longer histories are a Milestone 4 (statistics) concern. */
export const MY_ATTENDANCE_LIMIT = 1000;

/**
 * My attendance rows joined to their sessions, newest session first, only
 * for sessions that were finalized (`completed`). Rows of confirmed or
 * cancelled sessions are never history.
 */
export async function fetchMyAttendance(
  communityId: string,
  userId: string,
): Promise<MyAttendanceItem[]> {
  const { data, error } = await getSupabase()
    .from('attendance_records')
    // The composite foreign key (session_id, community_id) is named explicitly.
    .select(
      'id, status, is_walk_in, session:training_sessions!attendance_records_session_fkey(id, title, starts_at, ends_at, timezone, location_name, status)',
    )
    .eq('community_id', communityId)
    .eq('user_id', userId)
    .limit(MY_ATTENDANCE_LIMIT);
  if (error) throw toAppError(error);

  const items: MyAttendanceItem[] = [];
  for (const row of data) {
    const session = row.session;
    if (!session || session.status !== 'completed') continue;
    items.push({
      recordId: row.id,
      status: row.status,
      isWalkIn: row.is_walk_in,
      session: {
        id: session.id,
        title: session.title,
        startsAt: session.starts_at,
        endsAt: session.ends_at,
        timezone: session.timezone,
        locationName: session.location_name,
        status: session.status,
      },
    });
  }
  return items.sort(
    (a, b) => new Date(b.session.startsAt).getTime() - new Date(a.session.startsAt).getTime(),
  );
}

/** My own record for one session, or null when none exists. */
export async function fetchMyRecord(
  sessionId: string,
  userId: string,
): Promise<AttendanceRecord | null> {
  const { data, error } = await getSupabase()
    .from('attendance_records')
    .select('*')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw toAppError(error);
  return data;
}
