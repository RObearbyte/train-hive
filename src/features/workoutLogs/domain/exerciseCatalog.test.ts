import { describe, expect, it } from 'vitest';

import {
  EXERCISE_CATALOG,
  EXERCISE_GROUPS,
  RECORD_LIFT_NAMES,
  choiceLabel,
  exerciseChoice,
  findCatalogEntry,
  isRecordLiftName,
  searchCatalog,
  validateOtherName,
} from './exerciseCatalog';
import { EXERCISE_NAME_MAX, charCount, cleanLine } from './workoutLog';

describe('exercise catalog', () => {
  it('holds the six record lifts spelled exactly as the server maps them, in its display order', () => {
    expect(RECORD_LIFT_NAMES).toEqual(['Deadlift', 'Bench press', 'Back squat', 'Front squat', 'Strict press', 'Push press']);
    const records = EXERCISE_CATALOG.filter((entry) => entry.record).map((entry) => entry.name);
    expect(records).toEqual([...RECORD_LIFT_NAMES]);
    for (const name of RECORD_LIFT_NAMES) expect(findCatalogEntry(name)?.group).toBe('Barbell');
  });

  it('includes the common exercises the owner listed', () => {
    const names = new Set(EXERCISE_CATALOG.map((entry) => entry.name));
    for (const name of [
      'Power clean', 'Clean and jerk', 'Snatch', 'Thruster', 'Romanian deadlift', 'Overhead squat', 'Pull-up', 'Chin-up',
      'Push-up', 'Dip', 'Muscle-up', 'Toes-to-bar', 'Kettlebell swing', 'Goblet squat', 'Lunge', 'Walking lunge',
      'Bulgarian split squat', 'Dumbbell row', 'Barbell row', 'Hip thrust', 'Box jump', 'Wall ball', 'Burpee', 'Plank',
      'Sit-up', 'Leg press', 'Lat pulldown', 'Biceps curl', 'Triceps extension', 'Calf raise',
    ]) {
      expect(names.has(name), name).toBe(true);
    }
    expect(EXERCISE_CATALOG.length).toBeGreaterThanOrEqual(36);
  });

  it('every name is unique (case ignored), already clean and within the server limit; every group is used', () => {
    const keys = EXERCISE_CATALOG.map((entry) => entry.name.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
    for (const { name } of EXERCISE_CATALOG) {
      expect(cleanLine(name)).toBe(name);
      expect(charCount(name)).toBeLessThanOrEqual(EXERCISE_NAME_MAX);
    }
    for (const group of EXERCISE_GROUPS) expect(EXERCISE_CATALOG.some((entry) => entry.group === group), group).toBe(true);
  });

  it('matches stored free-text names case-insensitively and ignoring extra spaces', () => {
    expect(findCatalogEntry('back squat')?.name).toBe('Back squat');
    expect(findCatalogEntry('  BENCH   press ')?.name).toBe('Bench press');
    expect(findCatalogEntry('pull-up')?.name).toBe('Pull-up');
    expect(findCatalogEntry('Squat')).toBeNull();
    expect(findCatalogEntry('Back squats')).toBeNull();
    expect(findCatalogEntry('')).toBeNull();
    expect(findCatalogEntry(null)).toBeNull();
    expect(isRecordLiftName('deadlift')).toBe(true);
    expect(isRecordLiftName('Romanian deadlift')).toBe(false);
    expect(isRecordLiftName('dl')).toBe(false); // a server synonym, but not a list entry
  });
});

describe('what the picker shows', () => {
  it('a list name is selected, anything else is "Other: <name>", empty asks to choose', () => {
    expect(choiceLabel(exerciseChoice('front SQUAT'))).toBe('Front squat');
    expect(exerciseChoice('front SQUAT')).toMatchObject({ kind: 'catalog', entry: { name: 'Front squat', record: true } });
    expect(choiceLabel(exerciseChoice('Sled push'))).toBe('Other: Sled push');
    expect(choiceLabel(exerciseChoice('   '))).toBe('Choose an exercise');
    expect(choiceLabel(exerciseChoice(undefined))).toBe('Choose an exercise');
  });

  it('stays "Other" while the person types their own name, even when it matches a list entry', () => {
    expect(exerciseChoice('', true)).toEqual({ kind: 'other', name: '' });
    expect(choiceLabel(exerciseChoice('', true))).toBe('Other');
    expect(exerciseChoice('Deadlift', true)).toEqual({ kind: 'other', name: 'Deadlift' });
  });
});

describe('search', () => {
  it('without a query lists every group in order with all entries', () => {
    const sections = searchCatalog('');
    expect(sections.map((section) => section.group)).toEqual([...EXERCISE_GROUPS]);
    expect(sections.flatMap((section) => section.entries)).toHaveLength(EXERCISE_CATALOG.length);
  });

  it('finds names containing every word, case ignored, and drops empty groups', () => {
    const names = (query: string) => searchCatalog(query).flatMap((section) => section.entries.map((entry) => entry.name));
    expect(names('SQUAT')).toEqual(expect.arrayContaining(['Back squat', 'Front squat', 'Overhead squat', 'Goblet squat']));
    expect(names('press push')).toEqual(['Push press']);
    expect(names('dead')).toEqual(['Deadlift', 'Romanian deadlift', 'Sumo deadlift']);
    expect(searchCatalog('swing').map((section) => section.group)).toEqual(['Kettlebell & dumbbell']);
    expect(searchCatalog('zzz')).toEqual([]);
  });
});

describe('a name of one\'s own ("Other")', () => {
  it('needs 1 to 80 characters after cleaning, as the server', () => {
    expect(validateOtherName('Sled push')).toBeNull();
    expect(validateOtherName('   ')).toMatch(/Enter the exercise name/);
    expect(validateOtherName('x'.repeat(EXERCISE_NAME_MAX))).toBeNull();
    expect(validateOtherName('x'.repeat(EXERCISE_NAME_MAX + 1))).toMatch(/80 characters/);
  });
});
