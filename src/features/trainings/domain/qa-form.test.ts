/**
 * QA (M1-Q1 part 2): the create / edit training form logic, hunted for
 * timezone, rounding, number-parsing and server-rule mismatches. Pure logic,
 * real date arithmetic, no mocks. Defects are `it.fails` tagged `DEFECT Q2-n`.
 */
import { describe, expect, it } from 'vitest';

import { frozenFormFields, serverFieldError } from '@/features/trainings/domain/formState';
import {
  emptyTrainingForm,
  fromSession,
  toTrainingInput,
  trainingFormSchema,
  type TrainingFormValues,
} from '@/features/trainings/domain/schema';
import type { TrainingSession } from '@/lib/database.types';

const ZONE = 'Europe/Bucharest';
const NOW = new Date('2026-11-10T10:00:00Z');

function validForm(overrides: Partial<TrainingFormValues> = {}): TrainingFormValues {
  return {
    ...emptyTrainingForm(),
    title: 'Saturday long run',
    date: '2026-11-14',
    startTime: '09:00',
    locationName: 'Herastrau Park',
    minParticipants: '10',
    ...overrides,
  };
}

function issues(values: TrainingFormValues, now: Date = NOW, zone: string = ZONE) {
  const result = trainingFormSchema({ mode: 'create', timezone: zone, now }).safeParse(values);
  return result.success ? [] : result.error.issues.map((issue) => `${String(issue.path[0])}: ${issue.message}`);
}

describe('text length is counted the way Postgres counts it (char_length = code points)', () => {
  // DEFECT Q2-8: the form uses String.length (UTF-16 units). `training_sessions` checks
  // char_length(title) <= 80 and char_length(location_name) <= 120, so 41 emoji (41 characters,
  // 82 UTF-16 units) are valid on the server but rejected by the form. Display names are already
  // counted in code points (displayName.ts), so this is inconsistent inside the app.
  it.fails('accepts a title of 41 emoji (DEFECT Q2-8)', () => {
    expect(issues(validForm({ title: '🏃'.repeat(41) }))).toEqual([]);
  });

  it.fails('accepts a location of 61 emoji (DEFECT Q2-8)', () => {
    expect(issues(validForm({ locationName: '🏃'.repeat(61) }))).toEqual([]);
  });

  it('still rejects 81 plain characters and accepts exactly 80', () => {
    expect(issues(validForm({ title: 'a'.repeat(80) }))).toEqual([]);
    expect(issues(validForm({ title: 'a'.repeat(81) })).join()).toMatch(/title/);
  });
});

describe('number parsing', () => {
  it.each(['1e3', '4.0', '4,5', '٣', ' ', '-1', '0', '+4', '1 000', '０４'])(
    'rejects %j as a minimum',
    (text) => {
      expect(issues(validForm({ minParticipants: text })).join('\n')).toMatch(/minParticipants/);
    },
  );

  it.each([
    ['4', 4],
    [' 12 ', 12],
    ['007', 7],
    ['999999999', 999999999],
  ])('accepts %j as a minimum and sends %i', (text, expected) => {
    const values = validForm({ minParticipants: text });
    expect(issues(values)).toEqual([]);
    expect(toTrainingInput(values, ZONE).min_participants).toBe(expected);
  });

  it('refuses a ten-digit number instead of overflowing the integer column', () => {
    expect(issues(validForm({ minParticipants: '2147483648' })).join()).toMatch(/minParticipants/);
  });

  it('maximum below minimum is rejected, equal is accepted, empty means no limit', () => {
    expect(issues(validForm({ maxParticipants: '9' })).join()).toMatch(/maxParticipants/);
    expect(issues(validForm({ maxParticipants: '10' }))).toEqual([]);
    expect(toTrainingInput(validForm({ maxParticipants: '' }), ZONE).max_participants).toBeNull();
  });

  it('accepts a decimal comma in coordinates and sends a number', () => {
    const values = validForm({ latitude: '44,4268', longitude: '26,1025' });
    expect(issues(values)).toEqual([]);
    const input = toTrainingInput(values, ZONE);
    expect(input.latitude).toBe(44.4268);
    expect(input.longitude).toBe(26.1025);
  });

  it.each(['91', '-90.0001', 'NaN', '1e1', '12.', '.5', '--1', '44.4.2'])('rejects latitude %j', (latitude) => {
    expect(issues(validForm({ latitude, longitude: '26' })).join()).toMatch(/latitude/);
  });

  it('requires both coordinates or neither', () => {
    expect(issues(validForm({ latitude: '44' })).join()).toMatch(/longitude/);
    expect(issues(validForm({ longitude: '26' })).join()).toMatch(/latitude/);
  });
});

describe('the RSVP deadline', () => {
  it('defaults to exactly 2 hours before the start, in absolute time, on a DST change day', () => {
    // Spring forward in Bucharest: 29 March 2026, 03:00 -> 04:00. Start 05:00 local (02:00 UTC).
    const values = validForm({ date: '2026-03-29', startTime: '05:00' });
    const input = toTrainingInput(values, ZONE);
    expect(input.starts_at).toBe('2026-03-29T02:00:00.000Z');
    expect(input.rsvp_deadline).toBe('2026-03-29T00:00:00.000Z');
  });

  it('a start less than 2 hours away asks for an explicit deadline (O3 of part 1)', () => {
    const soon = new Date('2026-11-14T06:00:00Z'); // 08:00 Bucharest
    expect(issues(validForm({ startTime: '09:30' }), soon).join()).toMatch(/deadlineDate: The training starts in less than 2 hours/);
  });

  it('a deadline equal to the start is rejected (server rule is strict <)', () => {
    const values = validForm({ deadlineDate: '2026-11-14', deadlineTime: '09:00' });
    expect(issues(values).join()).toMatch(/must be before the start/);
  });

  it('one minute before the start is accepted', () => {
    expect(issues(validForm({ deadlineDate: '2026-11-14', deadlineTime: '08:59' }))).toEqual([]);
  });

  it('half a deadline (date without time, time without date) is rejected', () => {
    expect(issues(validForm({ deadlineDate: '2026-11-14' })).join()).toMatch(/deadlineTime/);
    expect(issues(validForm({ deadlineTime: '07:00' })).join()).toMatch(/deadlineDate/);
  });
});

describe('editing: untouched timestamps are sent back exactly (no accidental change, no lost lock)', () => {
  function stored(startsAt: string, zone: string): TrainingSession {
    const start = new Date(startsAt).getTime();
    return {
      id: 's',
      community_id: 'c',
      organizer_id: 'o',
      title: 'Run',
      description: null,
      activity_type: 'running',
      starts_at: new Date(start).toISOString(),
      // Seconds and milliseconds on purpose: the picker only has minutes.
      ends_at: new Date(start + 90 * 60_000 + 17_123).toISOString(),
      rsvp_deadline: new Date(start - 2 * 3_600_000 + 31_999).toISOString(),
      timezone: zone,
      location_name: 'Park',
      address: null,
      latitude: null,
      longitude: null,
      map_url: null,
      meeting_instructions: null,
      min_participants: 4,
      max_participants: null,
      going_count: 0,
      status: 'scheduled',
      cancel_reason: null,
      decided_at: null,
      cancelled_at: null,
      cancelled_by: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
  }

  const cases: [string, string, string, string][] = [
    // zone, from, to: windows around real transitions in 2026, including repeated hours.
    ['Europe/Bucharest', '2026-03-28T20:00:00Z', '2026-03-29T08:00:00Z', 'spring forward'],
    ['Europe/Bucharest', '2026-10-24T20:00:00Z', '2026-10-25T10:00:00Z', 'fall back (repeated hour)'],
    ['America/New_York', '2026-11-01T03:00:00Z', '2026-11-01T09:00:00Z', 'US fall back'],
    ['Australia/Lord_Howe', '2026-04-04T12:00:00Z', '2026-04-04T20:00:00Z', '30-minute DST change'],
    ['Asia/Kolkata', '2026-06-01T00:00:00Z', '2026-06-01T06:00:00Z', 'half-hour offset'],
  ];

  it.each(cases)('%s %s..%s (%s): every 15 minutes', (zone, from, to) => {
    const problems: string[] = [];
    for (let t = new Date(from).getTime(); t <= new Date(to).getTime(); t += 15 * 60_000) {
      const session = stored(new Date(t).toISOString(), zone);
      const input = toTrainingInput(fromSession(session), zone, session);
      const same = (a: string | null | undefined, b: string | null) =>
        a !== undefined && a !== null && b !== null && new Date(a).getTime() === new Date(b).getTime();
      // starts_at and rsvp_deadline are always sent back untouched; ends_at only when it falls on
      // the start's wall-clock day (the form keeps the end on the start's day).
      if (!same(input.starts_at, session.starts_at)) problems.push(`starts_at @ ${session.starts_at}`);
      if (!same(input.rsvp_deadline, session.rsvp_deadline)) problems.push(`deadline @ ${session.starts_at}`);
    }
    expect(problems).toEqual([]);
  });

  it('a session whose start and deadline already passed can be saved untouched, and its start moved', () => {
    const session = { ...stored('2026-11-09T12:00:00Z', ZONE), min_participants: 4 };
    const edit = { mode: 'edit', timezone: ZONE, now: NOW, session } as const;
    const values = fromSession(session);
    expect(trainingFormSchema(edit).safeParse(values).success).toBe(true); // nothing changed: server only checks changed timestamps
    const moved = { ...values, date: '2026-11-20', startTime: '10:00' };
    // The deadline field was left alone: before the new start, in the past, but unchanged
    expect(trainingFormSchema(edit).safeParse(moved).success).toBe(true);
  });

  it('frozenFormFields locks deadline and limits once the deadline passed, using the device clock (advisory)', () => {
    const session = stored('2026-11-14T07:00:00Z', ZONE);
    const before = frozenFormFields(session, new Date('2026-11-14T04:59:59Z'));
    const after = frozenFormFields(session, new Date('2026-11-14T05:01:00Z'));
    expect(before.fields.size).toBe(0);
    expect(after.fields.has('minParticipants')).toBe(true);
    expect(after.fields.has('title')).toBe(false);
  });
});

describe('server errors land on the right field', () => {
  it.each([
    ['starts_at', 'date'],
    ['ends_at', 'endTime'],
    ['rsvp_deadline', 'deadlineDate'],
    ['min_participants', 'minParticipants'],
    ['max_participants', 'maxParticipants'],
    ['activity_type', 'activityType'],
    ['location_name', 'locationName'],
  ])('validation_failed:%s shows on %s', (column, field) => {
    const placed = serverFieldError({ code: 'validation_failed', field: column });
    expect(placed?.field).toBe(field);
    expect(placed?.message.length).toBeGreaterThan(10);
    expect(placed?.message).not.toMatch(/validation_failed|_/);
  });

  it('timezone has no field: it is a banner, with human text', () => {
    expect(serverFieldError({ code: 'validation_failed', field: 'timezone' })).toBeNull();
  });
});
