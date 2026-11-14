import { ensureSession } from '@/features/community/api/session';
import type {
  MembershipRole,
  PreviewInvitationResult,
  RedeemInvitationResult,
} from '@/lib/database.types';
import { appErrorFromResult, toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

import { normalizeInvitationCode } from '../domain/invitationCode';

export type InvitationPreview = { communityName: string; role: MembershipRole };

export type RedeemedInvitation = {
  communityId: string;
  membershipId: string;
  role: MembershipRole;
  alreadyMember: boolean;
};

/**
 * Checks a code without redeeming it. Counts toward the server's rate limit.
 * Throws AppError: `invalid_code`, `expired`, `revoked`, `exhausted`,
 * `rate_limited`, `network_error`, ...
 */
export async function previewInvitation(code: string): Promise<InvitationPreview> {
  await ensureSession();
  const { data, error } = await getSupabase().rpc('preview_invitation', {
    p_code: normalizeInvitationCode(code),
  });
  if (error) throw toAppError(error);

  const result = data as PreviewInvitationResult | null;
  if (!result || !result.ok) throw appErrorFromResult(result?.error);
  return { communityName: result.community_name, role: result.role };
}

/**
 * Joins the community behind the code and saves the display name. An existing
 * member succeeds too (`alreadyMember`), keeping their current role.
 */
export async function redeemInvitation(
  code: string,
  displayName: string,
): Promise<RedeemedInvitation> {
  await ensureSession();
  const { data, error } = await getSupabase().rpc('redeem_invitation', {
    p_code: normalizeInvitationCode(code),
    p_display_name: displayName,
  });
  if (error) throw toAppError(error);

  const result = data as RedeemInvitationResult | null;
  if (!result || !result.ok) throw appErrorFromResult(result?.error);
  return {
    communityId: result.community_id,
    membershipId: result.membership_id,
    role: result.role,
    alreadyMember: result.already_member,
  };
}
