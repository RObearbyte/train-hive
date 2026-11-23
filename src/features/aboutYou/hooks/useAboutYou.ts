import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useSession } from '@/features/community/hooks/SessionProvider';
import { consentKeys } from '@/features/legal/api/keys';
import type { AboutYou } from '@/lib/database.types';
import { toAppError, type AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';

import { clearMyAboutYou, fetchMyAboutYou, saveMyAboutYou } from '../api/aboutYou';
import { aboutYouKeys } from '../api/keys';
import { readAboutYouSeen, writeAboutYouSeen } from '../api/promptStorage';
import type { SaveRequest } from '../domain/aboutYou';
import { aboutYouAvailable, promptState, type PromptState } from '../domain/prompt';

/** My own About-you details, with the allowed birth-year range and which agreements are on record. */
export function useMyAboutYou() {
  const { userId } = useSession();
  return useQuery<AboutYou, AppError>({
    queryKey: aboutYouKeys.mine(userId),
    queryFn: () => fetchMyAboutYou().catch((error: unknown) => Promise.reject(toAppError(error))),
    enabled: userId !== null,
  });
}

/** After a change the server's copy, the agreements and anything an organizer would read are read again. */
function useRefreshAboutYou() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: aboutYouKeys.all });
    void queryClient.invalidateQueries({ queryKey: consentKeys.all });
  };
}

/**
 * Records the agreements the new details need, then saves them. Not
 * optimistic: the server decides (agreement, validation) and returns the
 * stored copy, which replaces the cached one.
 */
export function useSaveAboutYou() {
  const queryClient = useQueryClient();
  const { userId } = useSession();
  const refresh = useRefreshAboutYou();
  return useMutation<AboutYou, AppError, SaveRequest>({
    mutationFn: async ({ input, consents }) => {
      try {
        return await saveMyAboutYou(input, consents);
      } catch (error) {
        throw toAppError(error);
      }
    },
    onSuccess: (saved) => queryClient.setQueryData(aboutYouKeys.mine(userId), saved),
    onError: (error) => reportError('aboutYou.save', error.code),
    onSettled: refresh,
  });
}

/** "Clear my About-you data": deletes everything stored; the agreements stay. */
export function useClearAboutYou() {
  const queryClient = useQueryClient();
  const { userId } = useSession();
  const refresh = useRefreshAboutYou();
  return useMutation<AboutYou, AppError, void>({
    mutationFn: async () => {
      try {
        return await clearMyAboutYou();
      } catch (error) {
        throw toAppError(error);
      }
    },
    onSuccess: (cleared) => queryClient.setQueryData(aboutYouKeys.mine(userId), cleared),
    onError: (error) => reportError('aboutYou.clear', error.code),
    onSettled: refresh,
  });
}

const promptKey = (userId: string | null) => ['aboutYou', 'prompt', userId] as const;

/**
 * Whether the one-time About-you page is due, from a note on this device. Not
 * a rule: nothing depends on it, it only avoids asking twice.
 */
export function useAboutYouPrompt(): { state: PromptState; markSeen: () => Promise<void> } {
  const queryClient = useQueryClient();
  const { userId } = useSession();
  const available = aboutYouAvailable();

  const query = useQuery<boolean>({
    queryKey: promptKey(userId),
    queryFn: () => readAboutYouSeen(userId as string),
    enabled: available && userId !== null,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

  const readError = query.error;
  useEffect(() => {
    if (readError) reportError('aboutYou.readSeen', readError);
  }, [readError]);

  const state = promptState({
    available: available && userId !== null,
    seen: query.isError ? null : query.data,
  });

  const markSeen = async () => {
    if (userId === null) return;
    queryClient.setQueryData(promptKey(userId), true);
    try {
      await writeAboutYouSeen(userId);
    } catch (error) {
      // The note is only a convenience: failing to keep it means the page may show once more.
      reportError('aboutYou.writeSeen', error);
    }
  };

  return { state, markSeen };
}
