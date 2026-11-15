/**
 * Collects keys for a short time and hands them over once, so a burst of
 * Realtime events (ten people answering at the same minute) causes one
 * refetch per query instead of ten.
 *
 * Trailing-edge with a cap: every new key restarts the wait, but the flush
 * happens at most `maxWaitMs` after the first key, so a steady stream of
 * events cannot postpone the refresh forever. Pure: timers are injected.
 */

export type Timers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: never) => void;
  now: () => number;
};

const realTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  now: () => Date.now(),
};

export type Coalescer<K> = {
  /** Queue a key; duplicates within one window are merged. */
  add: (key: K) => void;
  /** Deliver anything queued right away. */
  flush: () => void;
  /** Drop anything queued and stop the timer (on unmount / sign-out). */
  cancel: () => void;
};

export function createCoalescer<K>(
  onFlush: (keys: K[]) => void,
  options: { delayMs: number; maxWaitMs: number; timers?: Timers },
): Coalescer<K> {
  const timers = options.timers ?? realTimers;
  const pending = new Set<K>();
  let handle: unknown = null;
  let firstQueuedAt: number | null = null;

  const stop = () => {
    if (handle !== null) timers.clearTimeout(handle as never);
    handle = null;
  };

  const flush = () => {
    stop();
    firstQueuedAt = null;
    if (pending.size === 0) return;
    const keys = [...pending];
    pending.clear();
    onFlush(keys);
  };

  return {
    add(key) {
      pending.add(key);
      const now = timers.now();
      firstQueuedAt ??= now;
      const remainingCap = firstQueuedAt + options.maxWaitMs - now;
      stop();
      handle = timers.setTimeout(flush, Math.max(0, Math.min(options.delayMs, remainingCap)));
    },
    flush,
    cancel() {
      stop();
      firstQueuedAt = null;
      pending.clear();
    },
  };
}

/** What a Realtime change can make stale. */
export type RealtimeTopic = 'sessions' | 'rsvps' | 'membership';

/** Which topics a change to a table invalidates; unknown tables invalidate nothing. */
export function topicsForTable(table: string): RealtimeTopic[] {
  switch (table) {
    case 'training_sessions':
      return ['sessions'];
    case 'training_rsvps':
      // An RSVP changes the session's going_count too (same transaction).
      return ['rsvps', 'sessions'];
    case 'memberships':
      return ['membership'];
    default:
      return [];
  }
}

/** Delay before trying to subscribe again: 1s, 2s, 4s ... capped at 30s. */
export function resubscribeDelayMs(attempt: number): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(30_000, 1000 * 2 ** Math.min(safeAttempt, 10));
}
