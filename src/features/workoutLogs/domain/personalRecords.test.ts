import { describe, expect, it } from 'vitest';

import type { LiftRecord, MaxEffortCandidate, MaxEffortCandidates, PersonalRecords, RunningBest } from '@/lib/database.types';
import { AppError } from '@/lib/errors';

import {
  MAX_EFFORT_NO_CONSENT,
  applyConfirmation,
  candidateId,
  candidateRecordNote,
  candidateTitle,
  formatRecordTime,
  hasLiftRecords,
  hasRunningRecords,
  highlightLines,
  isMaxEffortCandidates,
  isMaxEffortConfirmation,
  isPersonalRecords,
  liftRows,
  maxEffortErrorMessage,
  needsMaxEffortQuestion,
  newRecordMessage,
  runningRows,
  spokenRecordTime,
} from './personalRecords';

const SESSION = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

function candidate(overrides: Partial<MaxEffortCandidate> = {}): MaxEffortCandidate {
  return {
    lift: 'back_squat',
    label: 'Back squat',
    reps: 3,
    weight_kg: 100,
    confirmed: false,
    confirmed_weight_kg: null,
    previous_best_kg: null,
    is_new_record: true,
    ...overrides,
  };
}

function candidates(list: MaxEffortCandidate[]): MaxEffortCandidates {
  return {
    session_id: SESSION,
    log_type: 'strength',
    event_title: 'Strength night',
    event_starts_at: '2026-11-20T18:00:00Z',
    has_consent: true,
    candidates: list,
  };
}

const LIFTS = [
  ['deadlift', 'Deadlift'],
  ['bench_press', 'Bench press'],
  ['back_squat', 'Back squat'],
  ['front_squat', 'Front squat'],
  ['strict_press', 'Strict press'],
  ['push_press', 'Push press'],
] as const;

function emptyRecords(): PersonalRecords {
  return {
    running: { best_5k: null, best_10k: null, best_half: null, best_marathon: null, longest: null },
    lifts: LIFTS.map(([lift, label]) => ({ lift, label, one_rm: null, two_rm: null, three_rm: null })),
  };
}

function best(overrides: Partial<RunningBest> = {}): RunningBest {
  return {
    distance_m: 5000,
    time_s: 1475,
    pace_s_per_km: 295,
    logged_distance_m: 5100,
    logged_duration_s: 1505,
    session_id: SESSION,
    event_title: 'Park run',
    event_starts_at: '2026-11-01T08:00:00Z',
    log_type: 'running',
    ...overrides,
  };
}

function liftRecord(weight: number): LiftRecord {
  return {
    weight_kg: weight,
    session_id: SESSION,
    event_title: 'Strength night',
    event_starts_at: '2026-11-20T18:00:00Z',
    achieved_at: '2026-11-20T18:00:00Z',
    confirmed_at: '2026-11-20T20:00:00Z',
  };
}

describe('the max-effort question', () => {
  it('words each candidate', () => {
    expect(candidateTitle(candidate())).toBe('Back squat, 3 reps at 100 kg');
    expect(candidateTitle(candidate({ reps: 1, weight_kg: 62.5, label: 'Strict press' }))).toBe('Strict press, 1 rep at 62.5 kg');
    expect(candidateId(candidate())).toBe('back_squat:3');
    expect(newRecordMessage(candidate({ weight_kg: 102.5 }))).toBe('New record! Back squat 3RM: 102.5 kg.');
  });

  it('compares with the previous best', () => {
    expect(candidateRecordNote(candidate())).toBe('Your first confirmed 3RM back squat would be a record.');
    expect(candidateRecordNote(candidate({ previous_best_kg: 95 }))).toMatch(/so far is 95 kg: this would be a new record/);
    expect(candidateRecordNote(candidate({ previous_best_kg: 110, is_new_record: false }))).toBe('Your best 3RM back squat is 110 kg.');
  });

  it('asks only when a candidate has no answer stored with its weight', () => {
    expect(needsMaxEffortQuestion(undefined)).toBe(false);
    expect(needsMaxEffortQuestion(candidates([]))).toBe(false);
    expect(needsMaxEffortQuestion(candidates([candidate({ confirmed: true, confirmed_weight_kg: 100 })]))).toBe(false);
    expect(needsMaxEffortQuestion(candidates([candidate()]))).toBe(true);
    // Confirmed with another weight than the heaviest set now shown: ask again.
    expect(needsMaxEffortQuestion(candidates([candidate({ confirmed: true, confirmed_weight_kg: 95 })]))).toBe(true);
  });

  it('applies the server answer to the one candidate it concerns', () => {
    const data = candidates([candidate(), candidate({ lift: 'deadlift', label: 'Deadlift', reps: 1, weight_kg: 180 })]);
    const yes = applyConfirmation(data, { lift: 'back_squat', reps: 3, weight_kg: 100, confirmed: true, is_new_record: true });
    expect(yes.candidates[0]).toMatchObject({ confirmed: true, confirmed_weight_kg: 100, is_new_record: true });
    expect(yes.candidates[1]).toEqual(data.candidates[1]);
    const no = applyConfirmation(yes, { lift: 'back_squat', reps: 3, weight_kg: 100, confirmed: false, is_new_record: false });
    expect(no.candidates[0]).toMatchObject({ confirmed: false, confirmed_weight_kg: null, is_new_record: true });
  });

  it('explains the refusals in plain words', () => {
    const consent = new AppError('consent_required', { field: 'workout_logs' });
    expect(maxEffortErrorMessage(consent)).toBe(MAX_EFFORT_NO_CONSENT);
    expect(maxEffortErrorMessage(new AppError('set_not_found'))).toMatch(/no longer in your log/);
    expect(maxEffortErrorMessage(new AppError('not_found'))).toMatch(/no longer exists/);
    expect(maxEffortErrorMessage(new AppError('validation_failed', { field: 'lift' }))).toMatch(/lift/);
    for (const text of [consent, new AppError('set_not_found')].map(maxEffortErrorMessage)) {
      expect(text).not.toMatch(/consent_required|set_not_found/);
    }
  });
});

describe('record times', () => {
  it('clock style with seconds, hours only when needed', () => {
    expect(formatRecordTime(1475)).toBe('24:35');
    expect(formatRecordTime(59)).toBe('0:59');
    expect(formatRecordTime(3600)).toBe('1:00:00');
    expect(formatRecordTime(12310)).toBe('3:25:10');
    expect(spokenRecordTime(12310)).toBe('3 hours 25 minutes 10 seconds');
    expect(spokenRecordTime(61)).toBe('1 minute 1 second');
    expect(spokenRecordTime(0)).toBe('0 seconds');
  });
});

describe('the Personal bests page', () => {
  it('shows a dash for every missing record and nothing counts as a record', () => {
    const records = emptyRecords();
    expect(hasRunningRecords(records.running)).toBe(false);
    expect(hasLiftRecords(records)).toBe(false);
    const rows = runningRows(records.running);
    expect(rows.map((row) => row.label)).toEqual(['5 km', '10 km', 'Half marathon', 'Marathon', 'Longest distance']);
    expect(rows.every((row) => row.value === '—' && row.record === null)).toBe(true);
    const lifts = liftRows(records, () => 'x');
    expect(lifts.map((row) => row.label)).toEqual(LIFTS.map(([, label]) => label));
    expect(lifts[0].cells.map((cell) => `${cell.label} ${cell.value}`)).toEqual(['1RM —', '2RM —', '3RM —']);
    expect(highlightLines(records)).toEqual([]);
  });

  it('formats running bests and the longest run', () => {
    const records = emptyRecords();
    records.running.best_5k = best();
    records.running.longest = {
      distance_m: 42400,
      duration_s: 12600,
      pace_s_per_km: 297,
      session_id: SESSION,
      event_title: 'Marathon',
      event_starts_at: '2026-10-01T07:00:00Z',
      log_type: 'race',
    };
    const rows = runningRows(records.running);
    expect(rows[0]).toMatchObject({ value: '24:35', detail: '4:55 /km' });
    expect(rows[0].spoken).toBe('5 km: 24 minutes 35 seconds, pace 4:55 per kilometre');
    expect(rows[4]).toMatchObject({ value: '42.4 km', detail: '3:30:00, 4:57 /km' });
    expect(hasRunningRecords(records.running)).toBe(true);
    records.running.longest = { ...records.running.longest, duration_s: null, pace_s_per_km: null };
    expect(runningRows(records.running)[4]).toMatchObject({ value: '42.4 km', detail: null });
  });

  it('lists 1RM, 2RM and 3RM per lift with dates for the screen reader', () => {
    const records = emptyRecords();
    records.lifts[2] = { ...records.lifts[2], one_rm: liftRecord(120), three_rm: liftRecord(102.5) };
    const rows = liftRows(records, () => '20 Nov');
    expect(rows[2].cells.map((cell) => cell.value)).toEqual(['120 kg', '—', '102.5 kg']);
    expect(rows[2].spoken).toBe('Back squat: 1RM 120 kg, 20 Nov; 2RM none; 3RM 102.5 kg, 20 Nov');
    expect(hasLiftRecords(records)).toBe(true);
    expect(highlightLines(records)).toEqual([{ key: 'back_squat', label: 'Back squat 1RM', value: '120 kg' }]);
  });

  it('the card keeps at most a few lines, running first', () => {
    const records = emptyRecords();
    records.running.best_5k = best();
    records.running.best_10k = best({ distance_m: 10000, time_s: 3000 });
    records.lifts = records.lifts.map((lift) => ({ ...lift, two_rm: liftRecord(80) }));
    const lines = highlightLines(records, 4);
    expect(lines.map((line) => line.label)).toEqual(['5 km', '10 km', 'Deadlift 2RM', 'Bench press 2RM']);
  });
});

describe('shape checks', () => {
  it('accepts the documented shapes and refuses others', () => {
    expect(isMaxEffortCandidates(candidates([candidate()]))).toBe(true);
    expect(isMaxEffortCandidates({ ...candidates([]), candidates: [{ ...candidate(), reps: 4 }] })).toBe(false);
    expect(isMaxEffortCandidates(null)).toBe(false);
    expect(isMaxEffortConfirmation({ lift: 'deadlift', reps: 1, weight_kg: 180, confirmed: true, is_new_record: false })).toBe(true);
    expect(isMaxEffortConfirmation({ lift: 'deadlift', reps: 1 })).toBe(false);
    const records = emptyRecords();
    records.running.best_half = best({ distance_m: 21097.5 });
    records.lifts[0] = { ...records.lifts[0], one_rm: liftRecord(180) };
    expect(isPersonalRecords(records)).toBe(true);
    expect(isPersonalRecords({ running: records.running })).toBe(false);
    expect(isPersonalRecords({ ...records, lifts: [{ lift: 'deadlift', label: 'Deadlift', one_rm: { weight_kg: '1' } }] })).toBe(false);
  });
});
