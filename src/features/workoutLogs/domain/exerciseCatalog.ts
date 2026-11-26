/**
 * The predefined list of strength exercises the log form offers (owner decision 2026-11-26), plus
 * "Other" for a name of one's own. Pure TypeScript (no react-native).
 *
 * The six record lifts must be saved with exactly these names (docs/API_CONTRACT.md, "Personal
 * records"): the server maps them (any case) to its lift keys. Every other name, from the list or
 * typed under "Other", stays free text (1..80 characters) and is not validated against the list.
 */
import { EXERCISE_NAME_MAX, charCount, cleanLine } from './workoutLog';

export const EXERCISE_GROUPS = ['Barbell', 'Gymnastics', 'Kettlebell & dumbbell', 'Machines & other'] as const;
export type ExerciseGroup = (typeof EXERCISE_GROUPS)[number];

export type CatalogEntry = {
  name: string;
  group: ExerciseGroup;
  /** One of the six lifts that can hold a personal record (1RM / 2RM / 3RM). */
  record: boolean;
};

/** The record lifts, spelled exactly as the server expects, in the server's display order. */
export const RECORD_LIFT_NAMES = [
  'Deadlift',
  'Bench press',
  'Back squat',
  'Front squat',
  'Strict press',
  'Push press',
] as const;

const RECORD_SET: ReadonlySet<string> = new Set(RECORD_LIFT_NAMES);

const GROUPED: Record<ExerciseGroup, readonly string[]> = {
  Barbell: [
    ...RECORD_LIFT_NAMES,
    'Overhead squat',
    'Romanian deadlift',
    'Sumo deadlift',
    'Power clean',
    'Clean',
    'Clean and jerk',
    'Snatch',
    'Power snatch',
    'Push jerk',
    'Split jerk',
    'Thruster',
    'Barbell row',
    'Hip thrust',
  ],
  Gymnastics: [
    'Pull-up',
    'Chin-up',
    'Push-up',
    'Dip',
    'Muscle-up',
    'Toes-to-bar',
    'Handstand push-up',
    'Pistol squat',
    'Burpee',
    'Box jump',
    'Air squat',
    'Sit-up',
    'Plank',
    'Rope climb',
  ],
  'Kettlebell & dumbbell': [
    'Kettlebell swing',
    'Goblet squat',
    'Turkish get-up',
    'Dumbbell snatch',
    'Dumbbell thruster',
    'Dumbbell bench press',
    'Dumbbell shoulder press',
    'Dumbbell row',
    'Lunge',
    'Walking lunge',
    'Bulgarian split squat',
    'Farmer carry',
  ],
  'Machines & other': [
    'Wall ball',
    'Leg press',
    'Lat pulldown',
    'Seated cable row',
    'Leg curl',
    'Leg extension',
    'Biceps curl',
    'Triceps extension',
    'Lateral raise',
    'Calf raise',
    'Row (machine)',
    'Bike (machine)',
    'Ski (machine)',
  ],
};

/** Every entry, group by group, in display order. */
export const EXERCISE_CATALOG: readonly CatalogEntry[] = EXERCISE_GROUPS.flatMap((group) =>
  GROUPED[group].map((name) => ({ name, group, record: RECORD_SET.has(name) })),
);

/** Comparison key: the name as the form cleans it, lower case. */
function matchKey(name: string): string {
  return cleanLine(name).toLocaleLowerCase('en');
}

const BY_KEY: ReadonlyMap<string, CatalogEntry> = new Map(EXERCISE_CATALOG.map((entry) => [matchKey(entry.name), entry]));

/** The list entry a stored or typed name stands for (case and spacing ignored), or null. */
export function findCatalogEntry(name: string | null | undefined): CatalogEntry | null {
  if (!name) return null;
  return BY_KEY.get(matchKey(name)) ?? null;
}

/** True when the name is one of the six record lifts (as the list spells them, any case). */
export function isRecordLiftName(name: string | null | undefined): boolean {
  return findCatalogEntry(name)?.record ?? false;
}

export type ExerciseChoice =
  | { kind: 'none' }
  | { kind: 'catalog'; entry: CatalogEntry }
  | { kind: 'other'; name: string };

/**
 * What the picker shows for a name. `otherChosen`: the person picked "Other" and is typing their own
 * name, so it stays "Other" even when the text happens to match a list entry.
 */
export function exerciseChoice(name: string | null | undefined, otherChosen = false): ExerciseChoice {
  const clean = cleanLine(name ?? '');
  if (otherChosen) return { kind: 'other', name: clean };
  if (clean === '') return { kind: 'none' };
  const entry = findCatalogEntry(clean);
  return entry ? { kind: 'catalog', entry } : { kind: 'other', name: clean };
}

/** Text of the picker button: "Back squat", "Other: Sled push", "Other", "Choose an exercise". */
export function choiceLabel(choice: ExerciseChoice): string {
  switch (choice.kind) {
    case 'catalog':
      return choice.entry.name;
    case 'other':
      return choice.name === '' ? 'Other' : `Other: ${choice.name}`;
    default:
      return 'Choose an exercise';
  }
}

export const RECORDS_HINT = 'Records';
export const RECORDS_HINT_SPOKEN = 'counts for personal records';

export type CatalogSection = { group: ExerciseGroup; entries: CatalogEntry[] };

/**
 * The list for the picker, filtered by a search text (every word must appear in the name, case
 * ignored); groups without a match are left out.
 */
export function searchCatalog(query: string): CatalogSection[] {
  const words = matchKey(query).split(' ').filter((word) => word !== '');
  return EXERCISE_GROUPS.map((group) => ({
    group,
    entries: EXERCISE_CATALOG.filter(
      (entry) => entry.group === group && words.every((word) => matchKey(entry.name).includes(word)),
    ),
  })).filter((section) => section.entries.length > 0);
}

/** Hint for a name of one's own ("Other"); null when it can be used. */
export function validateOtherName(name: string): string | null {
  const clean = cleanLine(name);
  if (clean === '') return 'Enter the exercise name.';
  if (charCount(clean) > EXERCISE_NAME_MAX) return `Keep the name to ${EXERCISE_NAME_MAX} characters.`;
  return null;
}
