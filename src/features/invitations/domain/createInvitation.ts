/**
 * Creating and presenting invitation codes: expiry presets, the create form
 * schema, where a failed create is shown, and the texts for a code.
 *
 * `now` is always injected. An expiry is sent to the server as a duration in
 * hours (the contract's `p_expires_in_hours`); the server computes the
 * expiry time with its own clock and alone decides whether a code is still
 * redeemable, so the device clock never shifts it (O1).
 */
import { z } from 'zod';

import type { InvitationCode } from '@/lib/database.types';
import { formatDateTime } from '@/lib/datetime';
import { userMessage, type AppErrorCode } from '@/lib/errors';

import type { InvitationState } from './invitation';

export const EXPIRY_PRESETS = ['never', '24h', '7d', '30d'] as const;
export type ExpiryPreset = (typeof EXPIRY_PRESETS)[number];

/** 0 = never expires (the server's convention for `p_expires_in_hours`). */
const PRESET_HOURS: Record<ExpiryPreset, number> = {
  never: 0,
  '24h': 24,
  '7d': 7 * 24,
  '30d': 30 * 24,
};

export const EXPIRY_PRESET_OPTIONS: readonly {
  value: ExpiryPreset;
  label: string;
  accessibilityLabel: string;
}[] = [
  { value: 'never', label: 'Never', accessibilityLabel: 'Never expires' },
  { value: '24h', label: '24 hours', accessibilityLabel: 'Expires in 24 hours' },
  { value: '7d', label: '7 days', accessibilityLabel: 'Expires in 7 days' },
  { value: '30d', label: '30 days', accessibilityLabel: 'Expires in 30 days' },
];

/** `p_expires_in_hours` for a preset: 0 for "never", otherwise the exact duration in hours. */
export function expiryHoursFromPreset(preset: ExpiryPreset): number {
  return PRESET_HOURS[preset];
}

const WHOLE_NUMBER = /^\d{1,9}$/;

/** `p_max_redemptions` from the typed text: null when empty (no limit) or not a whole number. */
export function parseMaxUses(text: string): number | null {
  const trimmed = text.trim();
  return WHOLE_NUMBER.test(trimmed) ? Number(trimmed) : null;
}

/** The form holds what the inputs hold. `maxUses` is '' for "no limit". */
export const createInvitationFormSchema = z.object({
  expiry: z.enum(EXPIRY_PRESETS),
  maxUses: z.string().superRefine((text, ctx) => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    const value = parseMaxUses(trimmed);
    if (value === null) ctx.addIssue({ code: 'custom', message: 'Enter a whole number.' });
    else if (value < 1) ctx.addIssue({ code: 'custom', message: 'Allow at least 1 use, or leave it empty.' });
  }),
});

export type CreateInvitationFormValues = z.infer<typeof createInvitationFormSchema>;

/**
 * Where a failed `create_invitation` is shown: on the "maximum uses" field
 * when the server rejected that value, otherwise as a banner (`field` null).
 */
export function createInvitationFailure(error: {
  code: AppErrorCode;
  field?: string | undefined;
}): { field: 'maxUses' | null; message: string } {
  if (error.code === 'validation_failed' && error.field === 'max_redemptions') {
    return { field: 'maxUses', message: 'Allow at least 1 use, or leave it empty.' };
  }
  if (
    error.code === 'validation_failed' &&
    (error.field === 'expires_in_hours' || error.field === 'expires_at')
  ) {
    // The presets are all within the server's 0..90 day range, so this means the app and the
    // server disagree (an older server); the device clock plays no part any more.
    return {
      field: null,
      message: 'This expiry was not accepted. Choose another expiry, or update the app, and try again.',
    };
  }
  return { field: null, message: userMessage(error.code, error.field) };
}

const STATE_LABELS: Record<InvitationState, string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
  exhausted: 'Used up',
};

export function invitationStateLabel(state: InvitationState): string {
  return STATE_LABELS[state];
}

/** "Never expires", "Expires Sat 14 Nov, 09:00" or "Expired Sat 14 Nov, 09:00", in `zone`. */
export function expiryText(
  invitation: Pick<InvitationCode, 'expires_at'>,
  zone: string,
  now: Date,
): string {
  if (invitation.expires_at === null) return 'Never expires';
  const passed = new Date(invitation.expires_at).getTime() <= now.getTime();
  return `${passed ? 'Expired' : 'Expires'} ${formatDateTime(invitation.expires_at, zone)}`;
}
