/**
 * Workout logs (P5): form values, validation, conversions and display helpers.
 * Pure TypeScript (no react-native). The server owns every rule (limits are in
 * docs/API_CONTRACT.md, "Workout logs (P5)"); the checks here only save a round trip.
 *
 * Workout contents and notes are health-related: nothing in this file logs them.
 */
import { z } from 'zod';

import type {
  CommunityWorkoutStats,
  MyWorkoutStats,
  WorkoutLog,
  WorkoutLogBlockReason,
  WorkoutLogInput,
  WorkoutLogScreen,
  WorkoutLogType,
} from '@/lib/database.types';
import { toAppError, userMessage } from '@/lib/errors';

export const MAX_EXERCISES = 30;
export const MAX_SETS = 20;
export const EXERCISE_NAME_MAX = 80;
export const MAX_REPS = 1000;
export const MAX_WEIGHT_KG = 1000;
export const WEIGHT_STEP_KG = 0.25;
export const MAX_DISTANCE_M = 1_000_000;
export const MAX_DURATION_S = 604_800;
export const NOTES_MAX = 1000;

// ---------------------------------------------------------------------------
// Numbers: parsing what a person types and showing what the server stored
// ---------------------------------------------------------------------------

/** A plain decimal ("12", "12.5", "12,5"); null when it is not one. */
export function parseDecimal(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(trimmed) && !/^\.\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Kilometres typed by the person -> whole metres (rounded); null when not a number. */
export function parseDistanceKm(text: string): number | null {
  const km = parseDecimal(text);
  return km === null ? null : Math.round(km * 1000);
}

/**
 * "h:mm:ss", "m:ss" or "mm:ss" -> seconds. Minutes and seconds must be 0..59 when
 * hours are given; with two parts the minutes may be larger ("90:00"). Null when invalid.
 */
export function parseDuration(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  const numbers = parts.map(Number);
  if (parts.length === 3) {
    const [h, m, s] = numbers;
    if (m > 59 || s > 59) return null;
    return h * 3600 + m * 60 + s;
  }
  const [m, s] = numbers;
  if (s > 59) return null;
  return m * 60 + s;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Seconds -> "h:mm:ss" (the form's input format). */
export function formatDurationInput(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 3600)}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)}`;
}

/** "1 h 05 min", "42 min 10 s", "35 s" for display and speech. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${pad2(m)} min`;
  if (m > 0) return s > 0 ? `${m} min ${pad2(s)} s` : `${m} min`;
  return `${s} s`;
}

/** Metres -> kilometres, exact (at most three decimals for whole metres): 10000 -> "10", 5555 -> "5.555". */
export function formatKm(metres: number): string {
  return String(metres / 1000);
}

/** Pace in seconds per km -> "5:30 /km". */
export function formatPace(secondsPerKm: number | null | undefined): string {
  if (typeof secondsPerKm !== 'number' || !Number.isFinite(secondsPerKm) || secondsPerKm <= 0) return '—';
  const total = Math.round(secondsPerKm);
  return `${Math.floor(total / 60)}:${pad2(total % 60)} /km`;
}

/** Pace of one log, as the database computes it: round(duration x 1000 / distance). */
export function computePace(distanceM: number | null, durationS: number | null): number | null {
  if (distanceM === null || durationS === null || distanceM <= 0 || durationS <= 0) return null;
  return Math.round((durationS * 1000) / distanceM);
}

/** Weight with at most two decimals: 62.5 -> "62.5", 60 -> "60". */
export function formatWeight(kg: number): string {
  return String(Number(kg.toFixed(2)));
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Code points, as Postgres counts. */
export function charCount(text: string): number {
  return Array.from(text).length;
}

/** Single-line text: controls and bidi controls removed, whitespace collapsed, trimmed. */
export function cleanLine(text: string): string {
  return text
    .replace(/[\p{Cc}​-‏‪-‮⁦-⁩؜﻿]/gu, (char) => (/\s/u.test(char) ? char : ''))
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Notes: like the server, controls and bidi controls are dropped, line breaks kept, ends trimmed. */
export function cleanNotes(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cc}​-‏‪-‮⁦-⁩؜﻿]/gu, (char) => (char === '\n' ? char : /\s/u.test(char) ? ' ' : ''))
    .trim();
}

// ---------------------------------------------------------------------------
// Form values
// ---------------------------------------------------------------------------

export type SetValues = { reps: string; weight: string };
export type ExerciseValues = { name: string; sets: SetValues[] };

export type StrengthFormValues = { exercises: ExerciseValues[]; notes: string };
export type EnduranceFormValues = { distanceKm: string; time: string; notes: string };
export type WorkoutFormValues = StrengthFormValues & EnduranceFormValues;

export const EMPTY_SET: SetValues = { reps: '', weight: '' };
export const emptyExercise = (): ExerciseValues => ({ name: '', sets: [{ ...EMPTY_SET }] });

export const EMPTY_FORM_VALUES: WorkoutFormValues = { exercises: [], notes: '', distanceKm: '', time: '' };

/** The stored log (or the event's course distance for a new race log) as form values. */
export function formValuesFrom(
  logType: WorkoutLogType,
  log: WorkoutLog | null,
  eventDistanceKm: number | null,
): WorkoutFormValues {
  if (log === null) {
    const prefill = logType === 'race' && eventDistanceKm !== null && eventDistanceKm > 0 ? String(Number(eventDistanceKm.toFixed(3))) : '';
    return { ...EMPTY_FORM_VALUES, distanceKm: prefill };
  }
  return {
    exercises: (log.exercises ?? []).map((exercise) => ({
      name: exercise.name,
      sets: exercise.sets.map((set) => ({
        reps: String(set.reps),
        weight: set.weight_kg === 0 ? '' : formatWeight(set.weight_kg),
      })),
    })),
    notes: log.notes ?? '',
    distanceKm: log.distance_m === null ? '' : formatKm(log.distance_m),
    time: log.duration_s === null ? '' : formatDurationInput(log.duration_s),
  };
}

/** Changes whenever the stored log changes: the form starts again from the server's copy. */
export function logSignature(screen: WorkoutLogScreen): string {
  return JSON.stringify([screen.session_id, screen.log?.updated_at ?? null, screen.log_type]);
}

// ---------------------------------------------------------------------------
// Validation (Zod)
// ---------------------------------------------------------------------------

type Issue = (path: (string | number)[], message: string) => void;

export function validateReps(text: string): string | null {
  const value = text.trim();
  if (value === '') return 'Enter the repetitions.';
  if (!/^\d+$/.test(value)) return 'Use a whole number.';
  const reps = Number(value);
  if (reps < 1 || reps > MAX_REPS) return `Repetitions: 1 to ${MAX_REPS}.`;
  return null;
}

/** Empty is allowed (bodyweight). */
export function validateWeight(text: string): string | null {
  const value = text.trim();
  if (value === '') return null;
  const kg = parseDecimal(value);
  if (kg === null) return 'Use a number such as 60 or 62.5.';
  if (kg > MAX_WEIGHT_KG) return `At most ${MAX_WEIGHT_KG} kg.`;
  // Exact check on the digits typed (no floating point): the fraction must be .25, .5, .75 or zero.
  const fraction = (value.replace(',', '.').split('.')[1] ?? '').replace(/0+$/, '');
  if (!['', '25', '5', '75'].includes(fraction)) return 'Use steps of 0.25 kg.';
  return null;
}

/** `required`: the field must be filled. Returns the message or null. */
export function validateDistanceKm(text: string, required: boolean): string | null {
  if (text.trim() === '') return required ? 'Enter the distance.' : null;
  const metres = parseDistanceKm(text);
  if (metres === null) return 'Use a number such as 10 or 10.5.';
  if (metres < 1 || metres > MAX_DISTANCE_M) return 'The distance must be between 0.001 and 1000 km.';
  return null;
}

export function validateTime(text: string, required: boolean): string | null {
  if (text.trim() === '') return required ? 'Enter the time.' : null;
  const seconds = parseDuration(text);
  if (seconds === null) return 'Use h:mm:ss (1:05:30) or m:ss (25:10).';
  if (seconds < 1 || seconds > MAX_DURATION_S) return 'The time must be between 1 second and 7 days.';
  return null;
}

export const MIN_PACE_S_PER_KM = 60;
export const MAX_PACE_S_PER_KM = 1800;
export const PACE_RANGE_MESSAGE =
  'That time does not fit the distance: the pace must be between 1:00 and 30:00 per km. Check both.';

/** When distance and time are both given and valid, the pace must be plausible (the server checks it too). */
export function validatePace(distanceText: string, timeText: string): string | null {
  if (distanceText.trim() === '' || timeText.trim() === '') return null;
  const pace = computePace(parseDistanceKm(distanceText), parseDuration(timeText));
  if (pace === null) return null;
  return pace < MIN_PACE_S_PER_KM || pace > MAX_PACE_S_PER_KM ? PACE_RANGE_MESSAGE : null;
}

/** Friendly text for a server `validation_failed:<field>` shown under its form field. */
export function serverFieldMessage(serverField: string | undefined, fallback: string): string {
  return serverField === 'duration_s' ? PACE_RANGE_MESSAGE : fallback;
}

/** The time as it is understood, shown while typing ("1 min 30 s" for 1:30), or null. */
export function timePreview(text: string): string | null {
  if (text.trim() === '' || validateTime(text, true)) return null;
  const seconds = parseDuration(text);
  return seconds === null ? null : formatDuration(seconds);
}

export function validateNotes(text: string): string | null {
  return charCount(cleanNotes(text)) > NOTES_MAX ? `Keep the notes to ${NOTES_MAX} characters.` : null;
}

function validateStrength(values: WorkoutFormValues, issue: Issue): void {
  if (values.exercises.length > MAX_EXERCISES) issue(['exercises'], `At most ${MAX_EXERCISES} exercises.`);
  values.exercises.forEach((exercise, i) => {
    const name = cleanLine(exercise.name);
    if (name === '') issue(['exercises', i, 'name'], 'Enter the exercise name.');
    else if (charCount(name) > EXERCISE_NAME_MAX) issue(['exercises', i, 'name'], `Keep the name to ${EXERCISE_NAME_MAX} characters.`);
    if (exercise.sets.length < 1) issue(['exercises', i, 'sets'], 'Add at least one set.');
    if (exercise.sets.length > MAX_SETS) issue(['exercises', i, 'sets'], `At most ${MAX_SETS} sets.`);
    exercise.sets.forEach((set, j) => {
      const reps = validateReps(set.reps);
      if (reps) issue(['exercises', i, 'sets', j, 'reps'], reps);
      const weight = validateWeight(set.weight);
      if (weight) issue(['exercises', i, 'sets', j, 'weight'], weight);
    });
  });
  if (values.exercises.length === 0 && cleanNotes(values.notes) === '') {
    issue(['exercises'], 'Add an exercise or write a note.');
  }
}

/** The Zod schema of the form for a log type. The type comes from the server, never from the person. */
export function createWorkoutSchema(logType: WorkoutLogType) {
  const set = z.object({ reps: z.string(), weight: z.string() });
  return z
    .object({
      exercises: z.array(z.object({ name: z.string(), sets: z.array(set) })),
      notes: z.string(),
      distanceKm: z.string(),
      time: z.string(),
    })
    .superRefine((values, ctx) => {
      const issue: Issue = (path, message) => ctx.addIssue({ code: 'custom', path, message });
      const notes = validateNotes(values.notes);
      if (notes) issue(['notes'], notes);
      if (logType === 'strength') {
        validateStrength(values, issue);
        return;
      }
      const hasDistance = values.distanceKm.trim() !== '';
      const hasTime = values.time.trim() !== '';
      const distance = validateDistanceKm(values.distanceKm, false);
      if (distance) issue(['distanceKm'], distance);
      const time =
        validateTime(values.time, logType === 'race') ?? (distance ? null : validatePace(values.distanceKm, values.time));
      if (time) issue(['time'], time);
      if (logType === 'running' && !hasDistance && !hasTime) {
        issue(['distanceKm'], 'Enter a distance, a time, or both.');
      }
    });
}

/** Distance and time of the form, as the server stores them (null when empty or not valid). */
export function enduranceNumbers(values: Pick<EnduranceFormValues, 'distanceKm' | 'time'>): {
  distanceM: number | null;
  durationS: number | null;
} {
  const distanceM = values.distanceKm.trim() === '' ? null : parseDistanceKm(values.distanceKm);
  const durationS = values.time.trim() === '' ? null : parseDuration(values.time);
  return { distanceM, durationS };
}

/** Pace shown while typing: only when both fields hold valid values. */
export function livePace(values: Pick<EnduranceFormValues, 'distanceKm' | 'time'>): string | null {
  if (validateDistanceKm(values.distanceKm, true) || validateTime(values.time, true)) return null;
  const { distanceM, durationS } = enduranceNumbers(values);
  const pace = computePace(distanceM, durationS);
  return pace === null ? null : formatPace(pace);
}

/** The request body for validated form values. Whole-log replacement: empty parts are sent as null. */
export function buildInput(logType: WorkoutLogType, values: WorkoutFormValues): WorkoutLogInput {
  const notes = cleanNotes(values.notes);
  const notesValue = notes === '' ? null : notes;
  if (logType === 'strength') {
    return {
      exercises: values.exercises.map((exercise) => ({
        name: cleanLine(exercise.name),
        sets: exercise.sets.map((set) => {
          const weight = set.weight.trim() === '' ? null : (parseDecimal(set.weight) ?? 0);
          return { reps: Number(set.reps.trim()), weight_kg: weight };
        }),
      })),
      notes: notesValue,
    };
  }
  const { distanceM, durationS } = enduranceNumbers(values);
  return { distance_m: distanceM, duration_s: durationS, notes: notesValue };
}

/** Which form field a `validation_failed:<field>` refers to (for the screen-level banner when it is not mapped). */
export function formFieldFor(serverField: string | undefined, logType: WorkoutLogType): string | null {
  switch (serverField) {
    case 'notes':
      return 'notes';
    case 'distance_m':
      return logType === 'strength' ? null : 'distanceKm';
    case 'duration_s':
      return logType === 'strength' ? null : 'time';
    case 'exercises':
    case 'exercise_name':
    case 'sets':
    case 'reps':
    case 'weight_kg':
      return logType === 'strength' ? 'exercises' : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Explanations and messages
// ---------------------------------------------------------------------------

/** Why the person cannot log this event (shown instead of the form). */
export function cannotLogMessage(reason: WorkoutLogBlockReason | null): string {
  switch (reason) {
    case 'not_a_member':
      return 'You are no longer a member of this community, so you cannot add or change a log for this event. You can still delete an existing one.';
    case 'not_loggable':
      return 'Workouts cannot be logged for this kind of event.';
    case 'event_not_ended':
      return 'This event has not ended yet. You can log your workout once it is over.';
    case 'not_eligible':
      return 'Only members who said they were going, or were marked present, can log this event.';
    case 'not_found':
      return 'This event no longer exists, so a log cannot be added or changed. You can still delete an existing one.';
    default:
      return 'You cannot log this event.';
  }
}

/** Friendly text for a failed load, save or delete. */
export function workoutLogErrorMessage(error: unknown): string {
  const appError = toAppError(error);
  return userMessage(appError.code, appError.field);
}

/** Heading of the log screen by type. */
export function logTypeLabel(logType: WorkoutLogType | null): string {
  switch (logType) {
    case 'strength':
      return 'Strength workout';
    case 'running':
      return 'Run';
    case 'race':
      return 'Race';
    default:
      return 'Workout';
  }
}

/** The consent block text, kept in one place so the privacy screen and tests can check it. */
export const WORKOUT_CONSENT_TEXT =
  'Your workout logs are private. Organizers never see individual logs. They only see rounded community totals, and only once at least 20 members have contributed. The numbers are rounded and approximate. You can delete a log at any time, and withdrawing this agreement (Profile, then Privacy) deletes all your logs for good.';

export const WORKOUT_CONSENT_LABEL = 'I agree that TrainHive stores my workout logs';

// ---------------------------------------------------------------------------
// Row summaries (My workouts)
// ---------------------------------------------------------------------------

/** One-line summary of a stored log: "10 km in 52 min 10 s (5:13 /km)", "3 exercises, 9 sets, 4200 kg lifted". */
export function logSummary(log: WorkoutLog): string {
  if (log.log_type === 'strength') {
    const exercises = log.exercises ?? [];
    if (exercises.length === 0) return 'Notes only';
    const sets = exercises.reduce((sum, exercise) => sum + exercise.sets.length, 0);
    const parts = [`${exercises.length} ${exercises.length === 1 ? 'exercise' : 'exercises'}`, `${sets} ${sets === 1 ? 'set' : 'sets'}`];
    if (log.strength_volume_kg !== null && log.strength_volume_kg > 0) parts.push(`${formatWeight(log.strength_volume_kg)} kg lifted`);
    return parts.join(', ');
  }
  const parts: string[] = [];
  if (log.distance_m !== null) parts.push(`${formatKm(log.distance_m)} km`);
  if (log.duration_s !== null) parts.push(log.distance_m !== null ? `in ${formatDuration(log.duration_s)}` : formatDuration(log.duration_s));
  const text = parts.join(' ');
  if (log.pace_s_per_km !== null) return `${text} (${formatPace(log.pace_s_per_km)})`;
  return text === '' ? 'Notes only' : text;
}

// ---------------------------------------------------------------------------
// Shape checks of server answers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const LOG_TYPES = ['strength', 'running', 'race'];
const isNumberOrNull = (value: unknown): boolean => value === null || typeof value === 'number';

export function isWorkoutLog(value: unknown): value is WorkoutLog {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.session_id === 'string' &&
    typeof value.community_id === 'string' &&
    typeof value.log_type === 'string' &&
    LOG_TYPES.includes(value.log_type) &&
    typeof value.event_title === 'string' &&
    typeof value.event_starts_at === 'string' &&
    isNumberOrNull(value.distance_m) &&
    isNumberOrNull(value.duration_s) &&
    isNumberOrNull(value.pace_s_per_km) &&
    (value.exercises === null || Array.isArray(value.exercises)) &&
    isNumberOrNull(value.strength_volume_kg) &&
    (value.notes === null || typeof value.notes === 'string') &&
    typeof value.updated_at === 'string'
  );
}

export function isWorkoutLogScreen(value: unknown): value is WorkoutLogScreen {
  return (
    isRecord(value) &&
    typeof value.session_id === 'string' &&
    typeof value.community_id === 'string' &&
    (value.event === null || (isRecord(value.event) && typeof value.event.title === 'string' && typeof value.event.starts_at === 'string')) &&
    (value.log_type === null || (typeof value.log_type === 'string' && LOG_TYPES.includes(value.log_type))) &&
    typeof value.can_log === 'boolean' &&
    typeof value.has_consent === 'boolean' &&
    (value.log === null || isWorkoutLog(value.log))
  );
}

export function isWorkoutLogPage(value: unknown): value is { logs: WorkoutLog[]; next_before: string | null } {
  return (
    isRecord(value) &&
    Array.isArray(value.logs) &&
    value.logs.every(isWorkoutLog) &&
    (value.next_before === null || typeof value.next_before === 'string')
  );
}

export function isMyWorkoutStats(value: unknown): value is MyWorkoutStats {
  return (
    isRecord(value) &&
    typeof value.sessions_logged === 'number' &&
    typeof value.total_distance_m === 'number' &&
    typeof value.total_duration_s === 'number' &&
    isNumberOrNull(value.average_pace_s_per_km) &&
    typeof value.strength_volume_kg === 'number'
  );
}

export function isCommunityWorkoutStats(value: unknown): value is CommunityWorkoutStats {
  return (
    isRecord(value) &&
    typeof value.insufficient_data === 'boolean' &&
    typeof value.min_contributors === 'number' &&
    isNumberOrNull(value.members_contributing) &&
    isNumberOrNull(value.sessions_logged) &&
    isNumberOrNull(value.total_distance_km) &&
    isNumberOrNull(value.total_duration_minutes) &&
    isNumberOrNull(value.average_pace_s_per_km)
  );
}
