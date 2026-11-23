/**
 * The "Community profile" card: grouped age and gender numbers for
 * organizers. The server suppresses small groups; this only labels what it
 * returns. Pure TypeScript.
 */
import type { AboutYouGender, AgeBand, CommunityDemographics, DemographicsCell } from '@/lib/database.types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCell(value: unknown): value is DemographicsCell<string> {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.suppressed === 'boolean' &&
    (value.count === null || typeof value.count === 'number') &&
    // A shown cell has a number and a hidden one has none: anything else is not trusted.
    (value.suppressed ? value.count === null : value.count !== null)
  );
}

export function isCommunityDemographics(value: unknown): value is CommunityDemographics {
  return (
    isRecord(value) &&
    typeof value.community_id === 'string' &&
    typeof value.min_group_size === 'number' &&
    typeof value.member_count === 'number' &&
    typeof value.reference_year === 'number' &&
    Array.isArray(value.age_bands) &&
    value.age_bands.every(isCell) &&
    Array.isArray(value.genders) &&
    value.genders.every(isCell)
  );
}

export const AGE_BAND_LABELS: Record<AgeBand, string> = {
  under_18: 'Under 18',
  '18_29': '18 to 29',
  '30_39': '30 to 39',
  '40_49': '40 to 49',
  '50_59': '50 to 59',
  '60_plus': '60 or older',
  not_provided: 'Not provided',
};

export const GENDER_LABELS: Record<AboutYouGender | 'not_provided', string> = {
  woman: 'Woman',
  man: 'Man',
  other: 'Other',
  prefer_not_to_say: 'Prefer not to say',
  not_provided: 'Not provided',
};

/** What a hidden cell shows. A hidden group is under 5 people, or hidden along with one so it cannot be worked out by subtraction. */
export const HIDDEN_LABEL = 'Hidden (small group)';

export type DemographicsRow = {
  key: string;
  label: string;
  /** The number, or the hidden marker. */
  value: string;
  suppressed: boolean;
  /** "Woman: 12" or "Woman: hidden, small group". */
  accessibilityLabel: string;
};

function rowOf(label: string, cell: DemographicsCell<string>): DemographicsRow {
  const value = cell.suppressed || cell.count === null ? HIDDEN_LABEL : String(cell.count);
  return {
    key: cell.key,
    label,
    value,
    suppressed: cell.suppressed,
    accessibilityLabel: `${label}: ${cell.suppressed ? 'hidden, small group' : value}`,
  };
}

export function ageBandRows(data: CommunityDemographics): DemographicsRow[] {
  return data.age_bands.map((cell) => rowOf(AGE_BAND_LABELS[cell.key] ?? cell.key, cell));
}

export function genderRows(data: CommunityDemographics): DemographicsRow[] {
  return data.genders.map((cell) => rowOf(GENDER_LABELS[cell.key] ?? cell.key, cell));
}

/** The sentence under the card: why some numbers are hidden. */
export function suppressionNote(minGroupSize: number): string {
  return `To protect privacy, groups of fewer than ${minGroupSize} people are hidden, and a larger group may be hidden along with them so that nobody can be worked out by subtraction. Individual answers are never shown. The numbers describe today only.`;
}

/** "Based on 14 active members. Ages are the age reached in 2026." */
export function basisLine(data: CommunityDemographics): string {
  const members = `${data.member_count} active ${data.member_count === 1 ? 'member' : 'members'}`;
  return `Based on ${members}. Age is the age reached in ${data.reference_year}.`;
}
