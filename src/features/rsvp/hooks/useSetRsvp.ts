import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';

import { useSession } from '@/features/community/hooks/SessionProvider';
import { membershipKeys } from '@/features/community/hooks/useCurrentMembership';
import { rsvpKeys, trainingKeys } from '@/features/trainings/api/keys';
import type { RsvpResponse, SetRsvpResult } from '@/lib/database.types';
import type { AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';

import { setRsvp } from '../api/rsvp';
import {
  applyRsvpToCache,
  reconcileRsvpInCache,
  rollbackRsvpInCache,
  rsvpAffectedKeys,
  type RsvpCacheSnapshot,
} from '../domain/rsvpCache';

type Variables = { previous: RsvpResponse; next: RsvpResponse };

const setRsvpKey = (sessionId: string) => ['rsvps', 'set', sessionId] as const;

export type SetRsvp = {
  /** Change my answer. Ignored while a change for this session is being saved. */
  submit: (previous: RsvpResponse, next: RsvpResponse) => void;
  /** A change for this session is in flight (from any screen showing it). */
  isPending: boolean;
  /** Why the last change failed; the optimistic update has already been undone. */
  error: AppError | null;
  clearError: () => void;
};

/**
 * Optimistic RSVP for one session:
 * 1. cancel in-flight reads that could overwrite the optimistic state;
 * 2. snapshot and apply the change to every cached copy;
 * 3. on error put the snapshot back exactly;
 * 4. on success take the server's count / status / answer;
 * 5. either way refetch, so the screen ends on server truth (this is what
 *    shows the real state after `rsvp_closed` or `session_full`).
 *
 * One change at a time per session: a tap while one is pending is ignored,
 * so rapid taps cannot stack deltas on the count.
 */
export function useSetRsvp(sessionId: string): SetRsvp {
  const queryClient = useQueryClient();
  const { userId } = useSession();
  const mutationKey = setRsvpKey(sessionId);

  const mutation = useMutation<SetRsvpResult, AppError, Variables, RsvpCacheSnapshot | undefined>({
    mutationKey,
    mutationFn: ({ next }) => setRsvp(sessionId, next),

    onMutate: async ({ previous, next }) => {
      if (userId === null) return undefined;
      const change = { sessionId, userId, previous, next };
      await Promise.all(
        rsvpAffectedKeys(change).map((queryKey) => queryClient.cancelQueries({ queryKey })),
      );
      return applyRsvpToCache(queryClient, change);
    },

    onError: (error, _variables, snapshot) => {
      if (snapshot) rollbackRsvpInCache(queryClient, snapshot);
      reportError('rsvp.set', error);
      // No longer a member: let the app gate find out now rather than on the next focus.
      if (error.code === 'not_a_member') {
        void queryClient.invalidateQueries({ queryKey: membershipKeys.all });
      }
    },

    onSuccess: (result) => {
      if (userId !== null) reconcileRsvpInCache(queryClient, { sessionId, userId }, result);
    },

    // Not awaited: the control unlocks when the RPC answers, not when the
    // refetches finish. A tap in between cancels them again in onMutate.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: trainingKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: trainingKeys.detail(sessionId) });
      void queryClient.invalidateQueries({ queryKey: trainingKeys.participants(sessionId) });
      void queryClient.invalidateQueries({ queryKey: rsvpKeys.all });
    },
  });

  // Counts mutations for this session from every mounted card, not only this hook.
  const isPending = useIsMutating({ mutationKey }) > 0;

  return {
    submit: (previous, next) => {
      // Checked on the client synchronously: state from the last render could be one tap behind.
      if (queryClient.isMutating({ mutationKey }) > 0) return;
      if (previous === next) return;
      mutation.mutate({ previous, next });
    },
    isPending,
    error: mutation.error,
    clearError: mutation.reset,
  };
}
