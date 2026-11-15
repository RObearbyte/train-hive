import type { MembershipRole } from '@/lib/database.types';
import { toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

export type CommunityMember = {
  userId: string;
  displayName: string;
  role: MembershipRole;
};

/**
 * Active members of a community, by name. RLS lets every active member read
 * the community's memberships and their profiles. memberships has one
 * foreign key to profiles; the name keeps the embed unambiguous.
 */
export async function fetchCommunityMembers(communityId: string): Promise<CommunityMember[]> {
  const { data, error } = await getSupabase()
    .from('memberships')
    .select('user_id, role, profile:profiles!memberships_user_id_fkey(display_name)')
    .eq('community_id', communityId)
    .eq('status', 'active');
  if (error) throw toAppError(error);
  return data
    .map((row) => ({
      userId: row.user_id,
      displayName: row.profile?.display_name ?? 'Member',
      role: row.role,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' }));
}
