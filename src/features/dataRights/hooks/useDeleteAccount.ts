import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';

import { useSession } from '@/features/community/hooks/SessionProvider';
import { setPendingJoinCode } from '@/features/onboarding/domain/pendingJoin';
import { authStorage } from '@/lib/authStorage';
import type { DeletionBlocker, MyDeletionBlockers } from '@/lib/database.types';
import { toAppError, type AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { AUTH_STORAGE_KEY, getSupabase } from '@/lib/supabase';

import { deleteMyAccount, fetchDeletionBlockers } from '../api/dataRights';
import { classifyDeleteError, runAccountDeletedCleanup } from '../domain/deletion';
import { setAccountDeletedNotice } from '../domain/deletedNotice';

export const deletionKeys = {
  blockers: (userId: string | null) => ['dataRights', 'deletionBlockers', userId] as const,
};

/** What blocks deleting the account, read fresh every time the flow opens. */
export function useDeletionBlockers(enabled: boolean) {
  const { userId } = useSession();
  return useQuery<MyDeletionBlockers, AppError>({
    queryKey: deletionKeys.blockers(userId),
    queryFn: async () => {
      try {
        return await fetchDeletionBlockers();
      } catch (error) {
        throw toAppError(error);
      }
    },
    enabled: enabled && userId !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** Thrown by the mutation when the server refuses because of last-organizer communities. */
export class DeletionBlockedError extends Error {
  readonly communities: DeletionBlocker[];
  constructor(communities: DeletionBlocker[]) {
    super('last_organizer');
    this.name = 'DeletionBlockedError';
    this.communities = communities;
  }
}

/**
 * Deletes the account on the server, then does the same local cleanup as
 * signing out (the auth listener then moves the app to the welcome screen).
 * `not_authenticated` counts as "already deleted". Any other failure leaves
 * everything as it was, so the person can retry. A second call while one is
 * running is ignored.
 */
export function useDeleteAccount() {
  const queryClient = useQueryClient();
  const { userId } = useSession();
  const running = useRef(false);

  return useMutation<void, AppError | DeletionBlockedError, void>({
    mutationFn: async () => {
      if (running.current) return;
      running.current = true;
      try {
        try {
          await deleteMyAccount();
        } catch (error) {
          const outcome = classifyDeleteError(error);
          if (outcome.kind === 'blocked') throw new DeletionBlockedError(outcome.communities);
          if (outcome.kind === 'network') throw toAppError(error);
          if (outcome.kind === 'failed') throw outcome.error;
          // 'deleted': already gone on the server, continue with the cleanup.
        }
        await runAccountDeletedCleanup(
          {
            setNotice: setAccountDeletedNotice,
            // The account no longer exists on the server: end the session on this device only.
            signOutLocal: async () => {
              const { error } = await getSupabase().auth.signOut({ scope: 'local' });
              if (error) throw toAppError(error);
            },
            removeStored: (key) => authStorage.removeItem(key),
            clearQueryCache: () => queryClient.clear(),
            resetInMemoryState: () => setPendingJoinCode(null),
            report: (context, error) => reportError(context, toAppError(error).code),
          },
          { userId, authStorageKey: AUTH_STORAGE_KEY },
        );
      } finally {
        running.current = false;
      }
    },
    onError: (error) => {
      if (!(error instanceof DeletionBlockedError)) reportError('deleteAccount', error.code);
    },
  });
}
