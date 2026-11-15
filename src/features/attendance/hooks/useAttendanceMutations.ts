import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { invalidateStatistics, isSheetFinalized } from '@/features/statistics/api/invalidate';
import { trainingKeys } from '@/features/trainings/api/keys';
import type { AttendanceRecord, AttendanceSheet, TrainingSession } from '@/lib/database.types';
import type { AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';

import { addWalkInAttendee, finalizeAttendance, recordAttendance } from '../api/attendance';
import { attendanceKeys, finalizeKey, recordAttendanceKey, walkInKey } from '../api/keys';
import {
  applyOptimisticMark,
  invalidateSheetUnlessPending,
  isRowPending,
  reconcileMark,
  rollbackMark,
  upsertWalkIn,
  type MarkSnapshot,
  type MarkVariables,
} from '../domain/sheetCache';

/** Errors that mean the sheet on screen is out of date (status or timing changed on the server). */
const STALE_SHEET_CODES = new Set([
  'session_not_confirmed',
  'session_not_ended',
  'attendee_not_a_member',
  'no_going_rsvp',
  'attendee_has_going_rsvp',
  'forbidden',
  'not_found',
]);

export type RecordAttendance = {
  /**
   * Set a member's status. Ignored (returns false) while a change for that
   * same row is being saved: one change per row at a time, so rapid taps
   * cannot stack. Other rows are independent.
   */
  mark: (variables: MarkVariables) => boolean;
  /** Like `mark`, but resolves when saved and rejects with the AppError (for "mark all"). */
  markAsync: (variables: MarkVariables) => Promise<AttendanceRecord>;
  /** User ids whose change is being saved right now. */
  pendingUserIds: ReadonlySet<string>;
  /** Why the last change to a row failed (already rolled back), by user id. */
  rowErrors: Readonly<Record<string, AppError>>;
  clearRowError: (userId: string) => void;
};

/**
 * Optimistic `record_attendance` for one session:
 * 1. cancel in-flight sheet reads, snapshot ONLY the tapped row, show the new status;
 * 2. on error put back only that row and remember why (shown on the row);
 * 3. on success take the server's row;
 * 4. when the last in-flight change settles, refetch the sheet so the screen ends on server truth.
 */
export function useRecordAttendance(sessionId: string): RecordAttendance {
  const queryClient = useQueryClient();
  const [rowErrors, setRowErrors] = useState<Record<string, AppError>>({});
  const mutationKey = recordAttendanceKey(sessionId);

  const mutation = useMutation<AttendanceRecord, AppError, MarkVariables, MarkSnapshot>({
    mutationKey,
    mutationFn: ({ userId, next, reason }) => recordAttendance(sessionId, userId, next, reason),

    onMutate: async (variables) => {
      setRowErrors((errors) => {
        if (!(variables.userId in errors)) return errors;
        const { [variables.userId]: _cleared, ...rest } = errors;
        return rest;
      });
      await queryClient.cancelQueries({ queryKey: attendanceKeys.sheet(sessionId) });
      return applyOptimisticMark(queryClient, sessionId, variables);
    },

    onError: (error, variables, snapshot) => {
      if (snapshot) rollbackMark(queryClient, snapshot);
      reportError('attendance.record', error);
      setRowErrors((errors) => ({ ...errors, [variables.userId]: error }));
      if (STALE_SHEET_CODES.has(error.code)) {
        // The server's state differs from the screen's: show the truth once nothing else is pending.
        invalidateSheetUnlessPending(queryClient, sessionId, { selfSettling: true });
      }
    },

    onSuccess: (record) => reconcileMark(queryClient, sessionId, record),

    // Not awaited: the row unlocks when the RPC answers, not when the refetch finishes.
    onSettled: () => {
      invalidateSheetUnlessPending(queryClient, sessionId, { selfSettling: true });
      void queryClient.invalidateQueries({ queryKey: attendanceKeys.audit(sessionId) });
      // A correction after finalization changes the statistics at once.
      if (isSheetFinalized(queryClient.getQueryData<AttendanceSheet>(attendanceKeys.sheet(sessionId)))) {
        invalidateStatistics(queryClient);
      }
    },
  });

  const pendingUserIds = new Set(
    useMutationState({
      filters: { mutationKey, status: 'pending' },
      select: (state) => (state.state.variables as MarkVariables | undefined)?.userId ?? '',
    }),
  );

  const mark = useCallback(
    (variables: MarkVariables): boolean => {
      // Checked synchronously: state from the last render could be one tap behind.
      if (isRowPending(queryClient, sessionId, variables.userId)) return false;
      mutation.mutate(variables);
      return true;
    },
    [queryClient, sessionId, mutation],
  );

  const markAsync = useCallback(
    (variables: MarkVariables) => mutation.mutateAsync(variables),
    [mutation],
  );

  const clearRowError = useCallback((userId: string) => {
    setRowErrors((errors) => {
      if (!(userId in errors)) return errors;
      const { [userId]: _cleared, ...rest } = errors;
      return rest;
    });
  }, []);

  return { mark, markAsync, pendingUserIds, rowErrors, clearRowError };
}

/**
 * Adds a member as a walk-in. Not optimistic: the server decides whether the
 * member is eligible. On success the row is inserted, then the sheet refetches.
 */
export function useAddWalkIn(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation<AttendanceRecord, AppError, { userId: string; displayName: string }>({
    mutationKey: walkInKey(sessionId),
    mutationFn: ({ userId }) => addWalkInAttendee(sessionId, userId),
    onSuccess: (record, { displayName }) => {
      upsertWalkIn(queryClient, sessionId, record, displayName);
    },
    onError: (error) => {
      reportError('attendance.walkIn', error);
      // e.g. attendee_has_going_rsvp: they are already on the sheet, which is stale.
      if (STALE_SHEET_CODES.has(error.code)) invalidateSheetUnlessPending(queryClient, sessionId);
    },
    onSettled: () => {
      invalidateSheetUnlessPending(queryClient, sessionId, { selfSettling: false });
      void queryClient.invalidateQueries({ queryKey: attendanceKeys.audit(sessionId) });
      if (isSheetFinalized(queryClient.getQueryData<AttendanceSheet>(attendanceKeys.sheet(sessionId)))) {
        invalidateStatistics(queryClient);
      }
    },
  });
}

/**
 * Finalizes attendance: the session becomes Completed. Shows the returned
 * session at once and refetches the sheet, the session lists and details and
 * my own history (the new rows for unrecorded members).
 */
export function useFinalizeAttendance(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation<TrainingSession, AppError, void>({
    mutationKey: finalizeKey(sessionId),
    mutationFn: () => finalizeAttendance(sessionId),
    onSuccess: (session) => {
      queryClient.setQueryData(trainingKeys.detail(sessionId), session);
      // The sheet turns into the correction view at once; the refetch below confirms it.
      queryClient.setQueryData<AttendanceSheet>(attendanceKeys.sheet(sessionId), (sheet) =>
        sheet
          ? {
              ...sheet,
              status: session.status,
              attendance_finalized_at: session.attendance_finalized_at ?? null,
              attendance_finalized_by: session.attendance_finalized_by ?? null,
            }
          : sheet,
      );
    },
    onError: (error) => {
      reportError('attendance.finalize', error);
      if (STALE_SHEET_CODES.has(error.code)) {
        void queryClient.invalidateQueries({ queryKey: attendanceKeys.sheet(sessionId) });
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: attendanceKeys.sheet(sessionId) });
      void queryClient.invalidateQueries({ queryKey: attendanceKeys.audit(sessionId) });
      void queryClient.invalidateQueries({ queryKey: trainingKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: trainingKeys.detail(sessionId) });
      void queryClient.invalidateQueries({ queryKey: attendanceKeys.allMine() });
      void queryClient.invalidateQueries({ queryKey: attendanceKeys.allMyRecords() });
      // The session just became part of everyone's statistics.
      invalidateStatistics(queryClient);
    },
  });
}
