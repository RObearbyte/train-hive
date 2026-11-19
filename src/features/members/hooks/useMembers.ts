import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { membershipKeys } from '@/features/community/api/keys';
import { useSession } from '@/features/community/hooks/SessionProvider';
import { statisticsKeys } from '@/features/statistics/api/keys';
import type { MembershipRole, MyCommunity } from '@/lib/database.types';
import { toAppError, type AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';

import { fetchRoster, leaveCommunity, removeMember, setMemberRole } from '../api/members';
import { withoutCommunity, type RosterEntry } from '../domain/memberActions';

/**
 * The organizers' view of every membership of the community. Under the
 * `membership` key prefix, so the membership Realtime events (own and other
 * members') refresh it too.
 */
export function useRoster(communityId: string | null, enabled = true) {
  return useQuery<RosterEntry[], AppError>({
    queryKey: membershipKeys.roster(communityId),
    queryFn: async () => {
      try {
        return await fetchRoster(communityId as string);
      } catch (error) {
        throw toAppError(error);
      }
    },
    enabled: enabled && communityId !== null,
    staleTime: 30_000,
  });
}

type RoleVariables = { userId: string; role: MembershipRole };

/** After a change the server's rows are read again: roster, member pickers, statistics (active members). */
function useRefreshMembers() {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: membershipKeys.all }),
      queryClient.invalidateQueries({ queryKey: statisticsKeys.all }),
    ]);
  };
}

export function useSetMemberRole(communityId: string) {
  const refresh = useRefreshMembers();
  return useMutation<void, AppError, RoleVariables>({
    mutationFn: async ({ userId, role }) => {
      try {
        await setMemberRole(communityId, userId, role);
      } catch (error) {
        throw toAppError(error);
      }
    },
    onError: (error) => reportError('members.setRole', error.code),
    onSettled: refresh,
  });
}

export function useRemoveMember(communityId: string) {
  const refresh = useRefreshMembers();
  return useMutation<void, AppError, { userId: string }>({
    mutationFn: async ({ userId }) => {
      try {
        await removeMember(communityId, userId);
      } catch (error) {
        throw toAppError(error);
      }
    },
    onError: (error) => reportError('members.remove', error.code),
    onSettled: refresh,
  });
}

/**
 * Leaves a community. On success it disappears from my communities at once (the
 * app then shows the next one, or onboarding when none is left) and every
 * membership query is read again.
 */
export function useLeaveCommunity() {
  const queryClient = useQueryClient();
  const { userId } = useSession();
  return useMutation<void, AppError, { communityId: string }>({
    mutationFn: async ({ communityId }) => {
      try {
        await leaveCommunity(communityId);
      } catch (error) {
        throw toAppError(error);
      }
    },
    onSuccess: async (_result, { communityId }) => {
      queryClient.setQueryData<MyCommunity[]>(membershipKeys.communities(userId), (list) =>
        list ? withoutCommunity(list, communityId) : list,
      );
      await queryClient.invalidateQueries({ queryKey: membershipKeys.all });
    },
    onError: (error) => {
      reportError('members.leave', error.code);
      // Already out (another device, or an organizer removed me): the lists are stale.
      if (error.code === 'not_a_member') void queryClient.invalidateQueries({ queryKey: membershipKeys.all });
    },
  });
}
