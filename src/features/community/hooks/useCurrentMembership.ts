import { useQuery } from '@tanstack/react-query';

import type { Community, Membership, Profile } from '@/lib/database.types';
import { toAppError, type AppError } from '@/lib/errors';

import { fetchCurrentMembership, type CurrentMembership } from '../api/membership';
import type { MembershipState } from '../domain/gate';
import { useSession } from './SessionProvider';

export const membershipKeys = {
  all: ['membership'] as const,
  current: (userId: string | null) => ['membership', 'current', userId] as const,
};

export type CurrentMembershipResult = {
  community: Community | null;
  membership: Membership | null;
  profile: Profile | null;
  isOrganizer: boolean;
  /** For the route gate. */
  state: MembershipState;
  isLoading: boolean;
  isRefetching: boolean;
  error: AppError | null;
  refetch: () => Promise<unknown>;
};

/**
 * The signed-in user's community, membership and profile. `isOrganizer` only
 * decides what the UI offers; every organizer action is authorized again on
 * the server.
 */
export function useCurrentMembership(): CurrentMembershipResult {
  const { userId } = useSession();

  const query = useQuery<CurrentMembership | null>({
    queryKey: membershipKeys.current(userId),
    queryFn: () => fetchCurrentMembership(userId as string),
    enabled: userId !== null,
  });

  const data = query.data ?? null;
  let state: MembershipState;
  if (query.data !== undefined) state = query.data === null ? 'none' : 'active';
  else state = query.isError ? 'error' : 'pending';

  return {
    community: data?.community ?? null,
    membership: data?.membership ?? null,
    profile: data?.profile ?? null,
    isOrganizer: data?.membership.role === 'organizer',
    state,
    isLoading: query.isPending,
    isRefetching: query.isRefetching,
    error: query.error ? toAppError(query.error) : null,
    refetch: query.refetch,
  };
}
