import { describe, expect, it } from 'vitest';

import {
  CONTROLLER_ADDRESS_MAX,
  CONTROLLER_NAME_MAX,
  PRIVACY_EMAIL_MAX,
  buildLegalConfig,
  legalConfig,
  sanitizeEmail,
  sanitizeLegalText,
} from './config';
import { PLACEHOLDER } from './constants';

const chars = (...codes: number[]) => codes.map((code) => String.fromCodePoint(code)).join('');

describe('sanitizeLegalText', () => {
  it('trims and collapses whitespace', () => {
    expect(sanitizeLegalText('  Example   Club  ', 50)).toBe('Example Club');
  });

  it('turns line breaks into spaces so a value cannot forge a second line', () => {
    expect(sanitizeLegalText('Line one\nLine two\r\nLine three', 80)).toBe('Line one Line two Line three');
  });

  it('removes control characters', () => {
    expect(sanitizeLegalText(`A${chars(0)}B${chars(7)}C${chars(0x7f)}D`, 10)).toBe('ABCD');
    expect(sanitizeLegalText(`A${chars(0x85)}B`, 10)).toBe('AB');
  });

  it('removes bidirectional and zero-width characters (text spoofing)', () => {
    const hostile = chars(
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c, 0x200b,
      0x200c, 0x200d, 0x2060, 0xfeff,
    );
    expect(sanitizeLegalText(`Acme${hostile}Corp`, 50)).toBe('AcmeCorp');
    expect(sanitizeLegalText(`${chars(0x202e)}moc.live@dab`, 50)).toBe('moc.live@dab');
  });

  it('cuts oversized values at the limit without splitting a character', () => {
    const emoji = String.fromCodePoint(0x1f600);
    expect(Array.from(sanitizeLegalText(emoji.repeat(50), 10))).toHaveLength(10);
    expect(sanitizeLegalText('x'.repeat(500), CONTROLLER_NAME_MAX)).toHaveLength(CONTROLLER_NAME_MAX);
    expect(sanitizeLegalText('y'.repeat(500), CONTROLLER_ADDRESS_MAX)).toHaveLength(CONTROLLER_ADDRESS_MAX);
  });

  it('gives an empty string for non-strings and blank input', () => {
    for (const value of [undefined, null, 42, {}, [], '', '   ', '\n\t']) {
      expect(sanitizeLegalText(value, 20)).toBe('');
    }
  });

  it('keeps HTML as plain text (escaping is the renderers job)', () => {
    expect(sanitizeLegalText('<b>Club</b> & Co', 50)).toBe('<b>Club</b> & Co');
  });
});

describe('sanitizeEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(sanitizeEmail('privacy@example.org')).toBe('privacy@example.org');
    expect(sanitizeEmail('  first.last+tag@mail.example.co.uk  ')).toBe('first.last+tag@mail.example.co.uk');
  });

  it.each([
    'not an email',
    'missing-at.example.org',
    '@example.org',
    'a@',
    'a@b',
    'a@@example.org',
    'a b@example.org',
    'a@exa mple.org',
    '<script>@example.org',
    'a@example.org, b@example.org',
    'a@example.org;b@example.org',
    'mailto:a@example.org',
    'a"b@example.org',
    'a@-example.org',
    'a@example..org',
  ])('treats %j as unset', (value) => {
    expect(sanitizeEmail(value)).toBe('');
  });

  it('rejects oversized addresses instead of cutting them', () => {
    const local = 'a'.repeat(60);
    const domain = `${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(60)}.org`;
    expect(`${local}@${domain}`.length).toBeGreaterThan(PRIVACY_EMAIL_MAX);
    expect(sanitizeEmail(`${local}@${domain}`)).toBe('');
  });

  it('strips hidden control characters before judging, and never lets a line break smuggle a second address', () => {
    expect(sanitizeEmail(`a${chars(0x200b)}@example.org`)).toBe('a@example.org');
    expect(sanitizeEmail('a@example.org\nBcc: victim@example.org')).toBe('');
  });

  it('non-strings are unset', () => {
    expect(sanitizeEmail(undefined)).toBe('');
    expect(sanitizeEmail(7)).toBe('');
  });
});

describe('buildLegalConfig', () => {
  it('shows the literal marker for everything that is unset and reports incomplete', () => {
    const config = buildLegalConfig({});
    expect(PLACEHOLDER).toBe('[TO BE FILLED]');
    expect(config.controllerName).toBe(PLACEHOLDER);
    expect(config.controllerAddress).toBe(PLACEHOLDER);
    expect(config.privacyEmail).toBe(PLACEHOLDER);
    expect([config.nameSet, config.addressSet, config.emailSet]).toEqual([false, false, false]);
    expect(config.legalDetailsComplete).toBe(false);
  });

  it('treats empty strings and an invalid e-mail as unset', () => {
    const config = buildLegalConfig({ name: '   ', address: '', email: 'nope' });
    expect(config.controllerName).toBe(PLACEHOLDER);
    expect(config.privacyEmail).toBe(PLACEHOLDER);
    expect(config.legalDetailsComplete).toBe(false);
  });

  it('is complete only when all three are set', () => {
    expect(buildLegalConfig({ name: 'N', address: 'A', email: 'a@example.org' }).legalDetailsComplete).toBe(true);
    expect(buildLegalConfig({ name: 'N', address: 'A' }).legalDetailsComplete).toBe(false);
    expect(buildLegalConfig({ name: 'N', email: 'a@example.org' }).legalDetailsComplete).toBe(false);
    expect(buildLegalConfig({ address: 'A', email: 'a@example.org' }).legalDetailsComplete).toBe(false);
  });

  it('uses the cleaned values', () => {
    const config = buildLegalConfig({ name: ' Test\nClub ', address: '1 Test Street', email: 'x@example.org' });
    expect(config.controllerName).toBe('Test Club');
    expect(config.nameSet).toBe(true);
  });
});

describe('the configuration of this build', () => {
  it('comes from the environment only (unset means the marker)', () => {
    const unset =
      process.env.EXPO_PUBLIC_CONTROLLER_NAME === undefined &&
      process.env.EXPO_PUBLIC_CONTROLLER_ADDRESS === undefined &&
      process.env.EXPO_PUBLIC_PRIVACY_EMAIL === undefined;
    if (unset) {
      expect(legalConfig.controllerName).toBe(PLACEHOLDER);
      expect(legalConfig.legalDetailsComplete).toBe(false);
    }
    expect(typeof legalConfig.legalDetailsComplete).toBe('boolean');
  });
});
