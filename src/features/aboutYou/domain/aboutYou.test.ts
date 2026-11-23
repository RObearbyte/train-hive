import { describe, expect, it } from 'vitest';

import { AppError } from '@/lib/errors';

import {
  AGREE_DEMOGRAPHICS_MESSAGE,
  AGREE_EMERGENCY_MESSAGE,
  EMPTY_FORM_VALUES,
  aboutYouErrorMessage,
  aboutYouSignature,
  buildSaveRequest,
  cleanText,
  createAboutYouSchema,
  formFieldFor,
  formValuesFrom,
  hasDemographicsValue,
  hasEmergencyValue,
  isAboutYou,
  isEmptyRequest,
  parseBirthYear,
  phoneDigitCount,
  rulesFrom,
  validateBirthYear,
  validatePhone,
  type AboutYouFormValues,
} from './aboutYou';
import { emptyAboutYou } from './testFixtures';

const values = (overrides: Partial<AboutYouFormValues> = {}): AboutYouFormValues => ({
  ...EMPTY_FORM_VALUES,
  ...overrides,
});

const issues = (form: AboutYouFormValues, data = emptyAboutYou()) => {
  const result = createAboutYouSchema(rulesFrom(data)).safeParse(form);
  if (result.success) return {} as Record<string, string>;
  return Object.fromEntries(result.error.issues.map((issue) => [String(issue.path[0]), issue.message]));
};

describe('birth year', () => {
  it('uses the bounds the server gave, never the device clock', () => {
    expect(validateBirthYear('1990', 1926, 2010)).toBeNull();
    expect(validateBirthYear('1926', 1926, 2010)).toBeNull();
    expect(validateBirthYear('2010', 1926, 2010)).toBeNull();
    expect(validateBirthYear('1925', 1926, 2010)).toBe('Enter a year between 1926 and 2010.');
    expect(validateBirthYear('2011', 1926, 2010)).toBe('Enter a year between 1926 and 2010.');
    // The same text is fine when the server's year is later.
    expect(validateBirthYear('2011', 1927, 2011)).toBeNull();
  });

  it('accepts an empty field and refuses anything that is not a plain four-digit year', () => {
    expect(validateBirthYear('', 1926, 2010)).toBeNull();
    expect(validateBirthYear('  ', 1926, 2010)).toBeNull();
    for (const text of ['90', '19900', '19.9', '-1990', 'abcd', '1 990', '1990.5']) {
      expect(validateBirthYear(text, 1926, 2010), text).toBe('Enter a four-digit year, for example 1990.');
    }
    expect(parseBirthYear(' 1990 ')).toBe(1990);
    expect(parseBirthYear('')).toBeNull();
  });
});

describe('phone number', () => {
  it('follows the server rule: digits, spaces and + ( ) . / -, 6 to 20 digits, 30 characters', () => {
    for (const phone of ['+40 712 345 678', '(021) 123.45.67', '0712/345-678', '123456']) {
      expect(validatePhone(phone), phone).toBeNull();
    }
    expect(validatePhone('')).toBeNull();
    expect(validatePhone('12345')).toMatch(/6 to 20 digits/);
    expect(validatePhone('1'.repeat(21))).toMatch(/6 to 20 digits/);
    expect(validatePhone('07x2 345 678')).toMatch(/digits, spaces/);
    expect(validatePhone(`+${'1 '.repeat(15)}1`)).toMatch(/30 characters/);
    expect(phoneDigitCount('+40 (712) 345-678')).toBe(11);
  });
});

describe('text cleaning', () => {
  it('collapses whitespace, trims and strips control and bidirectional characters', () => {
    expect(cleanText('  Ana   Pop \n')).toBe('Ana Pop');
    expect(cleanText('Ana‮Pop​')).toBe('AnaPop');
    expect(cleanText('​‮ ')).toBe('');
  });
});

describe('form schema', () => {
  it('an empty form is valid (everything is optional)', () => {
    expect(issues(values())).toEqual({});
  });

  it('asks for the agreement of a block that has something filled in and no agreement on record', () => {
    expect(issues(values({ gender: 'woman' })).agreeDemographics).toBe(AGREE_DEMOGRAPHICS_MESSAGE);
    expect(issues(values({ gender: 'woman', agreeDemographics: true }))).toEqual({});
    expect(issues(values({ tshirtSize: 'M' })).agreeEmergency).toBe(AGREE_EMERGENCY_MESSAGE);
    expect(issues(values({ tshirtSize: 'M', agreeEmergency: true }))).toEqual({});
  });

  it('does not ask again when the agreement is on record, and the blocks are independent', () => {
    const agreed = emptyAboutYou({ consents: { profile_demographics: true, emergency_contact: false } });
    expect(issues(values({ birthYear: '1990' }), agreed)).toEqual({});
    expect(issues(values({ birthYear: '1990', tshirtSize: 'L' }), agreed).agreeEmergency).toBe(AGREE_EMERGENCY_MESSAGE);
    // Only the demographics block is filled in: the other agreement is not asked for.
    expect(issues(values({ birthYear: '1990', agreeDemographics: true }))).toEqual({});
  });

  it('needs a name and a phone number together', () => {
    const ok = { agreeEmergency: true };
    expect(issues(values({ ...ok, contactName: 'Ion' })).contactPhone).toMatch(/phone number/);
    expect(issues(values({ ...ok, contactPhone: '0712 345 678' })).contactName).toMatch(/name/);
    expect(issues(values({ ...ok, contactRelationship: 'Sister' })).contactName).toMatch(/relationship/);
    expect(issues(values({ ...ok, contactName: 'Ion', contactPhone: '0712 345 678' }))).toEqual({});
  });

  it('reports the field messages for length, phone and year', () => {
    const bad = issues(
      values({
        birthYear: '1800',
        contactName: 'x'.repeat(81),
        contactPhone: 'abc',
        contactRelationship: 'y'.repeat(41),
        agreeDemographics: true,
        agreeEmergency: true,
      }),
    );
    expect(bad.birthYear).toMatch(/between 1926 and 2010/);
    expect(bad.contactName).toMatch(/80 characters/);
    expect(bad.contactPhone).toMatch(/digits, spaces/);
    expect(bad.contactRelationship).toMatch(/40 characters/);
  });

  it('counts characters, not UTF-16 units', () => {
    const name = '\u{1F3C3}'.repeat(80);
    expect(issues(values({ contactName: name, contactPhone: '0712 345 678', agreeEmergency: true }))).toEqual({});
  });

  it('refuses a gender or size that is not offered', () => {
    const result = createAboutYouSchema(rulesFrom(emptyAboutYou())).safeParse({ ...EMPTY_FORM_VALUES, gender: 'robot' });
    expect(result.success).toBe(false);
  });
});

describe('what a block has', () => {
  it('reads filled-in values per block', () => {
    expect(hasDemographicsValue(values())).toBe(false);
    expect(hasDemographicsValue(values({ birthYear: '1990' }))).toBe(true);
    expect(hasEmergencyValue(values({ contactName: '  ' }))).toBe(false);
    expect(hasEmergencyValue(values({ tshirtSize: 'S' }))).toBe(true);
  });
});

describe('buildSaveRequest', () => {
  it('sends only what changed and records the agreements the new data needs', () => {
    const request = buildSaveRequest(
      values({ birthYear: '1990', gender: 'man', agreeDemographics: true }),
      emptyAboutYou(),
    );
    expect(request).toEqual({ input: { birth_year: 1990, gender: 'man' }, consents: ['profile_demographics'] });
    expect(isEmptyRequest(request)).toBe(false);
  });

  it('the person may fill only one block', () => {
    const request = buildSaveRequest(
      values({ contactName: ' Ion  Pop ', contactPhone: '+40 712 345 678', tshirtSize: 'M', agreeEmergency: true }),
      emptyAboutYou(),
    );
    expect(request.input).toEqual({
      emergency_contact_name: 'Ion Pop',
      emergency_contact_phone: '+40 712 345 678',
      tshirt_size: 'M',
    });
    expect(request.consents).toEqual(['emergency_contact']);
    expect(request.input).not.toHaveProperty('birth_year');
    expect(request.input).not.toHaveProperty('gender');
  });

  it('records no agreement again when it is on record, and none for a pure clear', () => {
    const stored = emptyAboutYou({
      has_data: true,
      birth_year: 1985,
      gender: 'woman',
      tshirt_size: 'S',
      emergency_contact_name: 'Ion',
      emergency_contact_phone: '0712 345 678',
      emergency_contact_relationship: 'Brother',
      consents: { profile_demographics: true, emergency_contact: true },
    });
    const unchanged = buildSaveRequest(formValuesFrom(stored), stored);
    expect(unchanged).toEqual({ input: {}, consents: [] });
    expect(isEmptyRequest(unchanged)).toBe(true);

    const withdrawnAgreements = { ...stored, consents: { profile_demographics: false, emergency_contact: false } };
    const cleared = buildSaveRequest(values(), withdrawnAgreements);
    expect(cleared.input).toEqual({
      birth_year: null,
      gender: null,
      emergency_contact_name: null,
      emergency_contact_phone: null,
      emergency_contact_relationship: null,
      tshirt_size: null,
    });
    expect(cleared.consents).toEqual([]);
  });

  it('clearing the contact clears its relationship too', () => {
    const stored = emptyAboutYou({
      has_data: true,
      emergency_contact_name: 'Ion',
      emergency_contact_phone: '0712 345 678',
      emergency_contact_relationship: 'Brother',
      consents: { profile_demographics: false, emergency_contact: true },
    });
    const request = buildSaveRequest(
      values({ contactRelationship: 'Brother', contactName: '', contactPhone: '' }),
      stored,
    );
    expect(request.input).toEqual({
      emergency_contact_name: null,
      emergency_contact_phone: null,
      emergency_contact_relationship: null,
    });
  });

  it('a request with nothing in it is empty', () => {
    expect(isEmptyRequest(buildSaveRequest(values(), emptyAboutYou()))).toBe(true);
  });
});

describe('form values from the server and the signature', () => {
  it('starts with the agreement boxes unticked', () => {
    const form = formValuesFrom(emptyAboutYou({ birth_year: 1990, gender: 'other', tshirt_size: 'XL' }));
    expect(form).toMatchObject({ birthYear: '1990', gender: 'other', tshirtSize: 'XL', agreeDemographics: false, agreeEmergency: false });
  });

  it('the signature changes with the stored data, not with the agreements (a failed save must not wipe the form)', () => {
    const base = emptyAboutYou();
    expect(aboutYouSignature(base)).toBe(aboutYouSignature(emptyAboutYou()));
    expect(aboutYouSignature(base)).not.toBe(aboutYouSignature(emptyAboutYou({ updated_at: '2026-11-23T10:00:00Z' })));
    expect(aboutYouSignature(base)).toBe(
      aboutYouSignature(emptyAboutYou({ consents: { profile_demographics: true, emergency_contact: false } })),
    );
  });
});

describe('errors', () => {
  it('maps the server codes to friendly text', () => {
    const consent = new AppError('consent_required', { field: 'emergency_contact' });
    expect(aboutYouErrorMessage(consent)).toMatch(/emergency contact or T-shirt size/);
    expect(aboutYouErrorMessage(new AppError('validation_failed', { field: 'birth_year' }))).toBe(
      'The birth year is not valid. Please check it and try again.',
    );
    expect(aboutYouErrorMessage(new AppError('not_a_member'))).toMatch(/Join a community/);
    expect(aboutYouErrorMessage(new AppError('network_error'))).toMatch(/No connection/);
    expect(aboutYouErrorMessage(new Error('boom'))).toBe('Something went wrong. Please try again.');
  });

  it('points a validation error at its form field', () => {
    expect(formFieldFor('birth_year')).toBe('birthYear');
    expect(formFieldFor('emergency_contact_phone')).toBe('contactPhone');
    expect(formFieldFor('tshirt_size')).toBe('tshirtSize');
    expect(formFieldFor('input')).toBeNull();
    expect(formFieldFor(undefined)).toBeNull();
  });
});

describe('isAboutYou', () => {
  it('accepts the server shape and rejects anything else', () => {
    expect(isAboutYou(emptyAboutYou())).toBe(true);
    expect(isAboutYou({ ...emptyAboutYou(), consents: undefined })).toBe(false);
    expect(isAboutYou({ ...emptyAboutYou(), birth_year_min: '1926' })).toBe(false);
    expect(isAboutYou(null)).toBe(false);
    expect(isAboutYou([])).toBe(false);
  });
});

describe('phone: the plus sign (P3-QA-5) and cleaning order (very low)', () => {
  it('accepts + only as the first character, like the server', () => {
    expect(validatePhone('+40 712 345 678')).toBeNull();
    expect(validatePhone('0712+345 678')).toMatch(/with a \+ only at the start/);
    expect(validatePhone('+40 +712 345 678')).toMatch(/with a \+ only at the start/);
    expect(validatePhone('0712 345 678+')).toMatch(/with a \+ only at the start/);
    expect(validatePhone('++40712345678')).toMatch(/with a \+ only at the start/);
  });

  it('removes bidi controls before collapsing spaces', () => {
    expect(cleanText('Ion ‮ Pop')).toBe('Ion Pop');
    expect(cleanText('Ion‮  Pop\tX')).toBe('Ion Pop X');
    expect(cleanText('a\u0007b')).toBe('ab');
  });
});
