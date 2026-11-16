import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { Community, Membership, MyCommunity, Profile } from '@/lib/database.types';
import { toAppError, type AppError } from '@/lib/errors';

import { fetchMembershipIn, fetchMyCommunities, type CurrentMembership } from '../api/membership';
import { membershipKeys } from '../api/keys';
import {
  combineMembershipState,
  communitiesStateOf,
  detailStateOf,
  resolveActiveCommunityId,
} from '../domain/activeCommunity';
import type { MembershipState } from '../domain/gate';
import { roleInCommunity } from '../domain/sessionAccess';
import { useActiveCommunityStore } from './ActiveCommunityProvider';
import { useSession } from './SessionProvider';

export { membershipKeys };

const NO_COMMUNITIES: MyCommunity[] = [];

export type CurrentMembershipResult = {
  /** The active community (null while it loads, or when the user has none). */
  community: Community | null;
  membership: Membership | null;
  profile: Profile | null;
  isOrganizer: boolean;
  /** Every community the user is an active member of, oldest first. */
  communities: MyCommunity[];
  /** The id of the active community, known as soon as the list is. */
  activeCommunityId: string | null;
  /** Makes another community of the user's the active one; it is remembered on this device. */
  selectCommunity: (communityId: string) => void;
  /** For the route gate. */
  state: MembershipState;
  isLoading: boolean;
  isRefetching: boolean;
  error: AppError | null;
  refetch: () => Promise<unknown>;
};

/**
 * The signed-in user's communities and the ACTIVE one with its membership and
 * profile. The active community is the stored choice while it is still an
 * active membership, else the earliest (`resolveActiveCommunityId`). Every
 * community-dependent query reads `community?.id` from here, so switching
 * moves the whole app, and every key carries the id so caches never mix.
 * `isOrganizer` only decides what the UI offers; every organizer action is
 * authorized again on the server.
 */
export function useCurrentMembership(): CurrentMembershipResult {
  const { userId } = useSession();
  const queryClient = useQueryClient();
  const { storedId, loaded, select } = useActiveCommunityStore();

  const list = useQuery<MyCommunity[]>({
    queryKey: membershipKeys.communities(userId),
    queryFn: fetchMyCommunities,
    enabled: userId !== null,
  });

  const communities = list.data ?? NO_COMMUNITIES;
  const activeCommunityId = loaded ? resolveActiveCommunityId(communities, storedId) : null;

  const detail = useQuery<CurrentMembership>({
    queryKey: membershipKeys.current(userId, activeCommunityId),
    queryFn: async () => {
      try {
        return await fetchMembershipIn(userId as string, activeCommunityId as string);
      } catch (error) {
        // Removed from this community since the list was read: refresh the list.
        if (toAppError(error).code === 'not_a_member') {
          void queryClient.invalidateQueries({ queryKey: membershipKeys.communities(userId) });
        }
        throw error;
      }
    },
    enabled: userId !== null && activeCommunityId !== null,
  });

  const state = combineMembershipState({
    list: communitiesStateOf(list),
    storageLoaded: loaded,
    detail: detailStateOf(detail),
  });

  const data = detail.data ?? null;
  const failure = list.error ?? (activeCommunityId !== null ? detail.error : null);

  return {
    community: data?.community ?? null,
    membership: data?.membership ?? null,
    profile: data?.profile ?? null,
    // The list knows the role before the detail has loaded, so organizer sections do not flicker on a switch.
    isOrganizer: (data?.membership.role ?? roleInCommunity(communities, activeCommunityId)) === 'organizer',
    communities,
    activeCommunityId,
    selectCommunity: select,
    state,
    isLoading: state === 'pending',
    isRefetching: list.isRefetching || detail.isRefetching,
    error: failure ? toAppError(failure) : null,
    refetch: async () => {
      await list.refetch();
      if (activeCommunityId !== null) await detail.refetch();
    },
  };
}
