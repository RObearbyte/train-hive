import { describe, expect, it } from 'vitest';

import {
  EXPIRY_PRESETS,
  EXPIRY_PRESET_OPTIONS,
  createInvitationFailure,
  createInvitationFormSchema,
  expiryHoursFromPreset,
  expiryText,
  invitationStateLabel,
  parseMaxUses,
} from './createInvitation';

describe('expiryHoursFromPreset', () => {
  it('is 0 (the server convention for "never") for never', () => {
    expect(expiryHoursFromPreset('never')).toBe(0);
  });

  it('is the exact duration in hours; no device time is involved', () => {
    expect(expiryHoursFromPreset('24h')).toBe(24);
    expect(expiryHoursFromPreset('7d')).toBe(168);
    expect(expiryHoursFromPreset('30d')).toBe(720);
  });

  it('every preset is within the server bounds (0, or 1..2160 hours)', () => {
    for (const preset of EXPIRY_PRESETS) {
      const hours = expiryHoursFromPreset(preset);
      expect(Number.isInteger(hours), preset).toBe(true);
      expect(hours === 0 || (hours >= 1 && hours <= 2160), preset).toBe(true);
    }
  });

  it('has an option for every preset, in order', () => {
    expect(EXPIRY_PRESET_OPTIONS.map((option) => option.value)).toEqual([...EXPIRY_PRESETS]);
  });
});

describe('parseMaxUses', () => {
  it('parses whole numbers and trims', () => {
    expect(parseMaxUses('1')).toBe(1);
    expect(parseMaxUses(' 25 ')).toBe(25);
    expect(parseMaxUses('0')).toBe(0);
  });

  it('is null for empty or malformed input', () => {
    for (const text of ['', '  ', '-1', '1.5', '1e3', 'ten', '1234567890']) {
      expect(parseMaxUses(text)).toBeNull();
    }
  });
});

describe('createInvitationFormSchema', () => {
  const parse = (maxUses: string, expiry: string = 'never') =>
    createInvitationFormSchema.safeParse({ expiry, maxUses });

  it('accepts an empty limit and whole numbers from 1', () => {
    expect(parse('').success).toBe(true);
    expect(parse('1').success).toBe(true);
    expect(parse(' 40 ', '7d').success).toBe(true);
  });

  it('rejects zero, negatives, decimals and text on the maxUses field', () => {
    for (const text of ['0', '-3', '2.5', 'many']) {
      const result = parse(text);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0].path).toEqual(['maxUses']);
    }
  });

  it('rejects an unknown preset', () => {
    expect(parse('', 'forever').success).toBe(false);
  });
});

describe('createInvitationFailure', () => {
  it('puts a rejected limit on the field', () => {
    expect(createInvitationFailure({ code: 'validation_failed', field: 'max_redemptions' })).toEqual({
      field: 'maxUses',
      message: 'Allow at least 1 use, or leave it empty.',
    });
  });

  it('explains a rejected expiry (duration or legacy time) as a banner, without blaming the device clock', () => {
    for (const field of ['expires_in_hours', 'expires_at']) {
      const failure = createInvitationFailure({ code: 'validation_failed', field });
      expect(failure.field).toBeNull();
      expect(failure.message).toContain('This expiry was not accepted');
      expect(failure.message).not.toContain('date and time');
    }
  });

  it('uses the standard message for everything else', () => {
    expect(createInvitationFailure({ code: 'forbidden' })).toEqual({
      field: null,
      message: 'Only an organizer can do that.',
    });
    expect(createInvitationFailure({ code: 'network_error' }).field).toBeNull();
  });
});

describe('texts', () => {
  const now = new Date('2026-11-15T10:00:00.000Z');

  it('labels every state', () => {
    expect(invitationStateLabel('active')).toBe('Active');
    expect(invitationStateLabel('expired')).toBe('Expired');
    expect(invitationStateLabel('revoked')).toBe('Revoked');
    expect(invitationStateLabel('exhausted')).toBe('Used up');
  });

  it('describes the expiry in the given zone', () => {
    expect(expiryText({ expires_at: null }, 'Europe/Bucharest', now)).toBe('Never expires');
    expect(expiryText({ expires_at: '2026-11-16T07:00:00.000Z' }, 'Europe/Bucharest', now)).toBe(
      'Expires Mon 16 Nov, 09:00',
    );
    expect(expiryText({ expires_at: '2026-11-14T07:00:00.000Z' }, 'Europe/Bucharest', now)).toBe(
      'Expired Sat 14 Nov, 09:00',
    );
    // Expires AT the instant, like invitationState.
    expect(expiryText({ expires_at: now.toISOString() }, 'UTC', now)).toBe(
      'Expired Sun 15 Nov, 10:00',
    );
  });
});
