import type { Community, Membership, MyCommunity, Profile } from '@/lib/database.types';
import { AppError, toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

import { parseMyCommunities } from '../domain/activeCommunity';

export type CurrentMembership = {
  membership: Membership;
  community: Community;
  /** Null only if the profile row is missing, which redeeming an invitation prevents. */
  profile: Profile | null;
};

/**
 * Every community the user is an active member of, oldest membership first
 * (one `list_my_communities` call). A removed member's memberships are not
 * listed, so "removed from everything" and "never joined" both give `[]`.
 */
export async function fetchMyCommunities(): Promise<MyCommunity[]> {
  const { data, error } = await getSupabase().rpc('list_my_communities');
  if (error) throw toAppError(error);
  try {
    return parseMyCommunities(data);
  } catch (parseError) {
    throw toAppError(parseError);
  }
}

/**
 * The user's active membership in one community, with the community row and
 * the user's profile. Throws `not_a_member` when there is none (removed in
 * the meantime), so the caller can refresh the list of communities.
 */
export async function fetchMembershipIn(
  userId: string,
  communityId: string,
): Promise<CurrentMembership> {
  const supabase = getSupabase();

  const [membershipResult, profileResult] = await Promise.all([
    supabase
      .from('memberships')
      .select('*, community:communities(*)')
      .eq('user_id', userId)
      .eq('community_id', communityId)
      .eq('status', 'active')
      .maybeSingle(),
    supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
  ]);
  if (membershipResult.error) throw toAppError(membershipResult.error);
  if (profileResult.error) throw toAppError(profileResult.error);

  const row = membershipResult.data;
  if (!row?.community) throw new AppError('not_a_member', { message: 'No active membership.' });
  const { community, ...membership } = row;
  return { membership, community, profile: profileResult.data };
}
