import { useQuery } from '@tanstack/react-query';

import { fetchCommunityMembers, type CommunityMember } from '../api/members';
import { membershipKeys } from '../api/keys';

/**
 * Active members of the community. The key sits under the `membership` prefix,
 * so a membership change from Realtime refreshes it too.
 */
export function useCommunityMembers(communityId: string | null, enabled = true) {
  return useQuery<CommunityMember[]>({
    queryKey: membershipKeys.members(communityId),
    queryFn: () => fetchCommunityMembers(communityId as string),
    enabled: enabled && communityId !== null,
    staleTime: 60_000,
  });
}
