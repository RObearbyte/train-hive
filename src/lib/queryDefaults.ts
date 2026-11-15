/**
 * TanStack Query defaults, kept free of react-native imports so tests load
 * the real thing.
 */
import type { DefaultOptions } from '@tanstack/react-query';

import { toAppError } from './errors';

const MAX_NETWORK_RETRIES = 2;

/** Retry only what can succeed on a second try: a failed connection. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return toAppError(error).code === 'network_error' && failureCount < MAX_NETWORK_RETRIES;
}

/**
 * `networkMode: 'always'` everywhere: the library's default ('online') pauses
 * a request while NetInfo says offline, so a cold start in airplane mode would
 * wait forever on the splash screen and an offline RSVP would sit as a held
 * request and be sent late. With 'always' the request is attempted, fails as
 * `network_error`, and the existing error / retry states and rollbacks apply.
 * Coming back online still refetches (`refetchOnReconnect`).
 */
export const queryDefaultOptions: DefaultOptions = {
  queries: {
    staleTime: 30_000,
    retry: shouldRetryQuery,
    networkMode: 'always',
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  },
  // Mutations are never retried automatically: a retry could repeat a side effect.
  mutations: { retry: false, networkMode: 'always' },
};
