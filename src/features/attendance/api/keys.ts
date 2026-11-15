/**
 * TanStack Query keys for attendance, in one place so optimistic updates,
 * Realtime invalidation and screens agree on them.
 *
 * Cached shapes:
 * - `attendanceKeys.sheet(sessionId)`  -> `AttendanceSheet` (organizer)
 * - `attendanceKeys.audit(sessionId)`  -> `AuditTrailItem[]` (organizer)
 * - `attendanceKeys.mine(userId)`      -> `MyAttendanceItem[]` (my finalized history)
 * - `attendanceKeys.myRecord(sessionId, userId)` -> `AttendanceRecord | null`
 */
export const attendanceKeys = {
  all: ['attendance'] as const,
  sheets: () => ['attendance', 'sheet'] as const,
  sheet: (sessionId: string) => ['attendance', 'sheet', sessionId] as const,
  audit: (sessionId: string) => ['attendance', 'audit', sessionId] as const,
  allMine: () => ['attendance', 'mine'] as const,
  allMyRecords: () => ['attendance', 'my-record'] as const,
  mine: (userId: string | null) => ['attendance', 'mine', userId] as const,
  myRecord: (sessionId: string, userId: string | null) =>
    ['attendance', 'my-record', sessionId, userId] as const,
};

/** Mutation key of every `record_attendance` call for a session (all rows). */
export const recordAttendanceKey = (sessionId: string) =>
  ['attendance', 'record', sessionId] as const;

export const walkInKey = (sessionId: string) => ['attendance', 'walk-in', sessionId] as const;
export const finalizeKey = (sessionId: string) => ['attendance', 'finalize', sessionId] as const;
