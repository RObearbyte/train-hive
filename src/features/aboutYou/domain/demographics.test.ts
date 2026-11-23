import { describe, expect, it } from 'vitest';

import type { CommunityDemographics } from '@/lib/database.types';

import {
  HIDDEN_LABEL,
  ageBandRows,
  basisLine,
  genderRows,
  isCommunityDemographics,
  suppressionNote,
} from './demographics';

const data: CommunityDemographics = {
  community_id: 'c1',
  min_group_size: 5,
  member_count: 20,
  reference_year: 2026,
  age_bands: [
    { key: 'under_18', count: null, suppressed: true },
    { key: '18_29', count: 6, suppressed: false },
    { key: '30_39', count: 8, suppressed: false },
    { key: '40_49', count: null, suppressed: true },
    { key: '50_59', count: null, suppressed: true },
    { key: '60_plus', count: null, suppressed: true },
    { key: 'not_provided', count: 6, suppressed: false },
  ],
  genders: [
    { key: 'woman', count: 9, suppressed: false },
    { key: 'man', count: 11, suppressed: false },
    { key: 'other', count: null, suppressed: true },
    { key: 'prefer_not_to_say', count: null, suppressed: true },
    { key: 'not_provided', count: null, suppressed: true },
  ],
};

describe('rows', () => {
  it('labels the age bands and shows hidden cells as hidden, never as a number', () => {
    const rows = ageBandRows(data);
    expect(rows.map((row) => row.label)).toEqual([
      'Under 18',
      '18 to 29',
      '30 to 39',
      '40 to 49',
      '50 to 59',
      '60 or older',
      'Not provided',
    ]);
    expect(rows[0]).toMatchObject({ value: HIDDEN_LABEL, suppressed: true, accessibilityLabel: 'Under 18: hidden, small group' });
    expect(rows[1]).toMatchObject({ value: '6', suppressed: false, accessibilityLabel: '18 to 29: 6' });
  });

  it('labels the genders', () => {
    const rows = genderRows(data);
    expect(rows.map((row) => `${row.label}=${row.value}`)).toEqual([
      'Woman=9',
      'Man=11',
      `Other=${HIDDEN_LABEL}`,
      `Prefer not to say=${HIDDEN_LABEL}`,
      `Not provided=${HIDDEN_LABEL}`,
    ]);
  });

  it('a count of zero is a number, not hidden', () => {
    const rows = genderRows({ ...data, genders: [{ key: 'woman', count: 0, suppressed: false }] });
    expect(rows[0].value).toBe('0');
  });
});

describe('texts', () => {
  it('explains the rule and that hidden groups can be larger', () => {
    const note = suppressionNote(5);
    expect(note).toMatch(/fewer than 5 people are hidden/);
    expect(note).toMatch(/subtraction/);
    expect(note).toMatch(/Individual answers are never shown/);
  });

  it('states the basis with the server year', () => {
    expect(basisLine(data)).toBe('Based on 20 active members. Age is the age reached in 2026.');
    expect(basisLine({ ...data, member_count: 1 })).toMatch(/1 active member\./);
  });
});

describe('shape check', () => {
  it('accepts the server shape and rejects a number on a hidden cell or none on a shown one', () => {
    expect(isCommunityDemographics(data)).toBe(true);
    expect(isCommunityDemographics({ ...data, age_bands: [{ key: 'x', count: 3, suppressed: true }] })).toBe(false);
    expect(isCommunityDemographics({ ...data, genders: [{ key: 'x', count: null, suppressed: false }] })).toBe(false);
    expect(isCommunityDemographics({ ...data, member_count: '20' })).toBe(false);
    expect(isCommunityDemographics(null)).toBe(false);
  });
});
