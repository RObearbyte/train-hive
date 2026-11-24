/**
 * Pure helpers of the strength editor (add an exercise with a number of sets, collapsible rows).
 * No react-native. The form state itself is the form values of `workoutLog.ts`.
 */
import {
  EMPTY_SET,
  EXERCISE_NAME_MAX,
  MAX_EXERCISES,
  MAX_SETS,
  charCount,
  cleanLine,
  type ExerciseValues,
} from './workoutLog';

export const DEFAULT_SET_COUNT = 3;
export const UNNAMED_EXERCISE = 'Unnamed exercise';

/** Sets typed in the top row -> a whole number 1..MAX_SETS, or null when it is not one. */
export function parseSetCount(text: string): number | null {
  const value = text.trim();
  if (!/^\d+$/.test(value)) return null;
  const count = Number(value);
  return count >= 1 && count <= MAX_SETS ? count : null;
}

export type NewExerciseProblems = { name?: string; sets?: string; limit?: string };

/** Hints for the top row; an empty object means the exercise can be added. */
export function validateNewExercise(name: string, setsText: string, exerciseCount: number): NewExerciseProblems {
  const problems: NewExerciseProblems = {};
  const clean = cleanLine(name);
  if (clean === '') problems.name = 'Enter the exercise name.';
  else if (charCount(clean) > EXERCISE_NAME_MAX) problems.name = `Keep the name to ${EXERCISE_NAME_MAX} characters.`;
  if (parseSetCount(setsText) === null) problems.sets = `Sets: a whole number from 1 to ${MAX_SETS}.`;
  if (exerciseCount >= MAX_EXERCISES) problems.limit = `At most ${MAX_EXERCISES} exercises.`;
  return problems;
}

/** An exercise with `setCount` empty sets (clamped to 1..MAX_SETS). */
export function newExercise(name: string, setCount: number): ExerciseValues {
  const count = Math.min(MAX_SETS, Math.max(1, Math.floor(setCount)));
  return { name: cleanLine(name), sets: Array.from({ length: count }, () => ({ ...EMPTY_SET })) };
}

/** Header title: the name as typed right now, "Unnamed exercise" when empty. */
export function exerciseTitle(name: string | undefined): string {
  const clean = cleanLine(name ?? '');
  return clean === '' ? UNNAMED_EXERCISE : clean;
}

/** "1 set", "3 sets". */
export function setCountText(count: number): string {
  return `${count} ${count === 1 ? 'set' : 'sets'}`;
}

/** Accessibility prefix of a set field: "Exercise 1 Bench press, set 2" (just "Exercise 1, set 2" when unnamed). */
export function setFieldLabel(exerciseIndex: number, name: string | undefined, setIndex: number): string {
  const clean = cleanLine(name ?? '');
  const exercise = clean === '' ? `Exercise ${exerciseIndex + 1}` : `Exercise ${exerciseIndex + 1} ${clean}`;
  return `${exercise}, set ${setIndex + 1}`;
}

/** Open / closed state of the rows, keyed by a stable row id. */
export function toggleOpen(open: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(open);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** True when the person typed anything into the sets (asks before the exercise is removed). */
export function exerciseHasEntries(exercise: ExerciseValues): boolean {
  return exercise.sets.some((set) => set.reps.trim() !== '' || set.weight.trim() !== '');
}
