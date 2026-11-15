import { useQuery } from '@tanstack/react-query';

import type { AttendanceSheet } from '@/lib/database.types';

import { attendanceKeys } from '../api/keys';
import {
  fetchAttendanceSheet,
  fetchAuditTrail,
  fetchMyAttendance,
  fetchMyRecord,
  type AuditTrailItem,
  type MyAttendanceItem,
} from '../api/attendance';

/** The organizer's sheet. `enabled` stays false until the caller is known to be an organizer. */
export function useAttendanceSheet(sessionId: string, enabled: boolean) {
  return useQuery<AttendanceSheet>({
    queryKey: attendanceKeys.sheet(sessionId),
    queryFn: () => fetchAttendanceSheet(sessionId),
    enabled,
  });
}

/** Audit trail of the session; loaded only when the History sheet is opened. */
export function useAuditTrail(sessionId: string, enabled: boolean) {
  return useQuery<AuditTrailItem[]>({
    queryKey: attendanceKeys.audit(sessionId),
    queryFn: () => fetchAuditTrail(sessionId),
    enabled,
    // Always show the latest changes when it is opened.
    staleTime: 0,
  });
}

/** My finalized attendance history. */
export function useMyAttendance(userId: string | null) {
  return useQuery<MyAttendanceItem[]>({
    queryKey: attendanceKeys.mine(userId),
    queryFn: () => fetchMyAttendance(userId as string),
    enabled: userId !== null,
  });
}

/** My own record for one session (null when none). Only fetched when asked. */
export function useMyRecord(sessionId: string, userId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: attendanceKeys.myRecord(sessionId, userId),
    queryFn: () => fetchMyRecord(sessionId, userId as string),
    enabled: enabled && userId !== null,
  });
}
