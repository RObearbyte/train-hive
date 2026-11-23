/**
 * The "Invite someone" sheet: defaults, who sees the round button, and the
 * small state machine behind the sheet. Pure.
 */
import type { InvitationCode } from '@/lib/database.types';
import type { AppErrorCode } from '@/lib/errors';

import type { NewInvitation } from '../api/invitations';
import { expiryHoursFromPreset } from './createInvitation';

export const QUICK_INVITE_DEFAULTS = { expiry: '30d', maxUses: 1 } as const;

/** The request for one tap: expires 30 days after the SERVER's clock, one use. */
export function quickInviteRequest(): NewInvitation {
  return {
    expiresInHours: expiryHoursFromPreset(QUICK_INVITE_DEFAULTS.expiry),
    maxRedemptions: QUICK_INVITE_DEFAULTS.maxUses,
  };
}

/**
 * The round invite button: organizers of the ACTIVE community only, never
 * while the keyboard is open. (The sheet itself is a modal that covers it.)
 * The server authorizes `create_invitation` again.
 */
export function inviteFabVisible(input: {
  isOrganizerOfActive: boolean;
  activeCommunityId: string | null;
  keyboardVisible: boolean;
}): boolean {
  return input.isOrganizerOfActive && input.activeCommunityId !== null && !input.keyboardVisible;
}

/** Shown under a freshly created code: closing the sheet does not lose it. */
export const QUICK_INVITE_CREATED_HINT =
  'This code stays valid for 30 days. You can see or revoke it in Invitations.';

export const FAB_SIZE = 56;
const FAB_MARGIN = 16;
/** Extra bottom padding for scroll content so the button never hides the last row. */
export const FAB_CLEARANCE = FAB_SIZE + FAB_MARGIN * 2;

export type QuickInviteError = { code: AppErrorCode; field?: string | undefined };

export type QuickInviteState =
  | { phase: 'idle'; attempt: number }
  | { phase: 'creating'; attempt: number }
  | { phase: 'created'; attempt: number; invitation: InvitationCode }
  | { phase: 'error'; attempt: number; error: QuickInviteError };

export type QuickInviteEvent =
  | { type: 'create' }
  | { type: 'succeeded'; attempt: number; invitation: InvitationCode }
  | { type: 'failed'; attempt: number; error: QuickInviteError }
  /** The sheet closed (or the community changed): drop the result and ignore any answer still on its way. */
  | { type: 'close' };

export const INITIAL_QUICK_INVITE: QuickInviteState = { phase: 'idle', attempt: 0 };

export function quickInviteReducer(state: QuickInviteState, event: QuickInviteEvent): QuickInviteState {
  switch (event.type) {
    case 'create':
      // Double-tap protection: one request at a time.
      if (state.phase === 'creating') return state;
      return { phase: 'creating', attempt: state.attempt + 1 };
    case 'succeeded':
      if (state.phase !== 'creating' || state.attempt !== event.attempt) return state;
      return { phase: 'created', attempt: state.attempt, invitation: event.invitation };
    case 'failed':
      if (state.phase !== 'creating' || state.attempt !== event.attempt) return state;
      return { phase: 'error', attempt: state.attempt, error: event.error };
    case 'close':
      return { phase: 'idle', attempt: state.attempt + 1 };
  }
}
