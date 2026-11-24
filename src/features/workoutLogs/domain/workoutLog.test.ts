import { describe, expect, it } from 'vitest';

import type { WorkoutLog, WorkoutLogScreen } from '@/lib/database.types';

import {
  buildInput,
  cannotLogMessage,
  cleanNotes,
  computePace,
  createWorkoutSchema,
  EMPTY_FORM_VALUES,
  formatDuration,
  formatDurationInput,
  formatKm,
  formatPace,
  formValuesFrom,
  isWorkoutLog,
  isWorkoutLogPage,
  isWorkoutLogScreen,
  livePace,
  logSummary,
  parseDistanceKm,
  parseDuration,
  validateDistanceKm,
  validateReps,
  validateTime,
  validateWeight,
  validatePace,
  serverFieldMessage,
  timePreview,
  PACE_RANGE_MESSAGE,
  type WorkoutFormValues,
} from './workoutLog';

const values = (over: Partial<WorkoutFormValues> = {}): WorkoutFormValues => ({ ...EMPTY_FORM_VALUES, ...over });
const issues = (logType: 'strength' | 'running' | 'race', v: WorkoutFormValues) => {
  const result = createWorkoutSchema(logType).safeParse(v);
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
};

function log(over: Partial<WorkoutLog> = {}): WorkoutLog {
  return {
    id: 'l1',
    session_id: 's1',
    community_id: 'c1',
    log_type: 'running',
    event_title: 'Tuesday run',
    event_starts_at: '2026-11-20T18:00:00Z',
    event_kind: 'training',
    event_subtype: 'running',
    distance_m: 10_000,
    duration_s: 3130,
    pace_s_per_km: 313,
    exercises: null,
    strength_volume_kg: null,
    notes: null,
    created_at: '2026-11-20T20:00:00Z',
    updated_at: '2026-11-20T20:00:00Z',
    ...over,
  };
}

describe('parsing and formatting', () => {
  it('parses distances to whole metres', () => {
    expect(parseDistanceKm('10')).toBe(10_000);
    expect(parseDistanceKm('10,5')).toBe(10_500);
    expect(parseDistanceKm('0.001')).toBe(1);
    expect(parseDistanceKm('abc')).toBeNull();
    expect(parseDistanceKm('-1')).toBeNull();
    expect(parseDistanceKm('1e3')).toBeNull();
  });

  it('parses h:mm:ss and m:ss', () => {
    expect(parseDuration('1:05:30')).toBe(3930);
    expect(parseDuration('25:10')).toBe(1510);
    expect(parseDuration('90:00')).toBe(5400);
    expect(parseDuration('0:00:01')).toBe(1);
    expect(parseDuration('1:60:00')).toBeNull();
    expect(parseDuration('1:00:60')).toBeNull();
    expect(parseDuration('12')).toBeNull();
    expect(parseDuration('1:2:3:4')).toBeNull();
    expect(parseDuration('a:b')).toBeNull();
  });

  it('formats time, distance and pace', () => {
    expect(formatDurationInput(3930)).toBe('1:05:30');
    expect(formatDurationInput(59)).toBe('0:00:59');
    expect(formatDuration(3930)).toBe('1 h 05 min');
    expect(formatDuration(1510)).toBe('25 min 10 s');
    expect(formatDuration(40)).toBe('40 s');
    expect(formatKm(10_000)).toBe('10');
    expect(formatKm(5250)).toBe('5.25');
    expect(formatPace(313)).toBe('5:13 /km');
    expect(formatPace(null)).toBe('—');
    expect(formatPace(0)).toBe('—');
  });

  it('computes pace like the database (round(duration x 1000 / distance))', () => {
    expect(computePace(10_000, 3130)).toBe(313);
    expect(computePace(3000, 1000)).toBe(333);
    expect(computePace(null, 1000)).toBeNull();
    expect(computePace(1000, null)).toBeNull();
    expect(computePace(0, 10)).toBeNull();
  });

  it('shows the live pace only for two valid values', () => {
    expect(livePace({ distanceKm: '10', time: '52:10' })).toBe('5:13 /km');
    expect(livePace({ distanceKm: '', time: '52:10' })).toBeNull();
    expect(livePace({ distanceKm: '10', time: '5210' })).toBeNull();
    expect(livePace({ distanceKm: '2000', time: '52:10' })).toBeNull();
  });
});

describe('field limits (same as the contract)', () => {
  it('reps are whole numbers 1..1000', () => {
    expect(validateReps('1')).toBeNull();
    expect(validateReps('1000')).toBeNull();
    expect(validateReps('0')).not.toBeNull();
    expect(validateReps('1001')).not.toBeNull();
    expect(validateReps('2.5')).not.toBeNull();
    expect(validateReps('')).not.toBeNull();
  });

  it('weight is empty (bodyweight) or 0..1000 in steps of 0.25', () => {
    expect(validateWeight('')).toBeNull();
    expect(validateWeight('0')).toBeNull();
    expect(validateWeight('62.5')).toBeNull();
    expect(validateWeight('62,25')).toBeNull();
    expect(validateWeight('1000')).toBeNull();
    expect(validateWeight('1000.25')).not.toBeNull();
    expect(validateWeight('62.3')).not.toBeNull();
    expect(validateWeight('-5')).not.toBeNull();
    expect(validateWeight('x')).not.toBeNull();
  });

  it('distance is 1 m to 1000 km and time is 1 s to 7 days', () => {
    expect(validateDistanceKm('1000', true)).toBeNull();
    expect(validateDistanceKm('1000.001', true)).not.toBeNull();
    expect(validateDistanceKm('0.0004', true)).not.toBeNull();
    expect(validateDistanceKm('', false)).toBeNull();
    expect(validateDistanceKm('', true)).not.toBeNull();
    expect(validateTime('168:00:00', true)).toBeNull();
    expect(validateTime('168:00:01', true)).not.toBeNull();
    expect(validateTime('0:00', true)).not.toBeNull();
    expect(validateTime('', false)).toBeNull();
  });

  it('notes keep line breaks, lose control and bidi characters, and are limited to 1000', () => {
    expect(cleanNotes('  a\r\nb‮\u0007c  ')).toBe('a\nbc');
    expect(issues('strength', values({ notes: 'x'.repeat(1000) }))).toEqual([]);
    expect(issues('strength', values({ notes: 'x'.repeat(1001) }))).toContain('notes');
  });
});

describe('strength form', () => {
  const set = { reps: '8', weight: '60' };
  it('needs an exercise or a note', () => {
    expect(issues('strength', values())).toEqual(['exercises']);
    expect(issues('strength', values({ notes: 'felt strong' }))).toEqual([]);
    expect(issues('strength', values({ exercises: [{ name: 'Squat', sets: [set] }] }))).toEqual([]);
  });

  it('checks the name, each set and the counts', () => {
    expect(issues('strength', values({ exercises: [{ name: ' ', sets: [set] }] }))).toContain('exercises.0.name');
    expect(issues('strength', values({ exercises: [{ name: 'x'.repeat(81), sets: [set] }] }))).toContain('exercises.0.name');
    expect(issues('strength', values({ exercises: [{ name: 'Squat', sets: [] }] }))).toContain('exercises.0.sets');
    expect(issues('strength', values({ exercises: [{ name: 'Squat', sets: Array(21).fill(set) }] }))).toContain('exercises.0.sets');
    expect(issues('strength', values({ exercises: [{ name: 'Squat', sets: [{ reps: '0', weight: '' }] }] }))).toContain('exercises.0.sets.0.reps');
    expect(issues('strength', values({ exercises: [{ name: 'Squat', sets: [{ reps: '5', weight: '61.1' }] }] }))).toContain('exercises.0.sets.0.weight');
    expect(issues('strength', values({ exercises: Array(31).fill({ name: 'Squat', sets: [set] }) }))).toContain('exercises');
  });

  it('sends bodyweight sets without a weight and cleans the name', () => {
    const input = buildInput(
      'strength',
      values({ exercises: [{ name: '  Pull   ups ', sets: [{ reps: '10', weight: '' }, { reps: '5', weight: '12,5' }] }], notes: '  ' }),
    );
    expect(input).toEqual({
      exercises: [{ name: 'Pull ups', sets: [{ reps: 10, weight_kg: null }, { reps: 5, weight_kg: 12.5 }] }],
      notes: null,
    });
  });

});

describe('running and race forms', () => {
  it('running needs a distance or a time', () => {
    expect(issues('running', values())).toEqual(['distanceKm']);
    expect(issues('running', values({ distanceKm: '5' }))).toEqual([]);
    expect(issues('running', values({ time: '25:00' }))).toEqual([]);
    expect(issues('running', values({ distanceKm: '5', time: '25' }))).toEqual(['time']);
  });

  it('race needs the finish time; the distance may stay empty', () => {
    expect(issues('race', values({ distanceKm: '21.1' }))).toEqual(['time']);
    expect(issues('race', values({ time: '1:45:00' }))).toEqual([]);
  });

  it('builds metres and seconds', () => {
    expect(buildInput('running', values({ distanceKm: '10.5', time: '52:10', notes: 'windy' }))).toEqual({
      distance_m: 10_500,
      duration_s: 3130,
      notes: 'windy',
    });
    expect(buildInput('running', values({ distanceKm: '5' }))).toEqual({ distance_m: 5000, duration_s: null, notes: null });
  });

  it('prefills a new race log with the course distance, but not a run', () => {
    expect(formValuesFrom('race', null, 21.0975).distanceKm).toBe('21.098');
    expect(formValuesFrom('race', null, null).distanceKm).toBe('');
    expect(formValuesFrom('running', null, 10).distanceKm).toBe('');
  });

  it('fills the form from a stored log', () => {
    expect(formValuesFrom('running', log({ notes: 'ok' }), null)).toMatchObject({ distanceKm: '10', time: '0:52:10', notes: 'ok' });
    const strength = log({
      log_type: 'strength',
      distance_m: null,
      duration_s: null,
      pace_s_per_km: null,
      exercises: [{ name: 'Squat', sets: [{ reps: 5, weight_kg: 100 }, { reps: 10, weight_kg: 0 }] }],
    });
    expect(formValuesFrom('strength', strength, null).exercises).toEqual([
      { name: 'Squat', sets: [{ reps: '5', weight: '100' }, { reps: '10', weight: '' }] },
    ]);
  });
});

describe('texts', () => {
  it('explains every reason the person cannot log', () => {
    const reasons = ['not_a_member', 'not_loggable', 'event_not_ended', 'not_eligible', 'not_found'] as const;
    const messages = reasons.map((reason) => cannotLogMessage(reason));
    expect(new Set(messages).size).toBe(reasons.length);
    expect(cannotLogMessage('event_not_ended')).toMatch(/not ended yet/);
    expect(cannotLogMessage('not_eligible')).toMatch(/going/);
  });

  it('summarizes logs for the list', () => {
    expect(logSummary(log())).toBe('10 km in 52 min 10 s (5:13 /km)');
    expect(logSummary(log({ duration_s: null, pace_s_per_km: null }))).toBe('10 km');
    expect(logSummary(log({ distance_m: null, pace_s_per_km: null }))).toBe('52 min 10 s');
    expect(logSummary(log({ distance_m: null, duration_s: null, pace_s_per_km: null }))).toBe('Notes only');
    expect(
      logSummary(
        log({
          log_type: 'strength',
          distance_m: null,
          duration_s: null,
          pace_s_per_km: null,
          strength_volume_kg: 4200,
          exercises: [{ name: 'Squat', sets: [{ reps: 5, weight_kg: 100 }, { reps: 5, weight_kg: 100 }] }],
        }),
      ),
    ).toBe('1 exercise, 2 sets, 4200 kg lifted');
  });
});

describe('shape checks', () => {
  const screen: WorkoutLogScreen = {
    session_id: 's1',
    community_id: 'c1',
    event: {
      title: 'Run',
      starts_at: '2026-11-20T18:00:00Z',
      ends_at: null,
      event_kind: 'training',
      event_subtype: 'running',
      distance_km: null,
      status: 'completed',
    },
    log_type: 'running',
    can_log: true,
    cannot_log_reason: null,
    has_consent: false,
    log: null,
  };

  it('accepts the contract shapes and refuses others', () => {
    expect(isWorkoutLog(log())).toBe(true);
    expect(isWorkoutLog({ ...log(), log_type: 'swim' })).toBe(false);
    expect(isWorkoutLog(null)).toBe(false);
    expect(isWorkoutLogScreen(screen)).toBe(true);
    expect(isWorkoutLogScreen({ ...screen, log: log() })).toBe(true);
    expect(isWorkoutLogScreen({ ...screen, can_log: 'yes' })).toBe(false);
    expect(isWorkoutLogPage({ logs: [log()], next_before: null })).toBe(true);
    expect(isWorkoutLogPage({ logs: [{}], next_before: null })).toBe(false);
  });
});

describe('P5 app fixes after QA', () => {
  it('formatKm is exact', () => {
    expect(formatKm(5555)).toBe('5.555');
    expect(formatKm(1)).toBe('0.001');
    expect(formatKm(999999)).toBe('999.999');
  });

  it('weights are exact multiples of 0.25', () => {
    expect(validateWeight('62.50000000001')).not.toBeNull();
    expect(validateWeight('62.250')).toBeNull();
    expect(validateWeight('62.2500001')).not.toBeNull();
  });

  it('pace must be plausible when distance and time are both given', () => {
    expect(validatePace('10', '52:10')).toBeNull();
    expect(validatePace('10', '1:30')).toBe(PACE_RANGE_MESSAGE);
    expect(validatePace('1', '31:00')).toBe(PACE_RANGE_MESSAGE);
    expect(validatePace('1', '30:00')).toBeNull();
    expect(validatePace('1', '1:00')).toBeNull();
    expect(validatePace('', '1:30')).toBeNull();
    const schema = createWorkoutSchema('running');
    const result = schema.safeParse({ exercises: [], notes: '', distanceKm: '1000', time: '0:10:00' });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues[0].path).toEqual(['time']);
  });

  it('the time is shown back and the server pace error maps to the time field', () => {
    expect(timePreview('1:30')).toBe('1 min 30 s');
    expect(timePreview('1:05:30')).toBe('1 h 05 min');
    expect(timePreview('abc')).toBeNull();
    expect(serverFieldMessage('duration_s', 'x')).toBe(PACE_RANGE_MESSAGE);
    expect(serverFieldMessage('notes', 'x')).toBe('x');
  });
});
