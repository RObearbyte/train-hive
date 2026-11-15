import type { InvitationCode } from '@/lib/database.types';
import { toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

/** Newest codes kept in the organizer's list. */
export const INVITATION_LIST_LIMIT = 100;

/**
 * The community's invitation codes, newest first. RLS returns rows only to
 * organizers of that community; anyone else gets an empty list.
 */
export async function fetchInvitations(communityId: string): Promise<InvitationCode[]> {
  const { data, error } = await getSupabase()
    .from('invitation_codes')
    .select('*')
    .eq('community_id', communityId)
    .order('created_at', { ascending: false })
    .limit(INVITATION_LIST_LIMIT);
  if (error) throw toAppError(error);
  return data;
}

export type NewInvitation = {
  /** UTC ISO time, or null for a code that never expires. */
  expiresAt: string | null;
  /** Null for unlimited uses. */
  maxRedemptions: number | null;
};

/**
 * Creates a member invitation (organizer only). Throws AppError: `forbidden`,
 * `validation_failed` with field `expires_at` or `max_redemptions`, `network_error`, ...
 */
export async function createInvitation(
  communityId: string,
  invitation: NewInvitation,
): Promise<InvitationCode> {
  const { data, error } = await getSupabase().rpc('create_invitation', {
    p_community_id: communityId,
    p_expires_at: invitation.expiresAt,
    p_max_redemptions: invitation.maxRedemptions,
  });
  if (error) throw toAppError(error);
  return data;
}

/** Revokes a code (organizer only, idempotent). Throws AppError: `forbidden`, `not_found`, ... */
export async function revokeInvitation(invitationId: string): Promise<InvitationCode> {
  const { data, error } = await getSupabase().rpc('revoke_invitation', {
    p_invitation_id: invitationId,
  });
  if (error) throw toAppError(error);
  return data;
}
