import { describe, expect, it } from 'vitest';

import {
  INVITATION_CODE_ALPHABET,
  INVITATION_CODE_LENGTH,
  formatInvitationCode,
  isValidInvitationCodeFormat,
  normalizeInvitationCode,
} from '@/features/onboarding/domain/invitationCode';

describe('normalizeInvitationCode', () => {
  it('uppercases and strips spaces and dashes', () => {
    expect(normalizeInvitationCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizeInvitationCode('  ab cd - ef gh  ')).toBe('ABCDEFGH');
    expect(normalizeInvitationCode('ABCDEFGH')).toBe('ABCDEFGH');
    expect(normalizeInvitationCode('a-b-c-d-e-f-g-h')).toBe('ABCDEFGH');
  });

  it('strips tabs, newlines and typographic dashes from pasted text', () => {
    expect(normalizeInvitationCode('abcd–efgh\n')).toBe('ABCDEFGH');
    expect(normalizeInvitationCode('\tabcd—efgh')).toBe('ABCDEFGH');
    expect(normalizeInvitationCode('abcd efgh')).toBe('ABCDEFGH');
  });

  it('keeps other characters so a bad code stays visibly bad', () => {
    expect(normalizeInvitationCode('abc!defg')).toBe('ABC!DEFG');
    expect(normalizeInvitationCode('')).toBe('');
  });

  it('is idempotent', () => {
    const once = normalizeInvitationCode(' k7mq-9xw2 ');
    expect(normalizeInvitationCode(once)).toBe(once);
  });
});

describe('isValidInvitationCodeFormat', () => {
  it('uses the contract alphabet and length', () => {
    expect(INVITATION_CODE_ALPHABET).toBe('23456789ABCDEFGHJKMNPQRSTVWXYZ');
    expect(INVITATION_CODE_LENGTH).toBe(8);
  });

  it('accepts 8 alphabet characters in any accepted spelling', () => {
    expect(isValidInvitationCodeFormat('K7MQ9XW2')).toBe(true);
    expect(isValidInvitationCodeFormat('k7mq-9xw2')).toBe(true);
    expect(isValidInvitationCodeFormat(' k7mq 9xw2 ')).toBe(true);
    expect(isValidInvitationCodeFormat('23456789')).toBe(true);
  });

  it('accepts every character of the alphabet', () => {
    for (const char of INVITATION_CODE_ALPHABET) {
      expect(isValidInvitationCodeFormat(char.repeat(8))).toBe(true);
    }
  });

  it.each(['0', '1', 'I', 'L', 'O', 'U', 'i', 'o', '!', 'Ă'])(
    'rejects the excluded character %s',
    (char) => {
      expect(isValidInvitationCodeFormat(`ABCDEFG${char}`)).toBe(false);
    },
  );

  it('rejects the wrong length', () => {
    expect(isValidInvitationCodeFormat('')).toBe(false);
    expect(isValidInvitationCodeFormat('ABCDEFG')).toBe(false);
    expect(isValidInvitationCodeFormat('ABCDEFGHJ')).toBe(false);
    expect(isValidInvitationCodeFormat('ABCD-EFG')).toBe(false);
    expect(isValidInvitationCodeFormat('    ')).toBe(false);
  });
});

describe('formatInvitationCode', () => {
  it('formats a full code as ABCD-EFGH', () => {
    expect(formatInvitationCode('abcdefgh')).toBe('ABCD-EFGH');
    expect(formatInvitationCode('ABCD-EFGH')).toBe('ABCD-EFGH');
    expect(formatInvitationCode(' abcd efgh ')).toBe('ABCD-EFGH');
  });

  it('formats partial input while typing', () => {
    expect(formatInvitationCode('')).toBe('');
    expect(formatInvitationCode('ab')).toBe('AB');
    expect(formatInvitationCode('abcd')).toBe('ABCD');
    expect(formatInvitationCode('abcd-')).toBe('ABCD');
    expect(formatInvitationCode('abcde')).toBe('ABCD-E');
  });

  it('keeps extra characters visible', () => {
    expect(formatInvitationCode('abcdefghjk')).toBe('ABCD-EFGHJK');
  });

  it('round-trips with normalize', () => {
    expect(normalizeInvitationCode(formatInvitationCode('k7mq9xw2'))).toBe('K7MQ9XW2');
    expect(formatInvitationCode(formatInvitationCode('k7mq9xw2'))).toBe('K7MQ-9XW2');
  });
});
