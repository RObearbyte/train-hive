/**
 * P5 workout logs, app side: independent QA review. Form parsing, what the form sends, logging
 * hygiene and accessibility are checked against the code as written; the backend rules are in
 * supabase/tests/qa-workout-logs.test.ts. Nothing is mocked.
 *
 * Tests named "DEFECT P5-QA-n" are `it.fails`: they assert the SAFE behaviour, currently do not
 * hold, and pass only while the defect exists. When the owner fixes it the test turns red with
 * "expected to fail"; remove `.fails` then.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseAppLink, targetFromPushData } from '@/features/notifications/domain/deepLink';
import type { WorkoutLog } from '@/lib/database.types';

import {
  buildInput,
  cleanNotes,
  createWorkoutSchema,
  formValuesFrom,
  parseDecimal,
  parseDistanceKm,
  parseDuration,
  validateTime,
  validateWeight,
  type WorkoutFormValues,
} from './domain/workoutLog';

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const DIR = __dirname;
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
  });

function log(overrides: Partial<WorkoutLog>): WorkoutLog {
  return {
    id: 'l1',
    session_id: ID,
    community_id: 'c1',
    log_type: 'running',
    event_title: 'Run',
    event_starts_at: '2026-11-20T18:00:00Z',
    event_kind: 'training',
    event_subtype: 'running',
    distance_m: null,
    duration_s: null,
    pace_s_per_km: null,
    exercises: null,
    strength_volume_kg: null,
    notes: null,
    created_at: '2026-11-20T20:00:00Z',
    updated_at: '2026-11-20T20:00:00Z',
    ...overrides,
  } as WorkoutLog;
}

describe('QA: what a person types', () => {
  it('decimals: dot or comma, one separator only, no thousands separators or exponents', () => {
    expect(parseDecimal('10,5')).toBe(10.5);
    expect(parseDecimal(' 10.5 ')).toBe(10.5);
    expect(parseDecimal('.5')).toBe(0.5);
    for (const bad of ['', ' ', '1,000.5', '1.000,5', '1,5,5', '1e3', '-1', '+1', '1.', '--', '١٢', 'NaN', 'Infinity', '0x10', '1 000']) {
      expect(parseDecimal(bad), bad).toBeNull();
    }
    expect(parseDecimal('9'.repeat(400))).toBeNull(); // not finite
  });

  it('kilometres to whole metres', () => {
    expect(parseDistanceKm('10')).toBe(10000);
    expect(parseDistanceKm('10,5')).toBe(10500);
    expect(parseDistanceKm('0.0005')).toBe(1);
    expect(parseDistanceKm('0.0004')).toBe(0); // the form then says "between 0.001 and 1000 km"
    expect(parseDistanceKm('1.005')).toBe(1005); // 1.005 * 1000 = 1004.9999999999999 in floating point
    expect(parseDistanceKm('21.0975')).toBe(21098);
    expect(parseDistanceKm('1000')).toBe(1_000_000);
  });

  it('h:mm:ss and m:ss', () => {
    expect(parseDuration('1:05:30')).toBe(3930);
    expect(parseDuration('25:10')).toBe(1510);
    expect(parseDuration('90:00')).toBe(5400);
    expect(parseDuration('168:00:00')).toBe(604800);
    expect(parseDuration('0:00:01')).toBe(1);
    for (const bad of ['', '5', '1:60', '1:5:60', '1:60:00', '1:2:3:4', '1:-5', '1.5:00', '25:10.5', ':30', '1::30', '1234:00', 'a:b', '٣:٠٠', '1: 05:30']) {
      expect(parseDuration(bad), bad).toBeNull();
    }
    expect(validateTime('0:00:00', true)).toMatch(/between 1 second and 7 days/);
    expect(validateTime('168:00:01', true)).toMatch(/between 1 second and 7 days/);
  });

  it('"1:30" means one minute thirty (m:ss), not an hour and a half', () => {
    // The label says "h:mm:ss or m:ss" and the form shows the understood time back. Entered as a
    // finish time for 10 km it is a pace of 9 s per km, which validatePace now refuses (P5-QA-7).
    expect(parseDuration('1:30')).toBe(90);
  });

  it('what is sent to the server: only known keys, null for empty parts, notes cleaned', () => {
    const run: WorkoutFormValues = { exercises: [], notes: '  hello‮\r\nworld  ', distanceKm: '10,5', time: '52:10' };
    expect(buildInput('running', run)).toEqual({ distance_m: 10500, duration_s: 3130, notes: 'hello\nworld' });
    expect(buildInput('race', { ...run, notes: '   ', distanceKm: '' })).toEqual({ distance_m: null, duration_s: 3130, notes: null });
    const strength: WorkoutFormValues = {
      exercises: [{ name: '  Back   squat ', sets: [{ reps: '5', weight: '102,5' }, { reps: ' 08 ', weight: '' }] }],
      notes: '',
      distanceKm: '12',
      time: '1:00:00',
    };
    // A strength body never carries the endurance fields typed into a form of another type.
    expect(buildInput('strength', strength)).toEqual({
      exercises: [{ name: 'Back squat', sets: [{ reps: 5, weight_kg: 102.5 }, { reps: 8, weight_kg: null }] }],
      notes: null,
    });
    expect(Object.keys(buildInput('running', strength)).sort()).toEqual(['distance_m', 'duration_s', 'notes']);
  });

  it('the schema accepts what the server accepts at the limits and refuses what it refuses', () => {
    const schema = createWorkoutSchema('strength');
    const set = { reps: '1000', weight: '1000' };
    const values = (n: number): WorkoutFormValues => ({
      exercises: Array.from({ length: n }, () => ({ name: 'x', sets: Array.from({ length: 20 }, () => ({ ...set })) })),
      notes: '',
      distanceKm: '',
      time: '',
    });
    expect(schema.safeParse(values(30)).success).toBe(true);
    expect(schema.safeParse(values(31)).success).toBe(false);
    expect(schema.safeParse({ ...values(1), notes: 'x'.repeat(1001) }).success).toBe(false);
    expect(schema.safeParse({ ...values(0), notes: 'x'.repeat(1000) }).success).toBe(true);
    // Notes made only of invisible characters are not a note.
    expect(cleanNotes('​  ​')).toBe('');
  });

  // DEFECT P5-QA-4 (medium-low, data integrity): the edit form shows a stored distance with at most
  // two decimals (formatKm), but the form accepts three (metres). A log of 5.555 km opened and
  // saved again (to change only the note or the time) silently becomes 5.56 km (or 5.55): the
  // distance and the pace change without the person touching them.
  // Fix: prefill with the exact value: String(metres / 1000) (three decimals at most).
  it('FIXED P5-QA-4: editing a log keeps a distance of 5555 m exactly', () => {
    const values = formValuesFrom('running', log({ distance_m: 5555, duration_s: 1800 }), null);
    expect(buildInput('running', values)).toMatchObject({ distance_m: 5555 });
  });

  it('whole kilometres and half kilometres do round-trip', () => {
    for (const metres of [1000, 5250, 10000, 21098, 42195, 999999]) {
      const values = formValuesFrom('running', log({ distance_m: metres, duration_s: 600 }), null);
      // Two decimals are exact only up to 10 m steps.
      const back = buildInput('running', values) as { distance_m: number };
      expect(Math.abs(back.distance_m - metres)).toBeLessThanOrEqual(5);
    }
  });

  // DEFECT P5-QA-5 (low): validateWeight tolerates 1e-9 around a 0.25 step, so "62.50000000001"
  // passes the form and the server (exact arithmetic on numerics) answers validation_failed:weight_kg
  // with a screen-level message instead of the field hint.
  // Fix: compare with the exact decimal (parse to hundredths, or require at most two decimals).
  it('FIXED P5-QA-5: a weight that is not a 0.25 step is refused by the form', () => {
    expect(validateWeight('62.50000000001')).not.toBeNull();
  });

  it('weights in 0.25 steps, comma decimals and the limits', () => {
    for (const ok of ['', '0', '0,25', '62.5', '1000', '999.75']) expect(validateWeight(ok), ok).toBeNull();
    for (const bad of ['0.1', '1000.25', '-5', 'abc', '62.3']) expect(validateWeight(bad), bad).not.toBeNull();
  });
});

describe('QA: the app link allowlist agrees with the database check', () => {
  it('look-alikes of /events/<uuid>/log are refused', () => {
    const bad = [
      `/events/${ID}/log\n`,
      `/events/${ID}/log `,
      ` /events/${ID}/log`,
      `/events/${ID}/LOG`,
      `/events/${ID}/log/`,
      `/events/${ID}//log`,
      `//events/${ID}/log`,
      `/events/${ID}/log?x=1`,
      `/events/${ID}/log#x`,
      `/events/${ID}/%6cog`,
      `/events/${ID}/log/../x`,
      `/events/${ID.slice(1)}/log`,
      `/events/${ID}0/log`,
      `/events/${ID.replace(/./, 'g')}/log`,
      `https://evil.example/events/${ID}/log`,
      `myapp://events/${ID}/log`,
      `/event/${ID}/log`,
      `/events/${ID}/logs`,
      `\\events\\${ID}\\log`,
    ];
    for (const link of bad) expect(parseAppLink(link), JSON.stringify(link)).toBeNull();
    expect(parseAppLink(`/events/${ID}/log`)).toEqual({ kind: 'workoutLog', id: ID });
    // Push data: a bad `url` falls back to the next key; a bad notification id is dropped.
    expect(targetFromPushData({ url: `/events/${ID}/log\n`, deepLink: `/events/${ID}/log` }).href).toBe(`/events/${ID}/log`);
    expect(targetFromPushData({ url: `/events/${ID}/log/x`, notification_id: 'nope' })).toEqual({ href: null, notificationId: null });
  });
});

describe('QA: sensitive data stays out of the logger and the console', () => {
  const files = sources(DIR);

  it('no workout source writes to the console', () => {
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/console\.(log|warn|error|info|debug)/);
  });

  it('reportError only ever receives an error code or an error, never form values, notes or logs', () => {
    const calls: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/reportError\(([^()]*)\)/g)) calls.push(`${path.basename(file)}: ${match[1]}`);
    }
    expect(calls.length).toBeGreaterThan(5);
    for (const call of calls) {
      expect(call, call).toMatch(/,\s*error(\.code)?\s*$/);
      expect(call, call).not.toMatch(/values|notes|input|screen|\blog\b|exercises/);
    }
  });

  it('the shape-mismatch error keeps no part of the answer', () => {
    const text = readFileSync(path.join(DIR, 'api', 'workoutLogs.ts'), 'utf8');
    expect(text).toMatch(/message: `\$\{fn\} returned an unexpected shape`/);
    expect(text).not.toMatch(/original:\s*data/);
  });
});

describe('QA: accessibility labels of the form', () => {
  const form = readFileSync(path.join(DIR, 'components', 'WorkoutLogForm.tsx'), 'utf8');

  it('icon buttons, the pace readout and the exercise names are labelled', () => {
    expect(form).toMatch(/accessibilityLabel=\{`Remove exercise \$\{index \+ 1\}`\}/);
    expect(form).toMatch(/accessibilityLabel=\{`Remove set \$\{setIndex \+ 1\} of exercise \$\{index \+ 1\}`\}/);
    expect(form).toMatch(/accessibilityLiveRegion="polite"/);
    expect(form).toMatch(/label=\{`Exercise \$\{index \+ 1\}`\}/);
  });

  // DEFECT P5-QA-9 (low, accessibility): every weight field of every set has the same label
  // "Weight (kg)". A screen reader user moving through the sets hears the same name for each, with
  // no set or exercise number (the reps field does say "Set 2 reps", but not which exercise).
  // Fix: label={`Set ${setIndex + 1} weight (kg), exercise ${index + 1}`} (and the same exercise
  // number on the reps label).
  it('FIXED P5-QA-9: the weight and reps fields say which set of which exercise they belong to', () => {
    expect(form).not.toMatch(/label="Weight \(kg\)"/);
    expect(form).toMatch(/label=\{`[^`]*exercise \$\{index \+ 1\}[^`]*reps/i);
  });
});
