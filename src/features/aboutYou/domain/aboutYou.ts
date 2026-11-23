/**
 * "About you": form values, validation and the request sent to
 * `save_my_about_you`. Pure TypeScript (no react-native).
 *
 * The server owns every rule; the checks here only save a round trip. The
 * allowed birth-year range comes from the server (`birth_year_min` /
 * `birth_year_max` of `get_my_about_you`), never from the device clock.
 */
import { z } from 'zod';

import type {
  AboutYou,
  AboutYouGender,
  AboutYouInput,
  ConsentPurpose,
  TshirtSize,
} from '@/lib/database.types';
import { toAppError, userMessage } from '@/lib/errors';

export const GENDER_OPTIONS: readonly { value: AboutYouGender; label: string }[] = [
  { value: 'woman', label: 'Woman' },
  { value: 'man', label: 'Man' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
];

export const TSHIRT_SIZES: readonly TshirtSize[] = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

export const CONTACT_NAME_MAX = 80;
export const CONTACT_RELATIONSHIP_MAX = 40;
export const CONTACT_PHONE_MAX = 30;
export const PHONE_DIGITS_MIN = 6;
export const PHONE_DIGITS_MAX = 20;

const GENDER_VALUES = GENDER_OPTIONS.map((option) => option.value) as [AboutYouGender, ...AboutYouGender[]];
const SIZE_VALUES = [...TSHIRT_SIZES] as [TshirtSize, ...TshirtSize[]];

/** Everything the form holds as text, so an empty field is the empty string. */
export type AboutYouFormValues = {
  birthYear: string;
  gender: AboutYouGender | '';
  /** Ticked in the first agreement block (only asked while that agreement is not on record). */
  agreeDemographics: boolean;
  contactName: string;
  contactPhone: string;
  contactRelationship: string;
  tshirtSize: TshirtSize | '';
  agreeEmergency: boolean;
};

export const EMPTY_FORM_VALUES: AboutYouFormValues = {
  birthYear: '',
  gender: '',
  agreeDemographics: false,
  contactName: '',
  contactPhone: '',
  contactRelationship: '',
  tshirtSize: '',
  agreeEmergency: false,
};

/** The stored details as form values. The agreement boxes always start unticked. */
export function formValuesFrom(data: AboutYou): AboutYouFormValues {
  return {
    birthYear: data.birth_year === null ? '' : String(data.birth_year),
    gender: data.gender ?? '',
    agreeDemographics: false,
    contactName: data.emergency_contact_name ?? '',
    contactPhone: data.emergency_contact_phone ?? '',
    contactRelationship: data.emergency_contact_relationship ?? '',
    tshirtSize: data.tshirt_size ?? '',
    agreeEmergency: false,
  };
}

/**
 * Changes whenever the stored details change: tells the form to start again from the server's copy.
 * Agreements are left out on purpose: recording one before a save that then fails must not wipe what was typed.
 */
export function aboutYouSignature(data: AboutYou): string {
  return JSON.stringify([
    data.updated_at,
    data.birth_year_min,
    data.birth_year_max,
  ]);
}

/** Length in characters (code points), as Postgres counts. */
export function charCount(text: string): number {
  return Array.from(text).length;
}

/**
 * Text the way the server stores it: whitespace collapsed and trimmed, control
 * and bidirectional-control characters removed. A value that is empty after this
 * is treated as not given.
 */
export function cleanText(text: string): string {
  return text
    .replace(/[\p{Cc}​-‏‪-‮⁦-⁩؜﻿]/gu, (char) => (/\s/u.test(char) ? char : ''))
    .replace(/\s+/gu, ' ')
    .trim();
}

function nullIfEmpty(text: string): string | null {
  const cleaned = cleanText(text);
  return cleaned === '' ? null : cleaned;
}

/** Digits in a phone number (all other allowed characters are ignored). */
export function phoneDigitCount(phone: string): number {
  return (phone.match(/\d/g) ?? []).length;
}

/** Null when fine (or empty), else the message for the field. */
export function validatePhone(text: string): string | null {
  const phone = cleanText(text);
  if (phone === '') return null;
  if (charCount(phone) > CONTACT_PHONE_MAX) return `Keep the phone number to ${CONTACT_PHONE_MAX} characters.`;
  if (!/^\+?[0-9 ()./-]+$/u.test(phone)) {
    return 'Use digits, spaces and ( ) . / - only, with a + only at the start.';
  }
  const digits = phoneDigitCount(phone);
  if (digits < PHONE_DIGITS_MIN || digits > PHONE_DIGITS_MAX) {
    return `A phone number has ${PHONE_DIGITS_MIN} to ${PHONE_DIGITS_MAX} digits.`;
  }
  return null;
}

export function validateContactName(text: string): string | null {
  const name = cleanText(text);
  if (charCount(name) > CONTACT_NAME_MAX) return `Keep the name to ${CONTACT_NAME_MAX} characters.`;
  return null;
}

export function validateRelationship(text: string): string | null {
  const relationship = cleanText(text);
  if (charCount(relationship) > CONTACT_RELATIONSHIP_MAX) {
    return `Keep it to ${CONTACT_RELATIONSHIP_MAX} characters.`;
  }
  return null;
}

/** The birth year as a number, or null when the field is empty or not a plain four-digit year. */
export function parseBirthYear(text: string): number | null {
  const trimmed = text.trim();
  return /^\d{4}$/.test(trimmed) ? Number(trimmed) : null;
}

/** Null when fine (or empty), else the message for the field. `min` and `max` come from the server. */
export function validateBirthYear(text: string, min: number, max: number): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const year = parseBirthYear(trimmed);
  if (year === null) return 'Enter a four-digit year, for example 1990.';
  if (year < min || year > max) return `Enter a year between ${min} and ${max}.`;
  return null;
}

/** What the person has filled in, per agreement block. */
export function hasDemographicsValue(values: AboutYouFormValues): boolean {
  return values.birthYear.trim() !== '' || values.gender !== '';
}

export function hasEmergencyValue(values: AboutYouFormValues): boolean {
  return (
    cleanText(values.contactName) !== '' ||
    cleanText(values.contactPhone) !== '' ||
    cleanText(values.contactRelationship) !== '' ||
    values.tshirtSize !== ''
  );
}

export type FormRules = {
  birthYearMin: number;
  birthYearMax: number;
  /** Which agreements are already on record. */
  consents: AboutYou['consents'];
};

export function rulesFrom(data: AboutYou): FormRules {
  return { birthYearMin: data.birth_year_min, birthYearMax: data.birth_year_max, consents: data.consents };
}

export const AGREE_DEMOGRAPHICS_MESSAGE =
  'Tick the box to agree, or clear the birth year and gender.';
export const AGREE_EMERGENCY_MESSAGE =
  'Tick the box to agree, or clear the emergency contact and T-shirt size.';

/**
 * Zod schema of the form for the given rules. A block with something filled in
 * and no agreement on record needs its box ticked; an emergency contact needs
 * a name and a phone number together (or neither).
 */
export function createAboutYouSchema(rules: FormRules) {
  return z
    .object({
      birthYear: z.string(),
      gender: z.enum([...GENDER_VALUES, '']),
      agreeDemographics: z.boolean(),
      contactName: z.string(),
      contactPhone: z.string(),
      contactRelationship: z.string(),
      tshirtSize: z.enum([...SIZE_VALUES, '']),
      agreeEmergency: z.boolean(),
    })
    .superRefine((values, ctx) => {
      const issue = (path: keyof AboutYouFormValues, message: string | null) => {
        if (message !== null) ctx.addIssue({ code: 'custom', path: [path], message });
      };

      issue('birthYear', validateBirthYear(values.birthYear, rules.birthYearMin, rules.birthYearMax));
      issue('contactName', validateContactName(values.contactName));
      issue('contactPhone', validatePhone(values.contactPhone));
      issue('contactRelationship', validateRelationship(values.contactRelationship));

      const name = cleanText(values.contactName);
      const phone = cleanText(values.contactPhone);
      if (name !== '' && phone === '') issue('contactPhone', 'Add a phone number, or clear the name.');
      if (phone !== '' && name === '') issue('contactName', 'Add a name, or clear the phone number.');
      if (name === '' && phone === '' && cleanText(values.contactRelationship) !== '') {
        issue('contactName', 'Add a name and phone number, or clear the relationship.');
      }

      if (hasDemographicsValue(values) && !rules.consents.profile_demographics && !values.agreeDemographics) {
        issue('agreeDemographics', AGREE_DEMOGRAPHICS_MESSAGE);
      }
      if (hasEmergencyValue(values) && !rules.consents.emergency_contact && !values.agreeEmergency) {
        issue('agreeEmergency', AGREE_EMERGENCY_MESSAGE);
      }
    });
}

export type SaveRequest = {
  /** Only the fields that differ from what is stored; absent keys stay as they are on the server. */
  input: AboutYouInput;
  /** Agreements to record first (only those the saved fields need and that are not on record yet). */
  consents: ConsentPurpose[];
};

/**
 * What to send for validated form values, compared with the stored details.
 * A field emptied in the form is sent as `null` (clearing never needs an
 * agreement). A relationship without a contact is cleared with it.
 */
export function buildSaveRequest(values: AboutYouFormValues, stored: AboutYou): SaveRequest {
  const input: AboutYouInput = {};

  const birthYear = parseBirthYear(values.birthYear);
  const gender = values.gender === '' ? null : values.gender;
  if (birthYear !== stored.birth_year) input.birth_year = birthYear;
  if (gender !== stored.gender) input.gender = gender;

  const name = nullIfEmpty(values.contactName);
  const phone = nullIfEmpty(values.contactPhone);
  const hasContact = name !== null && phone !== null;
  const contactName = hasContact ? name : null;
  const contactPhone = hasContact ? phone : null;
  const contactRelationship = hasContact ? nullIfEmpty(values.contactRelationship) : null;
  const size = values.tshirtSize === '' ? null : values.tshirtSize;
  if (contactName !== stored.emergency_contact_name) input.emergency_contact_name = contactName;
  if (contactPhone !== stored.emergency_contact_phone) input.emergency_contact_phone = contactPhone;
  if (contactRelationship !== stored.emergency_contact_relationship) {
    input.emergency_contact_relationship = contactRelationship;
  }
  if (size !== stored.tshirt_size) input.tshirt_size = size;

  const consents: ConsentPurpose[] = [];
  const setsDemographics = (input.birth_year ?? null) !== null || (input.gender ?? null) !== null;
  if (setsDemographics && !stored.consents.profile_demographics) consents.push('profile_demographics');
  const setsEmergency =
    (input.emergency_contact_name ?? null) !== null ||
    (input.emergency_contact_phone ?? null) !== null ||
    (input.emergency_contact_relationship ?? null) !== null ||
    (input.tshirt_size ?? null) !== null;
  if (setsEmergency && !stored.consents.emergency_contact) consents.push('emergency_contact');

  return { input, consents };
}

export function isEmptyRequest(request: SaveRequest): boolean {
  return Object.keys(request.input).length === 0 && request.consents.length === 0;
}

const FIELD_PATHS: ReadonlySet<string> = new Set([
  'birth_year',
  'gender',
  'emergency_contact_name',
  'emergency_contact_phone',
  'emergency_contact_relationship',
  'tshirt_size',
]);

/** The form field a `validation_failed:<field>` points at, or null when it is not one of them. */
export function formFieldFor(serverField: string | undefined): keyof AboutYouFormValues | null {
  switch (serverField) {
    case 'birth_year':
      return 'birthYear';
    case 'gender':
      return 'gender';
    case 'emergency_contact_name':
      return 'contactName';
    case 'emergency_contact_phone':
      return 'contactPhone';
    case 'emergency_contact_relationship':
      return 'contactRelationship';
    case 'tshirt_size':
      return 'tshirtSize';
    default:
      return null;
  }
}

/** Friendly text for a failed save, clear or load. */
export function aboutYouErrorMessage(error: unknown): string {
  const appError = toAppError(error);
  if (appError.code === 'not_a_member') {
    return 'Your profile could not be found. Join a community first, then try again.';
  }
  if (appError.code === 'validation_failed' && appError.field !== undefined && FIELD_PATHS.has(appError.field)) {
    return userMessage('validation_failed', appError.field);
  }
  return userMessage(appError.code, appError.field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';

/** True when `value` has the shape of `AboutYou` (so a changed server answer is an error, not a crash). */
export function isAboutYou(value: unknown): value is AboutYou {
  if (!isRecord(value)) return false;
  const consents = value.consents;
  return (
    typeof value.has_data === 'boolean' &&
    (value.birth_year === null || typeof value.birth_year === 'number') &&
    nullableString(value.gender) &&
    nullableString(value.emergency_contact_name) &&
    nullableString(value.emergency_contact_phone) &&
    nullableString(value.emergency_contact_relationship) &&
    nullableString(value.tshirt_size) &&
    nullableString(value.updated_at) &&
    typeof value.birth_year_min === 'number' &&
    typeof value.birth_year_max === 'number' &&
    isRecord(consents) &&
    typeof consents.profile_demographics === 'boolean' &&
    typeof consents.emergency_contact === 'boolean'
  );
}
