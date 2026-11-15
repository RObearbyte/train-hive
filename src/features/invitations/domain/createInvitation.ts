/**
 * Creating and presenting invitation codes: expiry presets, the create form
 * schema, where a failed create is shown, and the texts for a code.
 *
 * `now` is always injected. An expiry is sent to the server as an absolute
 * time (the contract's `p_expires_at`); the server alone decides whether a
 * code is still redeemable.
 */
import { z } from 'zod';

import type { InvitationCode } from '@/lib/database.types';
import { formatDateTime } from '@/lib/datetime';
import { userMessage, type AppErrorCode } from '@/lib/errors';

import type { InvitationState } from './invitation';

export const EXPIRY_PRESETS = ['never', '24h', '7d', '30d'] as const;
export type ExpiryPreset = (typeof EXPIRY_PRESETS)[number];

const HOUR_MS = 60 * 60_000;

const PRESET_HOURS: Record<ExpiryPreset, number | null> = {
  never: null,
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

/** `p_expires_at` for a preset: null for "never", otherwise `now` plus the exact duration, as UTC ISO. */
export function expiryFromPreset(preset: ExpiryPreset, now: Date): string | null {
  const hours = PRESET_HOURS[preset];
  if (hours === null) return null;
  if (Number.isNaN(now.getTime())) throw new RangeError('Invalid date for now');
  return new Date(now.getTime() + hours * HOUR_MS).toISOString();
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
  if (error.code === 'validation_failed' && error.field === 'expires_at') {
    // A preset is always in the future by this device's clock, so the clock is off.
    return {
      field: null,
      message:
        "The expiry time was not accepted. Check this device's date and time, then try again.",
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

/** Text handed to the share sheet. `formattedCode` is the `ABCD-EFGH` form. */
export function invitationShareMessage(communityName: string, formattedCode: string): string {
  return `Join ${communityName} on TrainHive. Open the app and enter the invitation code ${formattedCode}`;
}
