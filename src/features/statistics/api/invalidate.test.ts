import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import type { AttendanceSheet } from '@/lib/database.types';

import { invalidateAttendanceUnlessPending } from '../../attendance/domain/sheetCache';
import { invalidateStatistics, isSheetFinalized } from './invalidate';
import { statisticsKeys } from './keys';

function seeded(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(statisticsKeys.mine('c', 'u', '30d'), { eligible: 1 });
  client.setQueryData(statisticsKeys.community('c', '30d'), { completed_trainings: 1 });
  client.setQueryData(['attendance', 'sheet', 's1'], { status: 'completed' });
  return client;
}

describe('invalidateStatistics', () => {
  it('marks every statistics query stale and leaves other queries alone', () => {
    const client = seeded();
    invalidateStatistics(client, 'none');
    expect(client.getQueryState(statisticsKeys.mine('c', 'u', '30d'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(statisticsKeys.community('c', '30d'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(['attendance', 'sheet', 's1'])?.isInvalidated).toBe(false);
  });

  it('refetches the ones that are on screen (active) by default', async () => {
    const client = new QueryClient();
    const queryFn = vi.fn().mockResolvedValue({ eligible: 1 });
    const observer = new QueryObserver(client, { queryKey: statisticsKeys.mine('c', 'u', '7d'), queryFn });
    const stop = observer.subscribe(() => {});
    await vi.waitFor(() => expect(client.getQueryData(statisticsKeys.mine('c', 'u', '7d'))).toBeDefined());
    invalidateStatistics(client);
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    stop();
  });
});

describe('the attendance realtime coalescer', () => {
  it('also marks statistics stale', () => {
    const client = seeded();
    invalidateAttendanceUnlessPending(client);
    expect(client.getQueryState(statisticsKeys.mine('c', 'u', '30d'))?.isInvalidated).toBe(true);
  });
});

describe('isSheetFinalized', () => {
  const sheet = (over: Partial<AttendanceSheet>): AttendanceSheet => ({
    session_id: 's1',
    status: 'confirmed',
    ended: true,
    attendance_finalized_at: null,
    attendance_finalized_by: null,
    entries: [],
    ...over,
  });

  it('is true once finalized, false before and without a sheet', () => {
    expect(isSheetFinalized(undefined)).toBe(false);
    expect(isSheetFinalized(sheet({}))).toBe(false);
    expect(isSheetFinalized(sheet({ attendance_finalized_at: '2026-11-01T00:00:00Z' }))).toBe(true);
    expect(isSheetFinalized(sheet({ status: 'completed' }))).toBe(true);
  });
});
