/**
 * TanStack Query setup: one client, plus the React Native wiring for
 * "refetch when the app comes back" and "refetch when the connection returns".
 */
import NetInfo from '@react-native-community/netinfo';
import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';

import { queryDefaultOptions } from './queryDefaults';

export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: queryDefaultOptions });
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
