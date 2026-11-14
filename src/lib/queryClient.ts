/**
 * TanStack Query setup: one client, plus the React Native wiring for
 * "refetch when the app comes back" and "refetch when the connection returns".
 */
import NetInfo from '@react-native-community/netinfo';
import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';

import { toAppError } from './errors';

const MAX_NETWORK_RETRIES = 2;

/** Retry only what can succeed on a second try: a failed connection. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return toAppError(error).code === 'network_error' && failureCount < MAX_NETWORK_RETRIES;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: shouldRetryQuery,
        refetchOnReconnect: true,
        refetchOnWindowFocus: true,
      },
      // Mutations are never retried automatically: a retry could repeat a side effect.
      mutations: { retry: false },
    },
  });
}

export const queryClient = createQueryClient();

let bound = false;

/**
 * Connects TanStack Query's focus and online state to the device. On web the
 * library's own window listeners already do this. Safe to call more than once.
 */
export function bindQueryLifecycle(): void {
  if (bound || Platform.OS === 'web') return;
  bound = true;

  focusManager.setEventListener((handleFocus) => {
    const subscription = AppState.addEventListener('change', (state) => {
      handleFocus(state === 'active');
    });
    return () => subscription.remove();
  });

  onlineManager.setEventListener((setOnline) =>
    NetInfo.addEventListener((state) => {
      // `isConnected` is null until the first reading: treat unknown as online
      // so nothing is paused on a guess.
      setOnline(state.isConnected !== false);
    }),
  );
}
