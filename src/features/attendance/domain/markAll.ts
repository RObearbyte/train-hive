/**
 * "Mark all present": runs one change per row, one after another, reporting
 * progress and keeping every failure. Pure: the worker does the network call.
 */
import { toAppError, type AppErrorCode } from '@/lib/errors';

export type MarkAllProgress = { done: number; total: number };

export type MarkAllFailure<T> = { id: T; code: AppErrorCode; message: string };

export type MarkAllResult<T> = {
  succeeded: T[];
  failed: MarkAllFailure<T>[];
  /** Not attempted because an earlier failure made the rest pointless. */
  skipped: T[];
};

/**
 * Failures that will repeat for every remaining row (the session, the
 * caller or the connection is the problem, not the one row), so the run stops.
 */
const RUN_ENDING_CODES: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  'not_authenticated',
  'forbidden',
  'not_found',
  'session_not_confirmed',
  'session_not_ended',
  'network_error',
]);

export function endsMarkAllRun(code: AppErrorCode): boolean {
  return RUN_ENDING_CODES.has(code);
}

export async function runMarkAll<T>(
  ids: readonly T[],
  worker: (id: T) => Promise<unknown>,
  onProgress?: (progress: MarkAllProgress) => void,
): Promise<MarkAllResult<T>> {
  const result: MarkAllResult<T> = { succeeded: [], failed: [], skipped: [] };
  const total = ids.length;
  onProgress?.({ done: 0, total });

  for (let index = 0; index < total; index += 1) {
    const id = ids[index] as T;
    try {
      await worker(id);
      result.succeeded.push(id);
    } catch (error) {
      const appError = toAppError(error);
      result.failed.push({ id, code: appError.code, message: appError.message });
      if (endsMarkAllRun(appError.code)) {
        result.skipped.push(...ids.slice(index + 1));
        onProgress?.({ done: total, total });
        return result;
      }
    }
    onProgress?.({ done: index + 1, total });
  }
  return result;
}

/** Plain summary line of a finished run. */
export function markAllSummary(result: MarkAllResult<unknown>): string {
  const ok = result.succeeded.length;
  const failed = result.failed.length;
  const skipped = result.skipped.length;
  if (failed === 0 && skipped === 0) return `Marked ${ok} ${ok === 1 ? 'person' : 'people'} present.`;
  const parts = [`Marked ${ok} present`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} not attempted`);
  return `${parts.join(', ')}.`;
}
