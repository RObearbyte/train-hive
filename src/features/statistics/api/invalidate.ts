import type { QueryClient } from '@tanstack/react-query';

import type { AttendanceSheet } from '@/lib/database.types';

import { statisticsKeys } from './keys';

/**
 * Marks every statistics query stale. `active` (default) also refetches the
 * ones on screen; `none` only marks them, so the Statistics tab refetches
 * them the next time it is shown.
 */
export function invalidateStatistics(
  queryClient: QueryClient,
  refetchType: 'active' | 'none' = 'active',
): void {
  void queryClient.invalidateQueries({ queryKey: statisticsKeys.all, refetchType });
}

/** True when a cached attendance sheet says the session is already finalized. */
export function isSheetFinalized(sheet: AttendanceSheet | undefined): boolean {
  return sheet !== undefined && (sheet.attendance_finalized_at !== null || sheet.status === 'completed');
}
