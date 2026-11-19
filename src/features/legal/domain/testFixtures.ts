import type { ConsentPurpose, ConsentState, MyConsents } from '@/lib/database.types';

const NEVER: ConsentState = { granted: false, current: false, document_version: null, at: null };

export function consentState(overrides: Partial<ConsentState> = {}): ConsentState {
  return { ...NEVER, ...overrides };
}

export function grantedState(version: string | null, at = '2026-11-01T10:00:00.000Z'): ConsentState {
  return { granted: true, current: true, document_version: version, at };
}

/** `my_consents()` for someone who has never recorded anything (a member from before the ledger). */
export function neverRecorded(overrides: Partial<MyConsents> = {}): MyConsents {
  return {
    terms_version: '1',
    terms_effective_at: '2026-11-01T00:00:00.000Z',
    privacy_version: '1',
    privacy_effective_at: '2026-11-01T00:00:00.000Z',
    terms_privacy_version: 'terms:1|privacy:1',
    needs_terms_acceptance: true,
    consents: {
      terms_privacy: NEVER,
      age_16: NEVER,
      profile_demographics: NEVER,
      emergency_contact: NEVER,
      workout_logs: NEVER,
      push_notifications: NEVER,
    },
    ...overrides,
  };
}

/** Someone who accepted the current terms and is 16+, with optional extras. */
export function accepted(extra: Partial<Record<ConsentPurpose, ConsentState>> = {}): MyConsents {
  const base = neverRecorded();
  return {
    ...base,
    needs_terms_acceptance: false,
    consents: {
      ...base.consents,
      terms_privacy: grantedState('terms:1|privacy:1'),
      age_16: grantedState('1'),
      ...extra,
    },
  };
}
