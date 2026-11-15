import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useSession } from '@/features/community/hooks/SessionProvider';
import { toAppError, type AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';

import { fetchNotificationPreferences, saveNotificationPreferences } from '../api/preferences';
import { activityKeys } from '../api/keys';
import {
  applyOptimisticPrefs,
  rollbackPrefs,
  type NotificationPrefs,
  type PrefsPatch,
  type PrefsSnapshot,
} from '../domain/preferencesCache';

export function useNotificationPreferences() {
  const { userId } = useSession();
  const query = useQuery({
    queryKey: activityKeys.preferences(userId),
    queryFn: fetchNotificationPreferences,
    enabled: userId !== null,
  });
  return {
    prefs: query.data ?? null,
    isLoading: query.isPending,
    error: query.error ? toAppError(query.error) : null,
    refetch: () => {
      query.refetch().catch((error: unknown) => reportError('preferences.refetch', error));
    },
  };
}

/** Optimistic toggle: the switch moves at once and snaps back, with the error shown, if the server refuses. */
export function useSetNotificationPreferences() {
  const queryClient = useQueryClient();
  const { userId } = useSession();
  return useMutation<NotificationPrefs, AppError, PrefsPatch, PrefsSnapshot>({
    mutationFn: saveNotificationPreferences,
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: activityKeys.preferences(userId) });
      return applyOptimisticPrefs(queryClient, userId, patch);
    },
    onError: (error, _patch, snapshot) => {
      reportError('preferences.save', error);
      if (snapshot) rollbackPrefs(queryClient, snapshot);
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: activityKeys.preferences(userId) }),
  });
}
