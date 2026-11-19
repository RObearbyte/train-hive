import { describe, expect, it } from 'vitest';

import {
  AppError,
  BACKEND_ERROR_CODES,
  appErrorFromResult,
  isNetworkError,
  parseErrorCode,
  toAppError,
  userMessage,
  userMessageFor,
} from '@/lib/errors';

/** The shape supabase-js gives for a `raise exception` in an RPC. */
function pgError(message: string, code = 'P0001') {
  return { message, code, details: null, hint: null };
}

const GENERIC = userMessage('unknown');

describe('contract coverage', () => {
  it('lists every code in docs/API_CONTRACT.md', () => {
    expect([...BACKEND_ERROR_CODES].sort()).toEqual(
      [
        'announcement_not_cancellable',
        'announcement_not_editable',
        'attendee_has_going_rsvp',
        'attendee_not_a_member',
        'cannot_change_own_role',
        'cannot_remove_self',
        'community_limit_reached',
        'consent_required',
        'exhausted',
        'expired',
        'forbidden',
        'invalid_code',
        'invalid_display_name',
        'last_organizer',
        'not_a_member',
        'not_authenticated',
        'no_going_rsvp',
        'not_found',
        'not_withdrawable',
        'rate_limited',
        'revoked',
        'rsvp_closed',
        'session_full',
        'session_has_attendance',
        'session_not_cancellable',
        'session_not_confirmed',
        'session_not_editable',
        'session_not_ended',
        'stale_data',
        'validation_failed',
      ].sort(),
    );
  });

  it.each(BACKEND_ERROR_CODES)('maps raised P0001 "%s" to its code', (code) => {
    const error = toAppError(pgError(code));
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe(code);
    expect(error.field).toBeUndefined();
    expect(error.message).toBe(code);
  });

  it.each(BACKEND_ERROR_CODES)('maps returned { ok: false, error: "%s" } to its code', (code) => {
    expect(appErrorFromResult(code).code).toBe(code);
  });

  it.each([...BACKEND_ERROR_CODES, 'network_error', 'app_update_required'] as const)(
    'has a specific friendly message for "%s"',
    (code) => {
      const message = userMessage(code);
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toBe(GENERIC);
      // No machine code leaks into user-facing text.
      expect(message).not.toContain('_');
    },
  );

  it('explains a refused cancel of an event that already has attendance', () => {
    expect(userMessage('session_has_attendance')).toBe(
      'This event already has attendance recorded and can no longer be cancelled. Correct the attendance instead.',
    );
    expect(toAppError(pgError('session_has_attendance')).code).toBe('session_has_attendance');
  });

  it('gives every code a different message', () => {
    const messages = BACKEND_ERROR_CODES.map((code) => userMessage(code));
    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe('parseErrorCode', () => {
  it('splits validation_failed:<field> into code and field', () => {
    expect(parseErrorCode('validation_failed:max_participants')).toEqual({
      code: 'validation_failed',
      field: 'max_participants',
    });
  });

  it('accepts validation_failed without a field', () => {
    expect(parseErrorCode('validation_failed')).toEqual({
      code: 'validation_failed',
      field: undefined,
    });
    expect(parseErrorCode('validation_failed:')).toEqual({
      code: 'validation_failed',
      field: undefined,
    });
  });

  it('returns null for text that is not a contract code', () => {
    expect(parseErrorCode('duplicate key value violates unique constraint')).toBeNull();
    expect(parseErrorCode('validation_failedX')).toBeNull();
    expect(parseErrorCode('')).toBeNull();
    expect(parseErrorCode('toString')).toBeNull();
  });
});

describe('toAppError', () => {
  it('carries the field of a raised validation failure', () => {
    const error = toAppError(pgError('validation_failed:rsvp_deadline'));
    expect(error.code).toBe('validation_failed');
    expect(error.field).toBe('rsvp_deadline');
    expect(error.message).toBe('validation_failed:rsvp_deadline');
  });

  it('keeps the original message and value of an unknown P0001', () => {
    const original = pgError('some_new_code_from_a_later_backend');
    const error = toAppError(original);
    expect(error.code).toBe('unknown');
    expect(error.message).toBe('some_new_code_from_a_later_backend');
    expect(error.original).toBe(original);
  });

  it('does not treat other Postgres errors as contract codes, and keeps their message', () => {
    const original = pgError('permission denied for table training_sessions', '42501');
    const error = toAppError(original);
    expect(error.code).toBe('unknown');
    expect(error.message).toBe('permission denied for table training_sessions');
    expect(error.original).toBe(original);
  });

  it('does not trust a contract code that arrives with a non-P0001 code', () => {
    expect(toAppError(pgError('forbidden', '42501')).code).toBe('unknown');
  });

  it('keeps the message of a thrown Error', () => {
    const original = new Error('boom');
    const error = toAppError(original);
    expect(error.code).toBe('unknown');
    expect(error.message).toBe('boom');
    expect(error.original).toBe(original);
  });

  it('handles strings, null and plain objects without losing them', () => {
    expect(toAppError('plain text').message).toBe('plain text');
    expect(toAppError(null).code).toBe('unknown');
    expect(toAppError(null).original).toBeNull();
    expect(toAppError({ weird: true }).message).toBe('{"weird":true}');
    expect(toAppError(undefined).code).toBe('unknown');
  });

  it('returns an AppError unchanged', () => {
    const error = new AppError('rsvp_closed');
    expect(toAppError(error)).toBe(error);
  });
});

describe('appErrorFromResult', () => {
  it('parses a field from a returned validation failure', () => {
    const error = appErrorFromResult('validation_failed:display_name');
    expect(error.code).toBe('validation_failed');
    expect(error.field).toBe('display_name');
  });

  it('keeps an unrecognized returned code for logging', () => {
    const error = appErrorFromResult('brand_new_code');
    expect(error.code).toBe('unknown');
    expect(error.message).toBe('brand_new_code');
    expect(error.original).toBe('brand_new_code');
  });

  it('handles a missing error value', () => {
    expect(appErrorFromResult(undefined).code).toBe('unknown');
  });
});

describe('network failures', () => {
  it.each([
    ['React Native fetch', new TypeError('Network request failed')],
    ['browser fetch', new TypeError('Failed to fetch')],
    ['node fetch', new TypeError('fetch failed')],
    ['Safari fetch', new TypeError('Load failed')],
    [
      'postgrest-js wrapped fetch failure',
      { message: 'TypeError: Network request failed', details: '', hint: '', code: '' },
    ],
    [
      'auth client',
      { name: 'AuthRetryableFetchError', message: 'Network request failed', status: 0 },
    ],
  ])('detects %s', (_label, error) => {
    expect(isNetworkError(error)).toBe(true);
    const appError = toAppError(error);
    expect(appError.code).toBe('network_error');
    expect(appError.original).toBe(error);
  });

  it('does not flag server answers or unrelated errors', () => {
    expect(isNetworkError(pgError('rsvp_closed'))).toBe(false);
    expect(isNetworkError(pgError('network request failed', '42501'))).toBe(false);
    expect(isNetworkError(new Error('boom'))).toBe(false);
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });

  it('recognizes an AppError by its code', () => {
    expect(isNetworkError(new AppError('network_error'))).toBe(true);
    expect(isNetworkError(new AppError('forbidden'))).toBe(false);
  });
});

describe('userMessage', () => {
  it('words stale_data for the settings conflict', () => {
    expect(userMessage('stale_data')).toBe(
      'Someone else changed these community settings while you were editing. Review the latest values and try again.',
    );
    expect(toAppError(pgError('stale_data')).code).toBe('stale_data');
  });

  it('falls back to the generic text for unknown codes', () => {
    expect(userMessage('definitely_not_a_code')).toBe(GENERIC);
    expect(userMessage('')).toBe(GENERIC);
    expect(userMessage('constructor')).toBe(GENERIC);
  });

  it('names the field of a validation failure when it knows it', () => {
    expect(userMessage('validation_failed', 'max_participants')).toBe(
      'The maximum participants is not valid. Please check it and try again.',
    );
    expect(userMessage('validation_failed', 'rsvp_deadline')).toContain('RSVP deadline');
  });

  it('uses the general validation text for an unknown or missing field', () => {
    const general = userMessage('validation_failed');
    expect(userMessage('validation_failed', 'mystery_column')).toBe(general);
    expect(general).not.toBe(GENERIC);
  });

  it('userMessageFor goes from a raw error to text', () => {
    expect(userMessageFor(pgError('session_full'))).toBe(userMessage('session_full'));
    expect(userMessageFor(pgError('validation_failed:title'))).toBe(
      userMessage('validation_failed', 'title'),
    );
    expect(userMessageFor(new Error('boom'))).toBe(GENERIC);
  });
});

describe('GDPR G1 consent codes', () => {
  it('parses consent_required and not_withdrawable raised by record / withdraw / register', () => {
    expect(toAppError(pgError('consent_required')).code).toBe('consent_required');
    expect(toAppError(pgError('not_withdrawable')).code).toBe('not_withdrawable');
  });

  it('maps consent_required returned by the join RPCs', () => {
    expect(appErrorFromResult('consent_required').code).toBe('consent_required');
  });

  it('keeps the field of validation_failed:purpose and validation_failed:document_version', () => {
    expect(toAppError(pgError('validation_failed:purpose')).field).toBe('purpose');
    expect(toAppError(pgError('validation_failed:document_version')).field).toBe('document_version');
  });

  it('gives friendly, distinct texts that never show a raw code', () => {
    const consent = userMessage('consent_required');
    const withdrawable = userMessage('not_withdrawable');
    expect(consent).not.toBe(GENERIC);
    expect(withdrawable).not.toBe(GENERIC);
    expect(consent).not.toContain('consent_required');
    expect(withdrawable).not.toContain('not_withdrawable');
    expect(userMessage('app_update_required')).toMatch(/update the app/i);
  });
});

describe('GDPR G2 organizer tools', () => {
  it('parses the member-management codes', () => {
    for (const code of ['last_organizer', 'cannot_change_own_role', 'cannot_remove_self'] as const) {
      expect(toAppError(pgError(code)).code).toBe(code);
      expect(userMessage(code)).not.toBe(GENERIC);
      expect(userMessage(code)).not.toContain(code);
    }
  });

  it('says what to do about each', () => {
    expect(userMessage('last_organizer')).toMatch(/at least one organizer/i);
    expect(userMessage('cannot_change_own_role')).toMatch(/own role/i);
    expect(userMessage('cannot_remove_self')).toMatch(/leave this community/i);
    expect(userMessage('validation_failed', 'role')).toContain('role');
  });
});
