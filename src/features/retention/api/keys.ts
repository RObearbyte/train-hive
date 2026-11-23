import type { AppOpenResult } from '@/lib/database.types';

/**
 * Query cache entry (set by `useRecordAppOpen`, read by `useInactivityNotice`):
 * `{ result: AppOpenResult, receivedAt: number }` while the one-time notice is waiting to be
 * shown, `null` once dismissed. Not fetched by a query: the value only ever comes from the RPC.
 */
export const inactivityNoticeKey = ['retention', 'inactivityNotice'] as const;

export type InactivityNoticeEntry = { result: AppOpenResult; receivedAt: number } | null;
