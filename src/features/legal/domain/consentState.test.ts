import { describe, expect, it } from 'vitest';

import { BUNDLED_TERMS_PRIVACY_VERSION, PRIVACY_VERSION } from '../constants';
import {
  ACCEPTANCE_STORAGE_KEY,
  createLocalAcceptance,
  isAcceptanceCurrent,
  parseLocalAcceptance,
  serializeLocalAcceptance,
} from './acceptance';
import {
  OPTIONAL_PURPOSES,
  REQUIRED_PURPOSES,
  bundledMatchesServer,
  canContinue,
  documentVersionFor,
  mapConsentWriteError,
  needsConsentStep,
  parseStartTarget,
  planGateAcceptance,
  planRecording,
  writesFor,
} from './consentState';
import { accepted, consentState, grantedState, neverRecorded } from './testFixtures';

const NOW = new Date('2026-11-19T10:00:00.000Z');
const LOCAL_OK = createLocalAcceptance(BUNDLED_TERMS_PRIVACY_VERSION, NOW);

describe('local acceptance storage format', () => {
  it('round-trips', () => {
    expect(parseLocalAcceptance(serializeLocalAcceptance(LOCAL_OK))).toEqual(LOCAL_OK);
  });

  it('uses a per-device key, not a per-user one', () => {
    expect(ACCEPTANCE_STORAGE_KEY).toBe('trainhive.legal-acceptance');
  });

  it.each([
    null,
    undefined,
    '',
    'not json',
    '[]',
    'null',
    '{}',
    JSON.stringify({ version: '', age16: true, acceptedAt: NOW.toISOString() }),
    JSON.stringify({ version: 'terms:1|privacy:1', age16: false, acceptedAt: NOW.toISOString() }),
    JSON.stringify({ version: 'terms:1|privacy:1', age16: 'yes', acceptedAt: NOW.toISOString() }),
    JSON.stringify({ version: 'terms:1|privacy:1', age16: true, acceptedAt: 'yesterday' }),
    JSON.stringify({ version: 5, age16: true, acceptedAt: NOW.toISOString() }),
  ])('treats %j as not accepted', (raw) => {
    expect(parseLocalAcceptance(raw)).toBeNull();
  });

  it('is current only for the texts bundled in this build', () => {
    expect(isAcceptanceCurrent(LOCAL_OK)).toBe(true);
    expect(isAcceptanceCurrent(null)).toBe(false);
    expect(isAcceptanceCurrent(createLocalAcceptance('terms:0|privacy:1', NOW))).toBe(false);
    expect(isAcceptanceCurrent(createLocalAcceptance('terms:2|privacy:1', NOW), 'terms:2|privacy:1')).toBe(true);
  });
});

describe('first-launch step', () => {
  it('is needed when nothing is stored or the stored versions are outdated', () => {
    expect(needsConsentStep(null)).toBe(true);
    expect(needsConsentStep(createLocalAcceptance('terms:0|privacy:0', NOW))).toBe(true);
    expect(needsConsentStep(LOCAL_OK)).toBe(false);
  });

  it('Continue needs both boxes', () => {
    expect(canContinue({ acceptedTerms: false, confirmedAge: false })).toBe(false);
    expect(canContinue({ acceptedTerms: true, confirmedAge: false })).toBe(false);
    expect(canContinue({ acceptedTerms: false, confirmedAge: true })).toBe(false);
    expect(canContinue({ acceptedTerms: true, confirmedAge: true })).toBe(true);
  });

  it('parses the next parameter against an allowlist', () => {
    expect(parseStartTarget('create')).toBe('create');
    expect(parseStartTarget('join')).toBe('join');
    expect(parseStartTarget(['create', 'join'])).toBe('create');
    for (const value of [undefined, '', '/code', 'https://evil.example', 'CREATE', 1]) {
      expect(parseStartTarget(value)).toBe('join');
    }
  });
});

describe('writesFor', () => {
  it('writes both for a member with no records, with the combined version exactly as the server gave it', () => {
    expect(writesFor(neverRecorded({ terms_privacy_version: 'terms:3|privacy:2' }))).toEqual([
      { purpose: 'terms_privacy', documentVersion: 'terms:3|privacy:2' },
      { purpose: 'age_16' },
    ]);
  });

  it('writes only what is missing', () => {
    const staleTerms = neverRecorded({
      consents: {
        ...neverRecorded().consents,
        terms_privacy: consentState({ granted: true, current: false, document_version: 'terms:0|privacy:0', at: 'x' }),
        age_16: grantedState('1'),
      },
    });
    expect(writesFor(staleTerms)).toEqual([{ purpose: 'terms_privacy', documentVersion: BUNDLED_TERMS_PRIVACY_VERSION }]);
    expect(writesFor(accepted())).toEqual([]);
  });
});

describe('planRecording (before redeem_invitation / create_community_with_code)', () => {
  it('does nothing when the server needs nothing, with or without a local note', () => {
    expect(planRecording({ local: null, server: accepted() })).toEqual({ action: 'none' });
    expect(planRecording({ local: LOCAL_OK, server: accepted() })).toEqual({ action: 'none' });
  });

  it('asks the person when the server needs consent and the device has no (current) acknowledgement', () => {
    expect(planRecording({ local: null, server: neverRecorded() })).toEqual({ action: 'ask_user' });
    const old = createLocalAcceptance('terms:0|privacy:0', NOW);
    expect(planRecording({ local: old, server: neverRecorded() })).toEqual({ action: 'ask_user' });
  });

  it('records both purposes right after the session exists when the device acknowledged the same texts', () => {
    expect(planRecording({ local: LOCAL_OK, server: neverRecorded() })).toEqual({
      action: 'record',
      writes: [{ purpose: 'terms_privacy', documentVersion: BUNDLED_TERMS_PRIVACY_VERSION }, { purpose: 'age_16' }],
    });
  });

  it('a local note for texts newer than this build is not current, so the person is asked again', () => {
    const bumped = neverRecorded({ terms_privacy_version: 'terms:9|privacy:9' });
    const local = createLocalAcceptance('terms:9|privacy:9', NOW);
    // This build bundles other versions, so a local note for terms:9 cannot be current: the app must be updated.
    expect(planRecording({ local, server: bumped })).toEqual({ action: 'ask_user' });
  });

  it('refuses to record when the server wants texts this build does not contain', () => {
    const bumped = neverRecorded({ terms_privacy_version: 'terms:9|privacy:9' });
    expect(planRecording({ local: LOCAL_OK, server: bumped })).toEqual({ action: 'app_outdated' });
  });

  it('never invents consent for the optional purposes', () => {
    const plan = planRecording({ local: LOCAL_OK, server: neverRecorded() });
    const purposes = plan.action === 'record' ? plan.writes.map((write) => write.purpose) : [];
    expect(purposes.every((purpose) => REQUIRED_PURPOSES.includes(purpose))).toBe(true);
    for (const purpose of OPTIONAL_PURPOSES) expect(purposes).not.toContain(purpose);
  });
});

describe('planGateAcceptance ("We updated our terms")', () => {
  it('records for a member with no records when this build shows the current texts', () => {
    expect(planGateAcceptance(neverRecorded())).toEqual({
      action: 'record',
      writes: [{ purpose: 'terms_privacy', documentVersion: BUNDLED_TERMS_PRIVACY_VERSION }, { purpose: 'age_16' }],
    });
  });

  it('does nothing when already accepted', () => {
    expect(planGateAcceptance(accepted())).toEqual({ action: 'none' });
  });

  it('asks for an app update when the server texts are newer than the bundled ones', () => {
    const newer = neverRecorded({ terms_privacy_version: 'terms:9|privacy:9' });
    expect(bundledMatchesServer(newer)).toBe(false);
    expect(planGateAcceptance(newer)).toEqual({ action: 'app_outdated' });
  });
});

describe('consent_required from a join', () => {
  it('after a stale or missing local note the first-launch step is needed again (the app routes back to it)', () => {
    // ensureConsentRecorded throws consent_required exactly when this plan is ask_user.
    expect(planRecording({ local: null, server: neverRecorded() }).action).toBe('ask_user');
    expect(needsConsentStep(null)).toBe(true);
  });
});

describe('the document version sent with record_consent', () => {
  it('optional purposes carry the bundled privacy version; terms keep the explicit string; age has none', () => {
    for (const purpose of OPTIONAL_PURPOSES) expect(documentVersionFor(purpose)).toBe(PRIVACY_VERSION);
    expect(documentVersionFor('terms_privacy', 'terms:2|privacy:2')).toBe('terms:2|privacy:2');
    expect(documentVersionFor('age_16')).toBeNull();
  });

  it('a refused document version means the app must be updated, whatever the purpose', () => {
    const refused = { code: 'P0001', message: 'validation_failed:document_version', details: null, hint: null };
    expect(mapConsentWriteError(refused).code).toBe('app_update_required');
    expect(mapConsentWriteError({ code: 'P0001', message: 'validation_failed:other', details: null, hint: null }).code).toBe(
      'validation_failed',
    );
    expect(mapConsentWriteError({ code: 'P0001', message: 'rate_limited', details: null, hint: null }).code).toBe('rate_limited');
  });
});
