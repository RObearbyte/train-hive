import { describe, expect, it } from 'vitest';

import {
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MIN,
  displayNameFormSchema,
  displayNameSchema,
} from '@/features/onboarding/domain/displayName';

describe('displayNameSchema', () => {
  it('uses the contract limits', () => {
    expect(DISPLAY_NAME_MIN).toBe(2);
    expect(DISPLAY_NAME_MAX).toBe(40);
  });

  it('accepts and trims a normal name', () => {
    expect(displayNameSchema.parse('  Oana  ')).toBe('Oana');
    expect(displayNameSchema.parse('Ștefan Țăranu')).toBe('Ștefan Țăranu');
  });

  it('enforces the boundaries after trimming', () => {
    expect(displayNameSchema.safeParse('A').success).toBe(false);
    expect(displayNameSchema.safeParse('Al').success).toBe(true);
    expect(displayNameSchema.safeParse('a'.repeat(40)).success).toBe(true);
    expect(displayNameSchema.safeParse('a'.repeat(41)).success).toBe(false);
    expect(displayNameSchema.safeParse(` ${'a'.repeat(40)} `).success).toBe(true);
    expect(displayNameSchema.safeParse(' A ').success).toBe(false);
    expect(displayNameSchema.safeParse('').success).toBe(false);
    expect(displayNameSchema.safeParse('      ').success).toBe(false);
  });

  it('counts characters, not UTF-16 units', () => {
    expect(displayNameSchema.safeParse('😀').success).toBe(false);
    expect(displayNameSchema.safeParse('😀'.repeat(40)).success).toBe(true);
    expect(displayNameSchema.safeParse('😀'.repeat(41)).success).toBe(false);
  });

  it('gives a clear message for each bound', () => {
    const short = displayNameSchema.safeParse('A');
    const long = displayNameSchema.safeParse('a'.repeat(41));
    expect(short.error?.issues.map((issue) => issue.message)).toEqual([
      'Enter at least 2 characters.',
    ]);
    expect(long.error?.issues.map((issue) => issue.message)).toEqual([
      'Keep your name to 40 characters.',
    ]);
  });

  it('rejects non-strings', () => {
    expect(displayNameSchema.safeParse(null).success).toBe(false);
    expect(displayNameSchema.safeParse(42).success).toBe(false);
  });
});

describe('displayNameFormSchema', () => {
  it('attaches the error to the displayName field', () => {
    const result = displayNameFormSchema.safeParse({ displayName: ' ' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['displayName']);
  });

  it('returns the trimmed value', () => {
    expect(displayNameFormSchema.parse({ displayName: ' Oana ' })).toEqual({ displayName: 'Oana' });
  });
});
