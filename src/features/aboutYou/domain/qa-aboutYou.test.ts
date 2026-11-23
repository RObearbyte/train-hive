import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AboutYou, CommunityEmergencyList, MemberEmergencyInfo } from '@/lib/database.types';

import {
  aboutYouSignature,
  buildSaveRequest,
  createAboutYouSchema,
  EMPTY_FORM_VALUES,
  isAboutYou,
  rulesFrom,
  type AboutYouFormValues,
} from './aboutYou';
import { emergencyListText, infoAccessibilityLabel, telHref } from './emergency';

/**
 * QA review of P3 (client side): link safety, the request the form builds, the one place the form
 * can lose input, and personal data in error reports. "DEFECT P3-QA-n" tests use `it.fails`: they
 * assert the safe behaviour, pass only while the defect exists, and must lose `.fails` when fixed.
 */

const stored = (over: Partial<AboutYou> = {}): AboutYou => ({
  has_data: false,
  birth_year: null,
  gender: null,
  emergency_contact_name: null,
  emergency_contact_phone: null,
  emergency_contact_relationship: null,
  tshirt_size: null,
  updated_at: null,
  birth_year_min: 1926,
  birth_year_max: 2010,
  consents: { profile_demographics: false, emergency_contact: false },
  ...over,
});
const form = (over: Partial<AboutYouFormValues> = {}): AboutYouFormValues => ({ ...EMPTY_FORM_VALUES, ...over });

describe('tel: links', () => {
  it('only digits and one leading plus survive, whatever was stored', () => {
    const hostile = [
      '0700000000;ext=1',
      '0700000000,1234',
      '0700#000000',
      '*31#0700000000',
      '+40 700 000 000',
      '(+40) 700 000 000',
      '0700 000 000\n--header: x',
      'javascript:alert(1)0700000',
      '%0A0700000000',
      '٠٧٠٠٠٠٠٠٠٠',
      '１２３４５６７８',
      '+4+0700000000',
      '  +40700000000',
    ];
    for (const phone of hostile) {
      const href = telHref(phone);
      if (href !== null) expect(href, phone).toMatch(/^tel:\+?[0-9]+$/);
    }
    expect(telHref('+40 700 000 000')).toBe('tel:+40700000000');
    expect(telHref(null)).toBeNull();
    expect(telHref('call me')).toBeNull();
    expect(telHref('٠٧٠٠٠٠٠٠٠٠')).toBeNull();
  });
});

describe('the Copy / Share text', () => {
  const member = (over: Partial<MemberEmergencyInfo> = {}): MemberEmergencyInfo => ({
    user_id: 'u1',
    display_name: 'Ana Pop',
    role: 'member',
    emergency_contact_name: 'Ion',
    emergency_contact_phone: '0700 000 000',
    emergency_contact_relationship: 'brother',
    tshirt_size: 'M',
    has_emergency_contact: true,
    updated_at: '2026-11-23T10:00:00Z',
    ...over,
  });

  it('prints only the contact, phone and size, even when the answer carries extra fields', () => {
    const extra = { ...member(), birth_year: 1990, gender: 'woman', secret: 'zzz' } as MemberEmergencyInfo;
    const list: CommunityEmergencyList = { community_id: 'c', members: [extra], truncated: false };
    const text = emergencyListText(list, 'Club');
    expect(text).not.toMatch(/1990|woman|zzz|birth|gender/);
    expect(text).toContain('Ana Pop');
    expect(text).toContain('Emergency contact: Ion (brother), 0700 000 000');
    expect(text).toContain('T-shirt size: M');
  });

  it('a size-only member and a contact-only member read correctly; the 500 cut is announced', () => {
    const list: CommunityEmergencyList = {
      community_id: 'c',
      truncated: true,
      members: [
        member({ user_id: 'a', has_emergency_contact: false, emergency_contact_name: null, emergency_contact_phone: null, emergency_contact_relationship: null }),
        member({ user_id: 'b', tshirt_size: null }),
      ],
    };
    const text = emergencyListText(list, 'Club');
    expect(text).toContain('Emergency contact: none');
    expect(text).toContain('T-shirt size: not given');
    expect(text).toContain('2 members shared details.');
    expect(text).toContain('cut at 500');
  });

  it('the spoken label never invents data', () => {
    expect(infoAccessibilityLabel(member({ has_emergency_contact: false, emergency_contact_name: null, emergency_contact_phone: null, emergency_contact_relationship: null, tshirt_size: null }))).toBe(
      'Ana Pop: nothing shared',
    );
  });
});

describe('the save request', () => {
  it('sends nothing for an untouched form and never a consent it does not need', () => {
    const data = stored({ birth_year: 1990, gender: 'man', consents: { profile_demographics: true, emergency_contact: false } });
    const request = buildSaveRequest(form({ birthYear: '1990', gender: 'man' }), data);
    expect(request).toEqual({ input: {}, consents: [] });
  });

  it('clearing everything sends only nulls and records no agreement', () => {
    const data = stored({
      birth_year: 1990,
      gender: 'man',
      emergency_contact_name: 'Ion',
      emergency_contact_phone: '0700 000 000',
      emergency_contact_relationship: 'brother',
      tshirt_size: 'M',
      consents: { profile_demographics: true, emergency_contact: true },
    });
    const request = buildSaveRequest(form(), data);
    expect(request.consents).toEqual([]);
    expect(request.input).toEqual({
      birth_year: null,
      gender: null,
      emergency_contact_name: null,
      emergency_contact_phone: null,
      emergency_contact_relationship: null,
      tshirt_size: null,
    });
  });

  it('a relationship typed without a contact is dropped, and filling one block never asks for the other agreement', () => {
    const request = buildSaveRequest(form({ contactRelationship: 'friend', birthYear: '1991' }), stored());
    expect(request.input).toEqual({ birth_year: 1991 });
    expect(request.consents).toEqual(['profile_demographics']);
  });

  it('a size alone needs the emergency agreement (the server groups it with the contact)', () => {
    const request = buildSaveRequest(form({ tshirtSize: 'L' }), stored());
    expect(request).toEqual({ input: { tshirt_size: 'L' }, consents: ['emergency_contact'] });
  });

  it('text is sent cleaned: collapsed, trimmed, controls and bidi marks gone', () => {
    const request = buildSaveRequest(
      form({ contactName: '  Ion‮  Pop\t', contactPhone: ' +40  700 000 000 ', contactRelationship: ' brother\u0007 ' }),
      stored({ consents: { profile_demographics: false, emergency_contact: true } }),
    );
    expect(request.input).toEqual({
      emergency_contact_name: 'Ion Pop',
      emergency_contact_phone: '+40 700 000 000',
      emergency_contact_relationship: 'brother',
    });
  });

  it('the schema refuses a half contact, a missing agreement and a year outside the server range', () => {
    const schema = createAboutYouSchema(rulesFrom(stored()));
    const bad = (values: Partial<AboutYouFormValues>) => schema.safeParse(form(values)).success;
    expect(bad({ contactName: 'Ion' })).toBe(false);
    expect(bad({ contactPhone: '0700 000 000' })).toBe(false);
    expect(bad({ contactRelationship: 'brother' })).toBe(false);
    expect(bad({ birthYear: '1926', gender: '', agreeDemographics: false })).toBe(false); // needs the box
    expect(bad({ birthYear: '1926', agreeDemographics: true })).toBe(true);
    expect(bad({ birthYear: '1925', agreeDemographics: true })).toBe(false);
    expect(bad({ birthYear: '2011', agreeDemographics: true })).toBe(false);
    expect(bad({ birthYear: '٢٠٠٠', agreeDemographics: true })).toBe(false);
    expect(bad({ birthYear: '19 90', agreeDemographics: true })).toBe(false);
    expect(bad({})).toBe(true);
  });

  it('isAboutYou refuses an answer that lost a field (an error, not a crash)', () => {
    const { consents: _consents, ...withoutConsents } = stored();
    expect(isAboutYou(stored())).toBe(true);
    expect(isAboutYou(withoutConsents)).toBe(false);
    expect(isAboutYou({ ...stored(), birth_year: '1990' })).toBe(false);
  });
});

describe('the form after an agreement is recorded', () => {
  // DEFECT P3-QA-2 (low/medium): saveMyAboutYou records the agreement(s) BEFORE calling
  // save_my_about_you. If the save then fails (network, validation), useSaveAboutYou refetches, the
  // agreements flag flips, aboutYouSignature changes and AboutYouForm resets every field to the
  // stored copy: the person loses what they typed. The signature should ignore the agreements, or
  // the form should not reset while it holds unsaved edits.
  it.fails('DEFECT P3-QA-2: recording an agreement alone does not change the signature that resets the form', () => {
    const before = stored({ updated_at: null });
    const after = stored({ updated_at: null, consents: { profile_demographics: true, emergency_contact: false } });
    expect(aboutYouSignature(after)).toBe(aboutYouSignature(before));
  });
});

describe('personal data in error reports', () => {
  const root = join(__dirname, '..');
  const read = (file: string) => readFileSync(join(root, file), 'utf8');

  // DEFECT P3-QA-3 (low): api/aboutYou.ts `unexpected()` keeps the whole RPC answer in
  // AppError.original, and src/lib/logger.ts prints `original` with console.warn. A shape mismatch
  // (a server change, a partial answer) therefore writes birth year, phone numbers and names of
  // every member in the emergency list to the device log. Keep only the function name and the
  // type of each field.
  it.fails('DEFECT P3-QA-3: a shape error does not carry the answer it could not read', () => {
    expect(read('api/aboutYou.ts')).not.toMatch(/original:\s*data/);
  });

  // DEFECT P3-QA-4 (low): MemberEmergencySection reports the Linking.openURL rejection, whose
  // message contains the tel: URL (the emergency contact's phone number), through reportError.
  it.fails('DEFECT P3-QA-4: a failed call attempt does not log the number', () => {
    const source = read('components/MemberEmergencySection.tsx');
    expect(source).not.toMatch(/reportError\('aboutYou\.call',\s*error\)/);
  });

  it('nothing else in the About-you feature logs or prints values', () => {
    for (const file of [
      'api/aboutYou.ts',
      'hooks/useAboutYou.ts',
      'hooks/useOrganizerData.ts',
      'components/AboutYouForm.tsx',
      'components/AboutYouScreen.tsx',
      'components/EmergencyListSection.tsx',
      'components/CommunityProfileCard.tsx',
    ]) {
      const source = read(file);
      expect(source, file).not.toMatch(/console\./);
      // reportError gets a context and an error (or only its code), never form values or answers.
      for (const call of source.matchAll(/reportError\(([^)]*)\)/g)) {
        expect(call[1], `${file}: ${call[0]}`).not.toMatch(/values|input|data|info|member|phone|name/i);
      }
    }
  });
});
