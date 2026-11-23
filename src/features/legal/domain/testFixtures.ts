import type { ConsentPurpose, ConsentState, MyConsents } from '@/lib/database.types';

import { BUNDLED_TERMS_PRIVACY_VERSION, PRIVACY_VERSION, TERMS_VERSION } from '../constants';

const NEVER: ConsentState = { granted: false, current: false, document_version: null, at: null };

export function consentState(overrides: Partial<ConsentState> = {}): ConsentState {
  return { ...NEVER, ...overrides };
}

export function grantedState(version: string | null, at = '2026-11-01T10:00:00.000Z'): ConsentState {
  return { granted: true, current: true, document_version: version, at };
}

/**
 * `my_consents()` for someone who has never recorded anything (a member from before the ledger).
 * The server's published texts are the ones this build bundles, so a version bump needs no edit here.
 */
export function neverRecorded(overrides: Partial<MyConsents> = {}): MyConsents {
  return {
    terms_version: TERMS_VERSION,
    terms_effective_at: '2026-11-01T00:00:00.000Z',
    privacy_version: PRIVACY_VERSION,
    privacy_effective_at: '2026-11-01T00:00:00.000Z',
    terms_privacy_version: BUNDLED_TERMS_PRIVACY_VERSION,
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
      terms_privacy: grantedState(BUNDLED_TERMS_PRIVACY_VERSION),
      age_16: grantedState('1'),
      ...extra,
    },
  };
}
