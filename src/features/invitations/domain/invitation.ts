/**
 * Invitation state for the organizer's list. Display only: `now` is injected
 * and the server decides whether a code can actually be redeemed.
 */
import type { InvitationCode } from '@/lib/database.types';

export type InvitationState = 'active' | 'expired' | 'revoked' | 'exhausted';

type InvitationFields = Pick<
  InvitationCode,
  'expires_at' | 'max_redemptions' | 'redemption_count' | 'revoked_at'
>;

/** Uses left, or null when the code has no limit. Never negative. */
export function remainingUses(
  invitation: Pick<InvitationCode, 'max_redemptions' | 'redemption_count'>,
): number | null {
  if (invitation.max_redemptions === null) return null;
  return Math.max(0, invitation.max_redemptions - invitation.redemption_count);
}

/**
 * When several apply, the most deliberate wins: revoked, then expired, then
 * exhausted. A code expires AT `expires_at` (inclusive).
 */
export function invitationState(invitation: InvitationFields, now: Date): InvitationState {
  if (invitation.revoked_at !== null) return 'revoked';
  if (
    invitation.expires_at !== null &&
    new Date(invitation.expires_at).getTime() <= now.getTime()
  ) {
    return 'expired';
  }
  if (remainingUses(invitation) === 0) return 'exhausted';
  return 'active';
}

/** "Unlimited uses", "1 use left", "3 uses left", "No uses left". */
export function remainingUsesText(
  invitation: Pick<InvitationCode, 'max_redemptions' | 'redemption_count'>,
): string {
  const remaining = remainingUses(invitation);
  if (remaining === null) return 'Unlimited uses';
  if (remaining === 0) return 'No uses left';
  return remaining === 1 ? '1 use left' : `${remaining} uses left`;
}
