import { describe, expect, it } from 'vitest';

import type { ConsentPurpose } from '@/lib/database.types';

import { applyConsentEvent, isConsentCurrent, optimisticConsent } from './consentCache';
import { BUNDLED_TERMS_PRIVACY_VERSION, type LegalFeatures } from '../constants';
import { OPTIONAL_PURPOSES } from './consentState';
import {
  PURPOSE_COPY,
  describeTermsVersion,
  optionalRows,
  requiredRows,
  switchLabel,
  visibleOptionalPurposes,
} from './privacySettings';
import { accepted, consentState, grantedState, neverRecorded } from './testFixtures';

const ALL_ON: LegalFeatures = { demographics: true, emergencyContact: true, workoutLogs: true, eventPosts: true };

describe('optional rows', () => {
  it('with every feature shipped lists the four optional purposes, in order, all off for someone who never decided', () => {
    const rows = optionalRows(neverRecorded(), ALL_ON);
    expect(rows.map((row) => row.purpose)).toEqual([...OPTIONAL_PURPOSES]);
    expect(rows.every((row) => !row.enabled && row.stateLabel === 'Off' && row.at === null)).toBe(true);
  });

  it('shows the current state from my_consents, with the state written out as text', () => {
    const my = accepted({
      push_notifications: grantedState('1', '2026-11-10T08:00:00.000Z'),
      workout_logs: consentState({ granted: false, current: false, document_version: '1', at: '2026-11-12T08:00:00.000Z' }),
    });
    const rows = Object.fromEntries(optionalRows(my, ALL_ON).map((row) => [row.purpose, row]));
    expect(rows.push_notifications).toMatchObject({ enabled: true, stateLabel: 'On', at: '2026-11-10T08:00:00.000Z' });
    expect(rows.workout_logs).toMatchObject({ enabled: false, stateLabel: 'Off' });
    expect(switchLabel(rows.push_notifications)).toBe('Push notifications: On');
    expect(switchLabel(rows.workout_logs)).toBe('Workout logs: Off');
  });

  it('every optional purpose explains itself and what turning it off deletes', () => {
    for (const purpose of OPTIONAL_PURPOSES) {
      const copy = PURPOSE_COPY[purpose];
      expect(copy.title.length).toBeGreaterThan(3);
      expect(copy.description.length).toBeGreaterThan(30);
      expect(copy.withdrawTitle.length).toBeGreaterThan(10);
      expect(copy.withdrawMessage.length).toBeGreaterThan(30);
    }
    expect(PURPOSE_COPY.push_notifications.withdrawMessage).toMatch(/delete the push tokens/);
    expect(PURPOSE_COPY.workout_logs.withdrawMessage).toMatch(/deleted/);
    expect(PURPOSE_COPY.emergency_contact.withdrawMessage).toMatch(/deleted/);
    expect(PURPOSE_COPY.profile_demographics.withdrawMessage).toMatch(/deleted/);
  });

  it('shows only the consents that exist now: push, birth year and gender, emergency contact (workout logs are not built)', () => {
    const shipped = ['push_notifications', 'profile_demographics', 'emergency_contact'];
    expect(optionalRows(neverRecorded()).map((row) => row.purpose)).toEqual(shipped);
    expect(visibleOptionalPurposes()).toEqual(shipped);
  });

  it('describes the two About-you purposes correctly and says withdrawing deletes the stored data', () => {
    const demographics = PURPOSE_COPY.profile_demographics;
    expect(demographics.description).toMatch(/rounded to the nearest 5/);
    expect(demographics.description).toMatch(/never your individual answer/);
    expect(demographics.withdrawMessage).toMatch(/birth year and gender stored for you will be deleted/);
    const emergency = PURPOSE_COPY.emergency_contact;
    expect(emergency.title).toBe('Emergency contact and T-shirt size');
    expect(emergency.description).toMatch(/organizers of your communities/);
    expect(emergency.withdrawTitle).toMatch(/T-shirt size/);
    expect(emergency.withdrawMessage).toMatch(/emergency contact and T-shirt size will be deleted/);
    expect(emergency.withdrawMessage).toMatch(/organizers will no longer see them/);
  });

  it('a flag adds exactly its own switch (all off is push only)', () => {
    expect(visibleOptionalPurposes({ demographics: false, emergencyContact: false, workoutLogs: false, eventPosts: false })).toEqual([
      'push_notifications',
    ]);
    const base: LegalFeatures = { demographics: false, emergencyContact: false, workoutLogs: false, eventPosts: false };
    expect(visibleOptionalPurposes({ ...base, demographics: true })).toEqual(['push_notifications', 'profile_demographics']);
    expect(visibleOptionalPurposes({ ...base, emergencyContact: true })).toEqual(['push_notifications', 'emergency_contact']);
    expect(visibleOptionalPurposes({ ...base, workoutLogs: true })).toEqual(['push_notifications', 'workout_logs']);
    expect(visibleOptionalPurposes({ ...base, eventPosts: true })).toEqual(['push_notifications']);
  });
});

describe('required rows', () => {
  it('shows the accepted version and date once accepted', () => {
    const [terms, age] = requiredRows(accepted());
    expect(terms).toMatchObject({ purpose: 'terms_privacy', accepted: true, version: BUNDLED_TERMS_PRIVACY_VERSION });
    expect(terms.at).not.toBeNull();
    expect(age).toMatchObject({ purpose: 'age_16', accepted: true });
  });

  it('shows a stale terms acceptance as not accepted (no old version or date presented as current)', () => {
    const my = neverRecorded({
      consents: {
        ...neverRecorded().consents,
        terms_privacy: consentState({ granted: true, current: false, document_version: 'terms:0|privacy:0', at: 'x' }),
      },
    });
    const [terms] = requiredRows(my);
    expect(terms).toMatchObject({ accepted: false, version: null, at: null });
  });

  it('describes the combined version in words', () => {
    expect(describeTermsVersion('terms:1|privacy:2')).toBe('Terms version 1, Privacy Notice version 2');
    expect(describeTermsVersion('weird')).toBe('Version weird');
    expect(describeTermsVersion(null)).toBeNull();
  });
});

describe('consent cache updates', () => {
  it('optimistic grant flips only that purpose', () => {
    const before = accepted();
    const after = optimisticConsent(before, 'push_notifications', true);
    expect(after.consents.push_notifications).toMatchObject({ granted: true, current: true });
    for (const purpose of Object.keys(before.consents) as ConsentPurpose[]) {
      if (purpose !== 'push_notifications') expect(after.consents[purpose]).toEqual(before.consents[purpose]);
    }
    expect(after.needs_terms_acceptance).toBe(before.needs_terms_acceptance);
  });

  it('applies the server event (timestamp and version) and a withdrawal turns the state off', () => {
    const on = applyConsentEvent(accepted(), {
      purpose: 'workout_logs',
      granted: true,
      document_version: '1',
      at: '2026-11-19T09:00:00.000Z',
    });
    expect(on.consents.workout_logs).toEqual({ granted: true, current: true, document_version: '1', at: '2026-11-19T09:00:00.000Z' });
    const off = applyConsentEvent(on, { purpose: 'workout_logs', granted: false, document_version: '1', at: '2026-11-19T09:05:00.000Z' });
    expect(off.consents.workout_logs).toMatchObject({ granted: false, current: false });
  });

  it('restoring the snapshot undoes an optimistic change exactly (no shared mutation)', () => {
    const snapshot = accepted();
    const copy = JSON.stringify(snapshot);
    optimisticConsent(snapshot, 'emergency_contact', true);
    expect(JSON.stringify(snapshot)).toBe(copy);
  });

  it('reports unknown until the server answered', () => {
    expect(isConsentCurrent(undefined, 'push_notifications')).toBeNull();
    expect(isConsentCurrent(accepted(), 'push_notifications')).toBe(false);
    expect(isConsentCurrent(accepted({ push_notifications: grantedState('1') }), 'push_notifications')).toBe(true);
  });
});
