import type { LeaveCommunityResult, MembershipRole } from '@/lib/database.types';
import { toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

import type { RosterEntry } from '../domain/memberActions';

/**
 * Every membership of the community, removed ones included. RLS lets active
 * members read all memberships of their community; profiles only of people who
 * are still active in a shared community, so a removed person's name comes
 * back null (shown as "Former member").
 */
export async function fetchRoster(communityId: string): Promise<RosterEntry[]> {
  const { data, error } = await getSupabase()
    .from('memberships')
    .select('id, user_id, role, status, joined_at, profile:profiles!memberships_user_id_fkey(display_name)')
    .eq('community_id', communityId);
  if (error) throw toAppError(error);
  return data.map((row) => ({
    membershipId: row.id,
    userId: row.user_id,
    displayName: row.profile?.display_name ?? null,
    role: row.role,
    status: row.status,
    joinedAt: row.joined_at,
  }));
}

/** `set_member_role`: organizers only. Throws AppError (`forbidden`, `cannot_change_own_role`, `not_found`, `last_organizer`, ...). */
export async function setMemberRole(communityId: string, userId: string, role: MembershipRole): Promise<void> {
  const { error } = await getSupabase().rpc('set_member_role', {
    p_community_id: communityId,
    p_user_id: userId,
    p_role: role,
  });
  if (error) throw toAppError(error);
}

/** `remove_member`: organizers only. Throws AppError (`forbidden`, `cannot_remove_self`, `not_found`, ...). */
export async function removeMember(communityId: string, userId: string): Promise<void> {
  const { error } = await getSupabase().rpc('remove_member', {
    p_community_id: communityId,
    p_user_id: userId,
  });
  if (error) throw toAppError(error);
}

/** `leave_community`: any member. Throws AppError (`last_organizer`, `not_a_member`, ...). */
export async function leaveCommunity(communityId: string): Promise<LeaveCommunityResult> {
  const { data, error } = await getSupabase().rpc('leave_community', { p_community_id: communityId });
  if (error) throw toAppError(error);
  return data as LeaveCommunityResult;
}
