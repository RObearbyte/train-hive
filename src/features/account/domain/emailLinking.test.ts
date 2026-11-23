import { describe, expect, it } from 'vitest';

import {
  OTP_LENGTH,
  RESEND_COOLDOWN_SECONDS,
  accountKindOf,
  classifyAuthError,
  failureMessage,
  isValidCode,
  isValidEmail,
  linkSentMessage,
  maskEmail,
  normalizeEmail,
  resendLabel,
  tickCooldown,
  toCodeInput,
} from './emailLinking';

describe('email validation', () => {
  it.each(['anna@example.org', ' Anna.K+club@Mail.Example.co.uk ', 'a@b.io'])('accepts %s', (value) => {
    expect(isValidEmail(value)).toBe(true);
  });

  it.each([
    '',
    'anna',
    'anna@',
    '@example.org',
    'anna@example',
    'anna@@example.org',
    'an na@example.org',
    'anna@exa mple.org',
    'anna@example..org',
    'a,b@example.org',
    '<a>@example.org',
    `${'a'.repeat(65)}@example.org`,
  ])('rejects %j', (value) => {
    expect(isValidEmail(value)).toBe(false);
  });

  it('rejects an address over 254 characters', () => {
    const long = `a@${['b', 'c', 'd', 'e'].map((c) => c.repeat(60)).join('.')}.${'f'.repeat(30)}.org`;
    expect(long.length).toBeGreaterThan(254);
    expect(isValidEmail(long)).toBe(false);
  });

  it('normalizes case and surrounding spaces', () => {
    expect(normalizeEmail('  Anna@Example.ORG ')).toBe('anna@example.org');
  });
});

describe('the code', () => {
  it('is exactly six digits', () => {
    expect(OTP_LENGTH).toBe(6);
    expect(isValidCode('123456')).toBe(true);
    expect(isValidCode(' 123456 ')).toBe(true);
    for (const bad of ['', '12345', '1234567', '12345a', '123 456', 'abcdef', '12-456']) {
      expect(isValidCode(bad), bad).toBe(false);
    }
  });

  it('keeps only digits and at most six of them while typing or pasting', () => {
    expect(toCodeInput('123 456')).toBe('123456');
    expect(toCodeInput('12-34-56-78')).toBe('123456');
    expect(toCodeInput('a1b2')).toBe('12');
    expect(toCodeInput('')).toBe('');
  });
});

describe('maskEmail', () => {
  it('hides all but the first letters and the ending', () => {
    expect(maskEmail('anna.k@gmail.com')).toBe('a***@g***.com');
    expect(maskEmail('Bob@Mail.Example.co.uk')).toBe('b***@m***.uk');
  });

  it('never prints more than the first letter of each part', () => {
    const masked = maskEmail('secretname@privatedomain.org');
    expect(masked).not.toContain('secret');
    expect(masked).not.toContain('private');
  });

  it('returns text that is not an address unchanged', () => {
    expect(maskEmail('nothing')).toBe('nothing');
    expect(maskEmail('a@')).toBe('a@');
  });
});

describe('resend countdown', () => {
  it('lasts 60 seconds, counts down and stops at 0', () => {
    expect(RESEND_COOLDOWN_SECONDS).toBe(60);
    expect(tickCooldown(60)).toBe(59);
    expect(tickCooldown(1)).toBe(0);
    expect(tickCooldown(0)).toBe(0);
  });

  it('labels the button', () => {
    expect(resendLabel(42)).toBe('Send again in 42 s');
    expect(resendLabel(0)).toBe('Send the code again');
  });
});

describe('accountKindOf', () => {
  it('anonymous user, nothing pending', () => {
    expect(accountKindOf({ is_anonymous: true })).toEqual({ kind: 'anonymous', pendingEmail: null });
  });
  it('anonymous user with an address waiting for its code', () => {
    expect(accountKindOf({ is_anonymous: true, email: '', new_email: 'a@example.org' })).toEqual({
      kind: 'anonymous',
      pendingEmail: 'a@example.org',
    });
  });
  it('a user that is not anonymous is linked, with its email', () => {
    expect(accountKindOf({ is_anonymous: false, email: 'a@example.org' })).toEqual({ kind: 'linked', email: 'a@example.org' });
    expect(accountKindOf({ email: 'a@example.org' })).toEqual({ kind: 'linked', email: 'a@example.org' });
  });
});

describe('classifyAuthError', () => {
  it('rate limits', () => {
    expect(classifyAuthError({ code: 'over_email_send_rate_limit', status: 429, message: 'email rate limit exceeded' })).toBe('rate_limited');
    expect(classifyAuthError({ code: 'over_request_rate_limit', status: 429, message: 'x' })).toBe('rate_limited');
    expect(classifyAuthError({ status: 429, message: 'For security purposes, you can only request this after 42 seconds.' })).toBe('rate_limited');
  });

  it('email already in use', () => {
    expect(classifyAuthError({ code: 'email_exists', status: 422, message: 'A user with this email address has already been registered' })).toBe('email_in_use');
    expect(classifyAuthError({ message: 'Email address already registered' })).toBe('email_in_use');
  });

  it('wrong or expired code', () => {
    expect(classifyAuthError({ code: 'otp_expired', status: 403, message: 'Token has expired or is invalid' })).toBe('invalid_code');
    expect(classifyAuthError({ message: 'Token has expired or is invalid' })).toBe('invalid_code');
  });

  it('no account for the address (sign-in) is its own kind and reads like a wrong code', () => {
    for (const code of ['otp_disabled', 'signup_disabled', 'user_not_found']) {
      expect(classifyAuthError({ code, message: 'x' })).toBe('no_account');
    }
    expect(failureMessage('no_account')).toBe(failureMessage('invalid_code'));
    expect(failureMessage('no_account')).not.toMatch(/no account|not found|does not exist/i);
  });

  it('sender and provider problems', () => {
    expect(classifyAuthError({ code: 'email_address_not_authorized', message: 'x' })).toBe('send_failed');
    expect(classifyAuthError({ status: 500, message: 'Error sending confirmation email' })).toBe('send_failed');
    expect(classifyAuthError({ code: 'email_provider_disabled', message: 'x' })).toBe('unavailable');
    expect(classifyAuthError({ code: 'email_address_invalid', message: 'x' })).toBe('invalid_email');
  });

  it('no connection', () => {
    expect(classifyAuthError({ name: 'AuthRetryableFetchError', message: 'x' })).toBe('network');
    expect(classifyAuthError(new Error('Network request failed'))).toBe('network');
  });

  it('anything else, including non-errors', () => {
    expect(classifyAuthError({ code: 'something_new', message: 'odd' })).toBe('unknown');
    expect(classifyAuthError(null)).toBe('unknown');
    expect(classifyAuthError('boom')).toBe('unknown');
  });
});

describe('messages', () => {
  it('the email-in-use message explains to sign in with that email instead', () => {
    const text = failureMessage('email_in_use');
    expect(text).toMatch(/already belongs to a TrainHive account/);
    expect(text).toMatch(/I already have an account/);
  });

  it('every failure kind has a message', () => {
    for (const k of ['rate_limited', 'invalid_code', 'email_in_use', 'invalid_email', 'send_failed', 'unavailable', 'no_account', 'network', 'unknown'] as const) {
      expect(failureMessage(k).length).toBeGreaterThan(10);
    }
  });

  it('the link message names the masked address and the code length', () => {
    expect(linkSentMessage('a***@g***.com')).toContain('6-digit code to a***@g***.com');
  });
});
