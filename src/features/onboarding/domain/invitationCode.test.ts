import { describe, expect, it } from 'vitest';

import {
  INVITATION_CODE_ALPHABET,
  INVITATION_CODE_LENGTH,
  formatInvitationCode,
  isInvitationCodeProblem,
  isValidInvitationCodeFormat,
  normalizeInvitationCode,
  toInvitationCodeInput,
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

describe('toInvitationCodeInput', () => {
  it('formats while typing, one character at a time', () => {
    let value = '';
    const shown: string[] = [];
    for (const char of 'k7mq9xw2') {
      value = toInvitationCodeInput(value + char);
      shown.push(value);
    }
    expect(shown).toEqual([
      'K',
      'K7',
      'K7M',
      'K7MQ',
      'K7MQ-9',
      'K7MQ-9X',
      'K7MQ-9XW',
      'K7MQ-9XW2',
    ]);
  });

  it('lets the user delete back across the dash', () => {
    expect(toInvitationCodeInput('K7MQ-')).toBe('K7MQ');
    expect(toInvitationCodeInput('K7MQ')).toBe('K7MQ');
    expect(toInvitationCodeInput('K7M')).toBe('K7M');
    expect(toInvitationCodeInput('')).toBe('');
  });

  it('accepts pasted codes in any spelling', () => {
    expect(toInvitationCodeInput(' k7mq 9xw2\n')).toBe('K7MQ-9XW2');
    expect(toInvitationCodeInput('k7mq-9xw2')).toBe('K7MQ-9XW2');
    expect(toInvitationCodeInput('K7MQ9XW2')).toBe('K7MQ-9XW2');
  });

  it('stops at 8 characters', () => {
    expect(toInvitationCodeInput('K7MQ-9XW2A')).toBe('K7MQ-9XW2');
    expect(toInvitationCodeInput('k7mq9xw2 extra text')).toBe('K7MQ-9XW2');
  });

  it('is idempotent', () => {
    expect(toInvitationCodeInput(toInvitationCodeInput('k7mq9x'))).toBe('K7MQ-9X');
  });
});

describe('isInvitationCodeProblem', () => {
  it.each(['invalid_code', 'expired', 'revoked', 'exhausted'])('%s is about the code', (code) => {
    expect(isInvitationCodeProblem(code)).toBe(true);
  });

  it.each(['rate_limited', 'network_error', 'unknown', 'not_authenticated', 'invalid_display_name'])(
    '%s is not',
    (code) => {
      expect(isInvitationCodeProblem(code)).toBe(false);
    },
  );
});
