import type { AppOpenResult } from '@/lib/database.types';

/**
 * The app reports "opened" at most this often. The server limits itself to one write per hour as
 * well; this only saves calls. It is a throttle, not a rule: nothing is allowed or denied by it.
 */
export const APP_OPEN_MIN_INTERVAL_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a record_app_open call is due. `lastAttemptMs` is null when none was made for this account in this run. */
export function shouldRecordAppOpen(lastAttemptMs: number | null, nowMs: number): boolean {
  if (lastAttemptMs === null) return true;
  // A clock that moved backwards must not block the call for hours.
  if (nowMs < lastAttemptMs) return true;
  return nowMs - lastAttemptMs >= APP_OPEN_MIN_INTERVAL_MS;
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/** Checks the shape of the RPC result; null when it is not an AppOpenResult. */
export function parseAppOpenResult(data: unknown): AppOpenResult | null {
  if (typeof data !== 'object' || data === null) return null;
  const value = data as Record<string, unknown>;
  if (typeof value.inactivity_erasure_enabled !== 'boolean') return null;
  const notice = value.notice;
  if (notice !== null) {
    if (typeof notice !== 'object') return null;
    const n = notice as Record<string, unknown>;
    if (!isIsoInstant(n.noticed_at) || !isIsoInstant(n.erase_after)) return null;
  }
  return data as AppOpenResult;
}

/** Whole days from `nowMs` until `eraseAfter`, never below 0. Display only. */
export function daysUntil(eraseAfter: string, nowMs: number): number {
  const remaining = Date.parse(eraseAfter) - nowMs;
  if (Number.isNaN(remaining) || remaining <= 0) return 0;
  return Math.ceil(remaining / DAY_MS);
}

/** The one-time banner text for the notice that was pending before the app was opened; null without a notice. */
export function inactivityNoticeMessage(result: AppOpenResult, nowMs: number): string | null {
  if (result.notice === null) return null;
  const days = daysUntil(result.notice.erase_after, nowMs);
  const when = days === 0 ? 'soon' : days === 1 ? 'in 1 day' : `in ${days} days`;
  return `Your account was inactive for a long time and would be deleted ${when}. Opening the app keeps it.`;
}
