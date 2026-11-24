import { describe, expect, it } from 'vitest';

import {
  exerciseTitle,
  newExercise,
  parseSetCount,
  setCountText,
  setFieldLabel,
  toggleOpen,
  validateNewExercise,
} from './strengthEditor';
import { buildInput, createWorkoutSchema, formValuesFrom, type WorkoutFormValues } from './workoutLog';

describe('parseSetCount', () => {
  it('accepts 1..20 only', () => {
    expect(parseSetCount('3')).toBe(3);
    expect(parseSetCount(' 20 ')).toBe(20);
    for (const bad of ['', '0', '21', '2.5', '-1', 'abc', '1e1']) expect(parseSetCount(bad)).toBeNull();
  });
});

describe('validateNewExercise', () => {
  it('needs a name and 1..20 sets', () => {
    expect(validateNewExercise('Squat', '3', 0)).toEqual({});
    expect(Object.keys(validateNewExercise('  ', '3', 0))).toEqual(['name']);
    expect(Object.keys(validateNewExercise('Squat', '0', 0))).toEqual(['sets']);
    expect(Object.keys(validateNewExercise('x'.repeat(81), '3', 0))).toEqual(['name']);
  });
  it('stops at 30 exercises', () => {
    expect(validateNewExercise('Squat', '3', 29)).toEqual({});
    expect(Object.keys(validateNewExercise('Squat', '3', 30))).toEqual(['limit']);
  });
});

describe('newExercise', () => {
  it('creates n independent empty sets', () => {
    const exercise = newExercise('  Bench   press ', 3);
    expect(exercise.name).toBe('Bench press');
    expect(exercise.sets).toEqual([
      { reps: '', weight: '' },
      { reps: '', weight: '' },
      { reps: '', weight: '' },
    ]);
    exercise.sets[0].reps = '5';
    expect(exercise.sets[1].reps).toBe('');
  });
  it('clamps the set count', () => {
    expect(newExercise('a', 0).sets).toHaveLength(1);
    expect(newExercise('a', 99).sets).toHaveLength(20);
  });
});

describe('header text', () => {
  it('follows the name and falls back when empty', () => {
    expect(exerciseTitle('Row')).toBe('Row');
    expect(exerciseTitle('  ')).toBe('Unnamed exercise');
    expect(exerciseTitle(undefined)).toBe('Unnamed exercise');
    expect(setCountText(1)).toBe('1 set');
    expect(setCountText(3)).toBe('3 sets');
  });
  it('labels set fields with the name when there is one', () => {
    expect(setFieldLabel(0, 'Bench press', 1)).toBe('Exercise 1 Bench press, set 2');
    expect(setFieldLabel(1, '', 0)).toBe('Exercise 2, set 1');
  });
});

describe('open rows', () => {
  it('toggles without mutating', () => {
    const open = new Set(['a']);
    const next = toggleOpen(open, 'b');
    expect([...open]).toEqual(['a']);
    expect([...next].sort()).toEqual(['a', 'b']);
    expect([...toggleOpen(next, 'a')]).toEqual(['b']);
  });
});

describe('payload and validation are unchanged by the new editor', () => {
  it('fresh empty sets fail validation until reps are filled, then build the same payload shape', () => {
    const schema = createWorkoutSchema('strength');
    const values: WorkoutFormValues = { exercises: [newExercise('Squat', 2)], notes: '', distanceKm: '', time: '' };
    expect(schema.safeParse(values).success).toBe(false);
    values.exercises[0].sets[0].reps = '5';
    values.exercises[0].sets[0].weight = '100';
    values.exercises[0].sets[1].reps = '8';
    expect(schema.safeParse(values).success).toBe(true);
    expect(buildInput('strength', values)).toEqual({
      exercises: [{ name: 'Squat', sets: [{ reps: 5, weight_kg: 100 }, { reps: 8, weight_kg: null }] }],
      notes: null,
    });
  });
  it('a new log starts with no exercises', () => {
    expect(formValuesFrom('strength', null, null).exercises).toEqual([]);
  });
});
