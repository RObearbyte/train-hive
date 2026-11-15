/**
 * Optimistic attendance rows on the query cache: apply, roll back exactly,
 * reconcile with the server's row. No React and no network here, so it is
 * unit tested against a real QueryClient.
 *
 * Same lessons as `rsvpCache.ts`:
 * - a snapshot holds only the ONE affected row, and rollback puts back only
 *   that row into whatever the sheet is now, so two rows changing at once
 *   (or a refetch landing in between) cannot undo each other;
 * - one change per row at a time: `isRowPending` lets callers ignore a
 *   re-tap while that row is being saved;
 * - Realtime / settle refetches are skipped while a change is in flight, so a
 *   read that predates it cannot flip the optimistic value back.
 */
import type { QueryClient } from '@tanstack/react-query';

import type {
  AttendanceRecord,
  AttendanceSheet,
  AttendanceSheetEntry,
  AttendanceStatus,
} from '@/lib/database.types';

import { attendanceKeys, recordAttendanceKey } from '../api/keys';

/** Variables of one `record_attendance` mutation. */
export type MarkVariables = {
  userId: string;
  next: AttendanceStatus;
  reason: string | null;
};

/** What `applyOptimisticMark` replaced: one row (or none, when it was not on the sheet). */
export type MarkSnapshot = {
  sessionId: string;
  userId: string;
  /** The row before the change; null when the sheet was not loaded or the row was not on it. */
  entry: AttendanceSheetEntry | null;
};

function mapEntry(
  sheet: AttendanceSheet,
  userId: string,
  patch: (entry: AttendanceSheetEntry) => AttendanceSheetEntry,
): AttendanceSheet {
  if (!sheet.entries.some((entry) => entry.user_id === userId)) return sheet;
  return {
    ...sheet,
    entries: sheet.entries.map((entry) => (entry.user_id === userId ? patch(entry) : entry)),
  };
}

/**
 * Shows the new status on the row immediately. Call after cancelling the
 * sheet query, so a read already in flight cannot overwrite it. Counts are
 * derived from the entries, so they follow without separate bookkeeping.
 */
export function applyOptimisticMark(
  queryClient: QueryClient,
  sessionId: string,
  change: Pick<MarkVariables, 'userId' | 'next'>,
): MarkSnapshot {
  const key = attendanceKeys.sheet(sessionId);
  const sheet = queryClient.getQueryData<AttendanceSheet>(key);
  const entry = sheet?.entries.find((candidate) => candidate.user_id === change.userId) ?? null;
  if (sheet && entry) {
    queryClient.setQueryData<AttendanceSheet>(
      key,
      mapEntry(sheet, change.userId, (current) => ({
        ...current,
        attendance_status: change.next,
      })),
    );
  }
  return { sessionId, userId: change.userId, entry };
}

/** Puts back the one row `applyOptimisticMark` changed, and nothing else. */
export function rollbackMark(queryClient: QueryClient, snapshot: MarkSnapshot): void {
  if (snapshot.entry === null) return;
  const before = snapshot.entry;
  queryClient.setQueryData<AttendanceSheet>(attendanceKeys.sheet(snapshot.sessionId), (sheet) =>
    sheet ? mapEntry(sheet, snapshot.userId, () => before) : sheet,
  );
}

function entryFromRecord(
  base: AttendanceSheetEntry,
  record: AttendanceRecord,
): AttendanceSheetEntry {
  return {
    ...base,
    attendance_status: record.status,
    has_record: true,
    is_walk_in: record.is_walk_in,
    had_rsvp_going: record.had_rsvp_going,
    updated_at: record.updated_at,
  };
}

/** Replaces the optimistic guess on the row with what the server stored. */
export function reconcileMark(
  queryClient: QueryClient,
  sessionId: string,
  record: AttendanceRecord,
): void {
  queryClient.setQueryData<AttendanceSheet>(attendanceKeys.sheet(sessionId), (sheet) =>
    sheet ? mapEntry(sheet, record.user_id, (entry) => entryFromRecord(entry, record)) : sheet,
  );
}

/**
 * Adds (or updates) the row of a walk-in the server just created. The name is
 * known from the member list. Entries stay in server order; the screen sorts.
 */
export function upsertWalkIn(
  queryClient: QueryClient,
  sessionId: string,
  record: AttendanceRecord,
  displayName: string,
): void {
  queryClient.setQueryData<AttendanceSheet>(attendanceKeys.sheet(sessionId), (sheet) => {
    if (!sheet) return sheet;
    if (sheet.entries.some((entry) => entry.user_id === record.user_id)) {
      return mapEntry(sheet, record.user_id, (entry) => entryFromRecord(entry, record));
    }
    const created: AttendanceSheetEntry = entryFromRecord(
      {
        user_id: record.user_id,
        display_name: displayName,
        membership_status: 'active',
        rsvp_response: 'no_response',
        attendance_status: record.status,
        has_record: true,
        is_walk_in: record.is_walk_in,
        had_rsvp_going: record.had_rsvp_going,
        updated_at: record.updated_at,
      },
      record,
    );
    return { ...sheet, entries: [...sheet.entries, created] };
  });
}

// ---- pending bookkeeping ---------------------------------------------------------------

/** True while a change to this member's row is being saved. Checked synchronously at tap time. */
export function isRowPending(queryClient: QueryClient, sessionId: string, userId: string): boolean {
  return (
    queryClient.isMutating({
      mutationKey: recordAttendanceKey(sessionId),
      predicate: (mutation) =>
        mutation.state.status === 'pending' &&
        (mutation.state.variables as MarkVariables | undefined)?.userId === userId,
    }) > 0
  );
}

/** Number of row changes being saved for the session. */
export function pendingRowCount(queryClient: QueryClient, sessionId: string): number {
  return queryClient.isMutating({ mutationKey: recordAttendanceKey(sessionId) });
}

/**
 * Invalidates the session's sheet unless row changes are in flight. A read
 * started now would return the state from before them and flip the optimistic
 * rows back; each change's own `onSettled` refetches once the last one is done.
 *
 * `selfSettling`: call from a mutation's `onSettled`, where TanStack still
 * counts that mutation as pending (it is marked finished after the callback),
 * so "others in flight" means a count above 1.
 */
export function invalidateSheetUnlessPending(
  queryClient: QueryClient,
  sessionId: string,
  options: { selfSettling?: boolean } = {},
): void {
  const others = pendingRowCount(queryClient, sessionId) - (options.selfSettling ? 1 : 0);
  if (others > 0) return;
  void queryClient.invalidateQueries({ queryKey: attendanceKeys.sheet(sessionId) });
}

/** Realtime: invalidate attendance queries unless a row change is in flight for any session. */
export function invalidateAttendanceUnlessPending(queryClient: QueryClient): void {
  if (queryClient.isMutating({ mutationKey: ['attendance', 'record'] }) > 0) return;
  void queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
}
