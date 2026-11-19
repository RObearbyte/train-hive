/**
 * P1: the create / edit form per kind: validation, the exact `p_input`, which fields are
 * shown, which are frozen, and where server errors land.
 */
import { describe, expect, it } from 'vitest';

import type { EventKind, TrainingSession } from '@/lib/database.types';

import { defaultSubtype } from './events';
import {
  formFieldForColumn,
  frozenFormFields,
  serverFieldError,
  visibleFormFields,
} from './formState';
import {
  TRAINING_FORM_FIELDS,
  editableFields,
  emptyTrainingForm,
  fromSession,
  toTrainingInput,
  trainingFormSchema,
  type EditedSession,
  type TrainingFormContext,
  type TrainingFormValues,
} from './schema';

const ZONE = 'Europe/Bucharest';
// Tuesday 10 November 2026, 12:00 in Bucharest.
const NOW = new Date('2026-11-10T10:00:00Z');

function form(
  kind: EventKind,
  subtype: string = defaultSubtype(kind),
  overrides: Partial<TrainingFormValues> = {},
): TrainingFormValues {
  return {
    ...emptyTrainingForm(kind, subtype),
    title: 'Hill race',
    date: '2026-11-14',
    startTime: '09:00',
    locationName: 'Herastrau Park',
    ...(kind === 'training' ? { minParticipants: '6' } : {}),
    ...overrides,
  };
}

function errorsOf(values: TrainingFormValues, context?: TrainingFormContext): Record<string, string[]> {
  const result = trainingFormSchema(context ?? { mode: 'create', timezone: ZONE, now: NOW }).safeParse(values);
  const out: Record<string, string[]> = {};
  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = String(issue.path[0]);
      (out[key] ??= []).push(issue.message);
    }
  }
  return out;
}

describe('create: every kind validates with its own required fields', () => {
  it('a race needs no minimum', () => {
    expect(errorsOf(form('race', 'trail_running'))).toEqual({});
  });

  it('a social event and a sports event need no minimum either', () => {
    expect(errorsOf(form('social'))).toEqual({});
    expect(errorsOf(form('sports_event'))).toEqual({});
  });

  it('a training still requires a minimum of at least 1', () => {
    expect(errorsOf(form('training', 'running', { minParticipants: '' })).minParticipants).toEqual([
      'Enter the minimum number of participants.',
    ]);
    expect(errorsOf(form('training', 'running', { minParticipants: '0' })).minParticipants).toEqual([
      'The minimum must be at least 1.',
    ]);
  });

  it('a stale minimum typed before is ignored (and not sent) for a non-training event', () => {
    const values = form('race', 'ocr', { minParticipants: 'abc' });
    expect(errorsOf(values)).toEqual({});
    expect(toTrainingInput(values, ZONE).min_participants).toBeNull();
  });

  it('rejects an unknown kind and a missing subtype', () => {
    expect(errorsOf(form('race', 'ocr', { eventKind: 'party' })).eventKind).toBeDefined();
    expect(errorsOf(form('race', 'ocr', { eventSubtype: '' })).eventSubtype).toEqual(['Choose a type.']);
  });

  it('the maximum is optional for every kind, and at least 1 when set', () => {
    expect(errorsOf(form('race', 'ocr', { maxParticipants: '' }))).toEqual({});
    expect(errorsOf(form('social', 'other', { maxParticipants: '40' }))).toEqual({});
    expect(errorsOf(form('social', 'other', { maxParticipants: '0' })).maxParticipants).toEqual([
      'The maximum must be at least 1.',
    ]);
    expect(errorsOf(form('training', 'running', { minParticipants: '6', maxParticipants: '5' })).maxParticipants).toEqual([
      'The maximum cannot be lower than the minimum.',
    ]);
  });

  it('says "event" for a non-training event and keeps "training" for a training', () => {
    expect(errorsOf(form('race', 'ocr', { locationName: '' })).locationName).toEqual([
      'Enter where the event takes place.',
    ]);
    expect(errorsOf(form('training', 'running', { locationName: '' })).locationName).toEqual([
      'Enter where the training takes place.',
    ]);
  });

  it('calls the deadline "registration deadline" for a non-training event', () => {
    const values = form('race', 'ocr', { deadlineDate: '2026-11-14', deadlineTime: '09:00' });
    expect(errorsOf(values).deadlineDate).toEqual(['The registration deadline must be before the start.']);
    const training = form('training', 'running', { deadlineDate: '2026-11-14', deadlineTime: '09:00' });
    expect(errorsOf(training).deadlineDate).toEqual(['The RSVP deadline must be before the start.']);
  });
});

describe('create: course fields and notes', () => {
  it('accepts a distance with a dot or a decimal comma, at most 2 decimals', () => {
    for (const km of ['21.1', '21,1', '42', '0.5', '0,25', '1000']) {
      expect(errorsOf(form('race', 'trail_running', { distanceKm: km })).distanceKm, km).toBeUndefined();
    }
  });

  it('rejects a distance that is zero, too long, over 2 decimals or not a number', () => {
    for (const km of ['0', '0.00', '1000.01', '5.123', 'abc', '-3', '1e3', '5,', '.5']) {
      expect(errorsOf(form('race', 'trail_running', { distanceKm: km })).distanceKm, km).toBeDefined();
    }
  });

  it('D+ is a whole number from 0 to 20000', () => {
    for (const m of ['0', '450', '20000']) {
      expect(errorsOf(form('race', 'running', { elevationGainM: m })).elevationGainM, m).toBeUndefined();
    }
    for (const m of ['20001', '45.5', '-1', 'x']) {
      expect(errorsOf(form('race', 'running', { elevationGainM: m })).elevationGainM, m).toBeDefined();
    }
  });

  it('obstacles are a whole number from 0 to 500, OCR only', () => {
    expect(errorsOf(form('race', 'ocr', { obstacleCount: '12' })).obstacleCount).toBeUndefined();
    expect(errorsOf(form('race', 'ocr', { obstacleCount: '500' })).obstacleCount).toBeUndefined();
    expect(errorsOf(form('race', 'ocr', { obstacleCount: '501' })).obstacleCount).toBeDefined();
    expect(errorsOf(form('race', 'ocr', { obstacleCount: '1.5' })).obstacleCount).toBeDefined();
  });

  it('does not validate (or send) course fields the subtype does not take', () => {
    const social = form('social', 'other', { distanceKm: 'garbage', elevationGainM: 'x', obstacleCount: 'y' });
    expect(errorsOf(social)).toEqual({});
    const input = toTrainingInput(social, ZONE);
    expect(input.distance_km).toBeNull();
    expect(input.elevation_gain_m).toBeNull();
    expect(input.obstacle_count).toBeNull();
    // Obstacles only for OCR: a trail race drops a stale count.
    const trail = form('race', 'trail_running', { distanceKm: '10', obstacleCount: '7' });
    expect(toTrainingInput(trail, ZONE).obstacle_count).toBeNull();
    expect(toTrainingInput(trail, ZONE).distance_km).toBe(10);
  });

  it('notes are optional and capped at 1000 characters', () => {
    expect(errorsOf(form('social', 'other', { eventNotes: 'x'.repeat(1000) })).eventNotes).toBeUndefined();
    expect(errorsOf(form('social', 'other', { eventNotes: 'x'.repeat(1001) })).eventNotes).toEqual([
      'Keep the notes to 1000 characters.',
    ]);
    // The cap counts characters, not UTF-16 units.
    expect(errorsOf(form('social', 'other', { eventNotes: '🏃'.repeat(1000) })).eventNotes).toBeUndefined();
  });
});

describe('toTrainingInput: the exact p_input per kind', () => {
  it('a race: kind, subtype, course, notes, no minimum, no activity_type', () => {
    const input = toTrainingInput(
      form('race', 'ocr', {
        description: ' Bring gloves ',
        distanceKm: ' 12,5 ',
        elevationGainM: '300',
        obstacleCount: '25',
        eventNotes: ' Kit check at 08:00 ',
        maxParticipants: '200',
      }),
      ZONE,
    );
    expect(input).toEqual({
      title: 'Hill race',
      description: 'Bring gloves',
      event_kind: 'race',
      event_subtype: 'ocr',
      starts_at: '2026-11-14T07:00:00.000Z',
      ends_at: null,
      rsvp_deadline: '2026-11-14T05:00:00.000Z',
      timezone: ZONE,
      location_name: 'Herastrau Park',
      address: null,
      latitude: null,
      longitude: null,
      map_url: null,
      meeting_instructions: null,
      min_participants: null,
      max_participants: 200,
      distance_km: 12.5,
      elevation_gain_m: 300,
      obstacle_count: 25,
      event_notes: 'Kit check at 08:00',
    });
    expect(input).not.toHaveProperty('activity_type');
  });

  it('a social event: no course keys set, minimum null', () => {
    const input = toTrainingInput(form('social', 'social_gathering', { eventNotes: 'Bring a dish' }), ZONE);
    expect(input).toMatchObject({
      event_kind: 'social',
      event_subtype: 'social_gathering',
      min_participants: null,
      max_participants: null,
      distance_km: null,
      event_notes: 'Bring a dish',
    });
  });

  it('a training sends its minimum and the same course keys', () => {
    const input = toTrainingInput(
      form('training', 'trail_running', { distanceKm: '8', minParticipants: ' 6 ' }),
      ZONE,
    );
    expect(input).toMatchObject({
      event_kind: 'training',
      event_subtype: 'trail_running',
      min_participants: 6,
      distance_km: 8,
    });
    expect(input).not.toHaveProperty('activity_type');
  });

  it('always sends all four P1 keys, so a changed subtype clears what it no longer takes', () => {
    const keys = Object.keys(toTrainingInput(form('sports_event', 'other'), ZONE));
    for (const key of ['event_kind', 'event_subtype', 'distance_km', 'elevation_gain_m', 'obstacle_count', 'event_notes', 'min_participants']) {
      expect(keys).toContain(key);
    }
  });

  it('refuses unvalidated values', () => {
    expect(() => toTrainingInput(form('race', 'ocr', { eventKind: 'nope' }), ZONE)).toThrow(RangeError);
    expect(() => toTrainingInput(form('race', 'ocr', { distanceKm: 'abc' }), ZONE)).toThrow(RangeError);
    expect(() => toTrainingInput(form('training', 'running', { minParticipants: '' }), ZONE)).toThrow(RangeError);
  });
});

function makeSession(kind: EventKind, overrides: Partial<TrainingSession> = {}): TrainingSession {
  return {
    id: 's1',
    community_id: 'c1',
    organizer_id: 'o1',
    title: 'Hill race',
    description: null,
    activity_type: 'trail_running',
    event_kind: kind,
    event_subtype: kind === 'training' ? 'trail_running' : kind === 'race' ? 'trail_running' : 'other',
    starts_at: '2026-11-14T07:00:00+00:00',
    ends_at: '2026-11-14T10:00:00+00:00',
    rsvp_deadline: '2026-11-14T05:00:00+00:00',
    timezone: ZONE,
    location_name: 'Herastrau Park',
    address: null,
    latitude: null,
    longitude: null,
    map_url: null,
    meeting_instructions: null,
    min_participants: kind === 'training' ? 6 : null,
    max_participants: null,
    distance_km: kind === 'race' ? 21.1 : null,
    elevation_gain_m: kind === 'race' ? 450 : null,
    obstacle_count: null,
    event_notes: 'Kit check at 08:00',
    going_count: 4,
    status: kind === 'training' ? 'scheduled' : 'confirmed',
    cancel_reason: null,
    decided_at: null,
    cancelled_at: null,
    cancelled_by: null,
    attendance_finalized_at: null,
    attendance_finalized_by: null,
    created_at: '2026-11-01T10:00:00+00:00',
    updated_at: '2026-11-01T10:00:00+00:00',
    ...overrides,
  };
}

describe('edit: prefill and round trip', () => {
  it('prefills the kind, subtype, course and notes; a null minimum is an empty string', () => {
    const values = fromSession(makeSession('race'));
    expect(values).toMatchObject({
      eventKind: 'race',
      eventSubtype: 'trail_running',
      distanceKm: '21.1',
      elevationGainM: '450',
      obstacleCount: '',
      eventNotes: 'Kit check at 08:00',
      minParticipants: '',
    });
  });

  it('an untouched race sends exactly what is stored (kind included) and validates', () => {
    const session = makeSession('race');
    const values = fromSession(session);
    expect(errorsOf(values, { mode: 'edit', timezone: ZONE, now: NOW, session })).toEqual({});
    expect(toTrainingInput(values, ZONE, session)).toMatchObject({
      event_kind: 'race',
      event_subtype: 'trail_running',
      starts_at: session.starts_at,
      rsvp_deadline: session.rsvp_deadline,
      min_participants: null,
      distance_km: 21.1,
      elevation_gain_m: 450,
      event_notes: 'Kit check at 08:00',
    });
  });
});

describe('edit: the kind is locked, the subtype is not', () => {
  it('rejects a changed kind', () => {
    const session = makeSession('race');
    const values = { ...fromSession(session), eventKind: 'social' };
    expect(errorsOf(values, { mode: 'edit', timezone: ZONE, now: NOW, session }).eventKind).toEqual([
      'The kind of an event cannot be changed after it is created.',
    ]);
  });

  it('allows another subtype of the same kind and sends null for what it no longer takes', () => {
    const session = makeSession('race', { obstacle_count: null });
    const values = { ...fromSession(session), eventSubtype: 'asphalt_running' };
    expect(errorsOf(values, { mode: 'edit', timezone: ZONE, now: NOW, session })).toEqual({});
    expect(toTrainingInput(values, ZONE, session)).toMatchObject({ event_subtype: 'asphalt_running' });
    // To a subtype without a course (training strength): course keys go out as null.
    const training = makeSession('training', { distance_km: 5, elevation_gain_m: 20 });
    const strength = { ...fromSession(training), eventSubtype: 'strength' };
    expect(toTrainingInput(strength, ZONE, training)).toMatchObject({
      event_subtype: 'strength',
      distance_km: null,
      elevation_gain_m: null,
    });
  });
});

describe('edit rules of a non-training event (mirror of the contract, display only)', () => {
  const BEFORE_DEADLINE = new Date('2026-11-13T12:00:00Z');
  const AFTER_DEADLINE = new Date('2026-11-14T05:30:00Z');

  function editErrors(
    session: TrainingSession,
    overrides: Partial<TrainingFormValues>,
    now: Date,
  ): Record<string, string[]> {
    return errorsOf(
      { ...fromSession(session), ...overrides },
      { mode: 'edit', timezone: ZONE, now, session: session as EditedSession },
    );
  }

  it('before the deadline the start, deadline and maximum can all change', () => {
    const race = makeSession('race');
    expect(editErrors(race, { date: '2026-11-15', maxParticipants: '100', deadlineDate: '2026-11-14', deadlineTime: '20:00' }, BEFORE_DEADLINE)).toEqual({});
  });

  it('after the deadline the deadline is frozen, with a registration wording', () => {
    const race = makeSession('race');
    expect(editErrors(race, { deadlineDate: '2026-11-14', deadlineTime: '06:00' }, AFTER_DEADLINE).deadlineDate).toEqual([
      'Registration has closed, so the deadline can no longer be changed.',
    ]);
  });

  it('after the deadline the maximum stays editable (but not below who is going)', () => {
    const race = makeSession('race', { going_count: 4 });
    expect(editErrors(race, { maxParticipants: '50' }, AFTER_DEADLINE)).toEqual({});
    expect(editErrors(race, { maxParticipants: '3' }, AFTER_DEADLINE).maxParticipants).toEqual([
      '4 participants are already going, so the maximum cannot be lower than 4.',
    ]);
  });

  it('after the deadline the start may move to the future, after the frozen deadline', () => {
    const race = makeSession('race');
    expect(editErrors(race, { date: '2026-11-20' }, AFTER_DEADLINE)).toEqual({});
    // A new start in the past is still refused.
    expect(editErrors(race, { startTime: '06:30' }, AFTER_DEADLINE).date).toEqual([
      'The start must be in the future.',
      'The new start must be after the registration deadline.',
    ]);
  });

  it('a training confirmed by the finalizer still freezes deadline and limits', () => {
    const training = makeSession('training', { status: 'confirmed', max_participants: 20 });
    expect(editErrors(training, { maxParticipants: '30' }, BEFORE_DEADLINE).maxParticipants).toEqual([
      'The maximum cannot be changed after the training is confirmed.',
    ]);
    expect(editErrors(training, { minParticipants: '8' }, BEFORE_DEADLINE).minParticipants).toEqual([
      'The minimum cannot be changed after the training is confirmed.',
    ]);
  });
});

describe('editableFields per kind and status', () => {
  const ALL = [...TRAINING_FORM_FIELDS].sort();

  it('training: unchanged', () => {
    expect([...editableFields('scheduled', 'training')].sort()).toEqual(ALL);
    const confirmed = editableFields('confirmed', 'training');
    for (const frozen of ['deadlineDate', 'deadlineTime', 'minParticipants', 'maxParticipants'] as const) {
      expect(confirmed.has(frozen)).toBe(false);
    }
    expect(confirmed.size).toBe(TRAINING_FORM_FIELDS.length - 4);
  });

  it('non-training: everything while registration is open', () => {
    for (const kind of ['race', 'sports_event', 'social'] as const) {
      expect([...editableFields('confirmed', kind, false)].sort()).toEqual(ALL);
    }
  });

  it('non-training after the deadline: only the deadline is frozen, the maximum is editable', () => {
    const fields = editableFields('confirmed', 'race', true);
    expect(fields.has('deadlineDate')).toBe(false);
    expect(fields.has('deadlineTime')).toBe(false);
    expect(fields.has('maxParticipants')).toBe(true);
    expect(fields.has('date')).toBe(true);
    expect(fields.has('eventSubtype')).toBe(true);
    expect(fields.size).toBe(TRAINING_FORM_FIELDS.length - 2);
  });

  it('cancelled and completed: nothing, for every kind', () => {
    for (const kind of ['training', 'race', 'social'] as const) {
      expect(editableFields('cancelled', kind).size).toBe(0);
      expect(editableFields('completed', kind).size).toBe(0);
    }
  });
});

describe('frozenFormFields per kind', () => {
  const before = new Date('2026-11-13T12:00:00Z');
  const after = new Date('2026-11-14T05:30:00Z');
  const base = {
    rsvp_deadline: '2026-11-14T05:00:00.000Z',
    starts_at: '2026-11-14T07:00:00.000Z',
    ends_at: '2026-11-14T10:00:00.000Z',
  };

  it('a race locks nothing before the deadline', () => {
    const frozen = frozenFormFields({ ...base, status: 'confirmed', event_kind: 'race' }, before);
    expect(frozen.fields.size).toBe(0);
    expect(frozen.reason).toBeNull();
  });

  it('a race locks only the deadline after it, and says why', () => {
    const frozen = frozenFormFields({ ...base, status: 'confirmed', event_kind: 'race' }, after);
    expect([...frozen.fields].sort()).toEqual(['deadlineDate', 'deadlineTime']);
    expect(frozen.reason).toBe('Locked because registration has closed.');
  });

  it('an ended event locks its date and times, whatever the kind', () => {
    const ended = new Date('2026-11-14T10:00:01Z');
    for (const kind of ['race', 'social', 'sports_event'] as const) {
      const frozen = frozenFormFields({ ...base, status: 'confirmed', event_kind: kind }, ended);
      for (const field of ['date', 'startTime', 'endTime'] as const) expect(frozen.fields.has(field)).toBe(true);
      expect(frozen.timeReason).toBe('This event has already ended');
      expect(frozen.fields.has('maxParticipants')).toBe(false);
    }
  });

  it('cancelled and completed lock everything', () => {
    for (const status of ['cancelled', 'completed'] as const) {
      const frozen = frozenFormFields({ ...base, status, event_kind: 'social' }, before);
      expect(frozen.fields.size).toBe(TRAINING_FORM_FIELDS.length);
    }
  });

  it('a training keeps its old rules', () => {
    const scheduledAfter = frozenFormFields({ ...base, status: 'scheduled', event_kind: 'training' }, after);
    expect([...scheduledAfter.fields].sort()).toEqual(
      ['deadlineDate', 'deadlineTime', 'maxParticipants', 'minParticipants'].sort(),
    );
    expect(frozenFormFields({ ...base, status: 'scheduled', event_kind: 'training' }, before).fields.size).toBe(0);
  });
});

describe('visibleFormFields: which fields each kind and subtype shows', () => {
  it('only a training shows the minimum', () => {
    expect(visibleFormFields('training', 'running').has('minParticipants')).toBe(true);
    for (const kind of ['race', 'sports_event', 'social'] as const) {
      expect(visibleFormFields(kind, defaultSubtype(kind)).has('minParticipants')).toBe(false);
    }
  });

  it('running types show distance and D+, others hide them', () => {
    for (const subtype of ['running', 'trail_running', 'asphalt_running', 'ocr']) {
      const fields = visibleFormFields('race', subtype);
      expect(fields.has('distanceKm')).toBe(true);
      expect(fields.has('elevationGainM')).toBe(true);
    }
    for (const subtype of ['strength', 'other', 'crossfit_event', 'social_gathering']) {
      const fields = visibleFormFields('training', subtype);
      expect(fields.has('distanceKm')).toBe(false);
      expect(fields.has('elevationGainM')).toBe(false);
    }
  });

  it('obstacles only for OCR', () => {
    expect(visibleFormFields('race', 'ocr').has('obstacleCount')).toBe(true);
    expect(visibleFormFields('training', 'ocr').has('obstacleCount')).toBe(true);
    expect(visibleFormFields('race', 'trail_running').has('obstacleCount')).toBe(false);
  });

  it('every kind always shows the common fields, notes and the deadline', () => {
    for (const kind of ['training', 'race', 'sports_event', 'social'] as const) {
      const fields = visibleFormFields(kind, defaultSubtype(kind));
      for (const field of ['title', 'date', 'startTime', 'locationName', 'description', 'meetingInstructions', 'deadlineDate', 'maxParticipants', 'eventNotes'] as const) {
        expect(fields.has(field), `${kind} ${field}`).toBe(true);
      }
    }
  });
});

describe('server errors land on the new fields', () => {
  it.each([
    ['distance_km', 'distanceKm'],
    ['elevation_gain_m', 'elevationGainM'],
    ['obstacle_count', 'obstacleCount'],
    ['event_notes', 'eventNotes'],
    ['event_kind', 'eventKind'],
    ['event_subtype', 'eventSubtype'],
    ['min_participants', 'minParticipants'],
    ['max_participants', 'maxParticipants'],
    ['activity_type', 'eventSubtype'],
  ])('validation_failed:%s shows on %s', (column, field) => {
    expect(formFieldForColumn(column)).toBe(field);
    const placed = serverFieldError({ code: 'validation_failed', field: column });
    expect(placed?.field).toBe(field);
    expect(placed?.message.length).toBeGreaterThan(10);
    expect(placed?.message).not.toMatch(/validation_failed|_/);
  });

  it('an error on a field the form does not show goes to the banner instead', () => {
    const shown = visibleFormFields('race', 'trail_running');
    expect(serverFieldError({ code: 'validation_failed', field: 'min_participants' }, shown)).toBeNull();
    expect(serverFieldError({ code: 'validation_failed', field: 'obstacle_count' }, shown)).toBeNull();
    expect(serverFieldError({ code: 'validation_failed', field: 'distance_km' }, shown)?.field).toBe('distanceKm');
    // The same error on a training minimum stays on its field.
    const training = visibleFormFields('training', 'running');
    expect(serverFieldError({ code: 'validation_failed', field: 'min_participants' }, training)?.field).toBe(
      'minParticipants',
    );
  });
});
