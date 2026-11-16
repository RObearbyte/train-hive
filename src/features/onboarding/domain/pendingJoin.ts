/**
 * A code that arrived through a web join link, waiting for the code screen.
 *
 * In memory only: a module variable, never localStorage, never a route
 * param. Lost on reload by design (the link brings it again).
 *
 * The wrapper `capturePendingJoinFromLocation` is the only part that touches
 * the browser; `readJoinLocation` is pure and tested.
 */
import { reportError } from '@/lib/logger';

import { isJoinPath, parseJoinFragment } from './joinLink';

let pending: string | null = null;

export function setPendingJoinCode(code: string | null): void {
  pending = code;
}

/** The waiting code (normalized), without clearing it. */
export function peekPendingJoinCode(): string | null {
  return pending;
}

/** Returns the waiting code and clears it. */
export function takePendingJoinCode(): string | null {
  const code = pending;
  pending = null;
  return code;
}

export type JoinLocation = {
  /** True when the address is the join route; the fragment is only read there. */
  isJoin: boolean;
  /** Normalized code from the fragment, or null. */
  code: string | null;
  /** The fragment is present and has to be removed from the address bar. */
  hasFragment: boolean;
};

export function readJoinLocation(pathname: string, hash: string): JoinLocation {
  const isJoin = isJoinPath(pathname);
  return { isJoin, code: isJoin ? parseJoinFragment(hash) : null, hasFragment: isJoin && hash !== '' && hash !== '#' };
}

/**
 * Web only, and as early as possible (called when the app module loads): if the
 * address is `/join#code=...`, keep the code in memory and remove the fragment
 * from the address bar with `history.replaceState`.
 */
export function capturePendingJoinFromLocation(): void {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return;
  const { pathname, search, hash } = window.location;
  const location = readJoinLocation(pathname, hash);
  if (!location.isJoin) return;
  if (location.code) pending = location.code;
  if (location.hasFragment) {
    try {
      window.history.replaceState(window.history.state, '', `${pathname}${search}`);
    } catch (error) {
      // A browser that refuses replaceState leaves the fragment; the code is already in memory.
      reportError('join.stripFragment', error);
    }
  }
}
