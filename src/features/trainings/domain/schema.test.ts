import { describe, expect, it } from 'vitest';

import {
  TRAINING_FORM_FIELDS,
  editableFields,
  emptyTrainingForm,
  fromSession,
  isEditable,
  toTrainingInput,
  trainingFormSchema,
  type EditedSession,
  type TrainingFormField,
  type TrainingFormValues,
} from '@/features/trainings/domain/schema';
import type { TrainingSession } from '@/lib/database.types';

const ZONE = 'Europe/Bucharest';
// Tuesday 10 November 2026, 12:00 in Bucharest.
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

function makeSession(overrides: Partial<TrainingSession> = {}): TrainingSession {
  return {
    id: 'session-1',
    community_id: 'community-1',
    organizer_id: 'user-1',
    title: 'Saturday long run',
    description: 'Easy pace',
    activity_type: 'trail_running',
    starts_at: '2026-11-14T07:00:00+00:00',
    ends_at: '2026-11-14T08:30:00+00:00',
    rsvp_deadline: '2026-11-13T16:00:00+00:00',
    timezone: ZONE,
    location_name: 'Herastrau Park',
    address: 'Sos. Nordului 7-9',
    latitude: 44.4702,
    longitude: 26.0823,
    map_url: 'https://maps.example.com/?q=herastrau',
    meeting_instructions: 'Meet at the north gate',
    min_participants: 10,
    max_participants: 20,
    going_count: 4,
    status: 'scheduled',
    cancel_reason: null,
    decided_at: null,
    cancelled_at: null,
    cancelled_by: null,
    created_at: '2026-11-01T10:00:00+00:00',
    updated_at: '2026-11-01T10:00:00+00:00',
    ...overrides,
  };
}

/** Field → messages for a create form. */
function createErrors(
  overrides: Partial<TrainingFormValues>,
  now: Date = NOW,
): Partial<Record<TrainingFormField, string[]>> {
  return errorsOf(
    trainingFormSchema({ mode: 'create', timezone: ZONE, now }).safeParse(validForm(overrides)),
  );
}

function editErrors(
  session: EditedSession & Parameters<typeof fromSession>[0],
  overrides: Partial<TrainingFormValues>,
  now: Date = NOW,
): Partial<Record<TrainingFormField, string[]>> {
  const values = { ...fromSession(session), ...overrides };
  return errorsOf(
    trainingFormSchema({ mode: 'edit', timezone: session.timezone, now, session }).safeParse(values),
  );
}

function errorsOf(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}): Partial<Record<TrainingFormField, string[]>> {
  const errors: Partial<Record<TrainingFormField, string[]>> = {};
  for (const issue of result.error?.issues ?? []) {
    expect(issue.path).toHaveLength(1);
    const field = issue.path[0] as TrainingFormField;
    expect(TRAINING_FORM_FIELDS).toContain(field);
    (errors[field] ??= []).push(issue.message);
  }
  return errors;
}

describe('trainingFormSchema: create', () => {
  it('accepts the minimal valid form', () => {
    expect(createErrors({})).toEqual({});
  });

  it('accepts a fully filled form', () => {
    expect(
      createErrors({
        description: 'Easy pace',
        activityType: 'trail_running',
        endTime: '10:30',
        deadlineDate: '2026-11-13',
        deadlineTime: '18:00',
        address: 'Sos. Nordului 7-9',
        latitude: '44.4702',
        longitude: '26.0823',
        mapUrl: 'https://maps.example.com/?q=herastrau',
        meetingInstructions: 'Meet at the north gate',
        maxParticipants: '20',
      }),
    ).toEqual({});
  });

  it('reports every required field of an empty form at once, each on its own path', () => {
    const result = trainingFormSchema({ mode: 'create', timezone: ZONE, now: NOW }).safeParse(
      emptyTrainingForm(),
    );
    expect(Object.keys(errorsOf(result)).sort()).toEqual(
      ['date', 'locationName', 'minParticipants', 'startTime', 'title'].sort(),
    );
  });

  it('rejects a wrong shape (non-string field)', () => {
    const result = trainingFormSchema({ mode: 'create', timezone: ZONE, now: NOW }).safeParse({
      ...validForm(),
      minParticipants: 10,
    });
    expect(result.success).toBe(false);
  });

  it('refuses to build a schema for an invalid time zone', () => {
    expect(() => trainingFormSchema({ mode: 'create', timezone: 'Nope/Zone', now: NOW })).toThrow(
      RangeError,
    );
  });

  describe('title (1–80) and location name (1–120)', () => {
    it('trims before measuring', () => {
      expect(createErrors({ title: '   ' }).title).toBeDefined();
      expect(createErrors({ title: ` ${'a'.repeat(80)} ` })).toEqual({});
      expect(createErrors({ locationName: '  ' }).locationName).toBeDefined();
    });

    it('enforces the length boundaries', () => {
      expect(createErrors({ title: 'a' })).toEqual({});
      expect(createErrors({ title: 'a'.repeat(80) })).toEqual({});
      expect(createErrors({ title: 'a'.repeat(81) }).title).toBeDefined();
      expect(createErrors({ locationName: 'a' })).toEqual({});
      expect(createErrors({ locationName: 'a'.repeat(120) })).toEqual({});
      expect(createErrors({ locationName: 'a'.repeat(121) }).locationName).toBeDefined();
    });
  });

  describe('participants', () => {
    it('requires a whole minimum of at least 1', () => {
      expect(createErrors({ minParticipants: '1' })).toEqual({});
      expect(createErrors({ minParticipants: '0' }).minParticipants).toBeDefined();
      expect(createErrors({ minParticipants: '-3' }).minParticipants).toBeDefined();
      expect(createErrors({ minParticipants: '2.5' }).minParticipants).toBeDefined();
      expect(createErrors({ minParticipants: 'ten' }).minParticipants).toBeDefined();
      expect(createErrors({ minParticipants: '' }).minParticipants).toBeDefined();
    });

    it('requires max ≥ min, with the error on the maximum', () => {
      expect(createErrors({ minParticipants: '10', maxParticipants: '9' })).toEqual({
        maxParticipants: ['The maximum cannot be lower than the minimum.'],
      });
      expect(createErrors({ minParticipants: '10', maxParticipants: '10' })).toEqual({});
      expect(createErrors({ minParticipants: '10', maxParticipants: '11' })).toEqual({});
      expect(createErrors({ minParticipants: '10', maxParticipants: '' })).toEqual({});
    });

    it('rejects a maximum that is not a whole number', () => {
      expect(createErrors({ maxParticipants: 'many' }).maxParticipants).toBeDefined();
      expect(createErrors({ maxParticipants: '12.5' }).maxParticipants).toBeDefined();
    });
  });

  describe('start', () => {
    it('requires a real date and time', () => {
      expect(createErrors({ date: '2026-02-30' }).date).toBeDefined();
      expect(createErrors({ date: '14.11.2026' }).date).toBeDefined();
      expect(createErrors({ startTime: '25:00' }).startTime).toBeDefined();
      expect(createErrors({ startTime: '9' }).startTime).toBeDefined();
    });

    it('must be in the future, judged in the session zone', () => {
      // 13:00 Bucharest today is 11:00Z, one hour after NOW; give it a deadline so only the start is judged.
      expect(
        createErrors({
          date: '2026-11-10',
          startTime: '13:00',
          deadlineDate: '2026-11-10',
          deadlineTime: '12:30',
        }),
      ).toEqual({});
      // 12:00 Bucharest is exactly NOW: not in the future.
      expect(createErrors({ date: '2026-11-10', startTime: '12:00' })).toEqual({
        date: ['The start must be in the future.'],
      });
      expect(createErrors({ date: '2026-11-09' })).toEqual({
        date: ['The start must be in the future.'],
      });
    });

    it('uses the injected now, not the real clock', () => {
      expect(createErrors({}, new Date('2026-11-15T00:00:00Z')).date).toBeDefined();
      expect(createErrors({ date: '2020-01-04' }, new Date('2020-01-01T00:00:00Z'))).toEqual({});
    });
  });

  describe('end', () => {
    it('must be after the start, with the error on the end time', () => {
      expect(createErrors({ endTime: '10:30' })).toEqual({});
      expect(createErrors({ endTime: '09:01' })).toEqual({});
      expect(createErrors({ endTime: '09:00' })).toEqual({
        endTime: ['The end time must be after the start time.'],
      });
      expect(createErrors({ endTime: '08:00' }).endTime).toBeDefined();
    });

    it('must be a valid time when given', () => {
      expect(createErrors({ endTime: '10h' }).endTime).toBeDefined();
    });
  });

  describe('RSVP deadline', () => {
    it('may equal the start but not be after it', () => {
      expect(createErrors({ deadlineDate: '2026-11-14', deadlineTime: '09:00' })).toEqual({});
      expect(createErrors({ deadlineDate: '2026-11-14', deadlineTime: '09:01' })).toEqual({
        deadlineDate: ['The RSVP deadline must be at or before the start.'],
      });
      expect(createErrors({ deadlineDate: '2026-11-15', deadlineTime: '08:00' })).toEqual({
        deadlineDate: ['The RSVP deadline must be at or before the start.'],
      });
    });

    it('must be in the future', () => {
      expect(createErrors({ deadlineDate: '2026-11-10', deadlineTime: '12:01' })).toEqual({});
      expect(createErrors({ deadlineDate: '2026-11-10', deadlineTime: '12:00' })).toEqual({
        deadlineDate: ['The RSVP deadline must be in the future.'],
      });
      expect(createErrors({ deadlineDate: '2026-11-09', deadlineTime: '18:00' })).toEqual({
        deadlineDate: ['The RSVP deadline must be in the future.'],
      });
    });

    it('needs both a date and a time, or neither', () => {
      expect(createErrors({ deadlineDate: '2026-11-13' })).toEqual({
        deadlineTime: ['Choose a deadline time, or clear the deadline date.'],
      });
      expect(createErrors({ deadlineTime: '18:00' })).toEqual({
        deadlineDate: ['Choose a deadline date, or clear the deadline time.'],
      });
    });

    it('explains when the default (start − 2h) would already be in the past', () => {
      // Starts 13:30 Bucharest = 1.5 hours from NOW, so the default deadline has passed.
      const errors = createErrors({ date: '2026-11-10', startTime: '13:30' });
      expect(Object.keys(errors)).toEqual(['deadlineDate']);
      expect(errors.deadlineDate?.[0]).toContain('less than 2 hours');
      // Exactly 2 hours away: default deadline == now, still not in the future.
      expect(createErrors({ date: '2026-11-10', startTime: '14:00' }).deadlineDate).toBeDefined();
      expect(createErrors({ date: '2026-11-10', startTime: '14:01' })).toEqual({});
    });

    it('does not pile a deadline error on top of a past start', () => {
      expect(Object.keys(createErrors({ date: '2026-11-09' }))).toEqual(['date']);
    });
  });

  describe('coordinates', () => {
    it('enforces the latitude range', () => {
      expect(createErrors({ latitude: '90', longitude: '0' })).toEqual({});
      expect(createErrors({ latitude: '-90', longitude: '0' })).toEqual({});
      expect(createErrors({ latitude: '90.0001', longitude: '0' }).latitude).toBeDefined();
      expect(createErrors({ latitude: '-91', longitude: '0' }).latitude).toBeDefined();
    });

    it('enforces the longitude range', () => {
      expect(createErrors({ latitude: '0', longitude: '180' })).toEqual({});
      expect(createErrors({ latitude: '0', longitude: '-180' })).toEqual({});
      expect(createErrors({ latitude: '0', longitude: '180.5' }).longitude).toBeDefined();
      expect(createErrors({ latitude: '0', longitude: '-181' }).longitude).toBeDefined();
    });

    it('rejects text and requires both or neither', () => {
      expect(createErrors({ latitude: 'north', longitude: '26' }).latitude).toBeDefined();
      expect(createErrors({ latitude: '44.47' })).toEqual({
        longitude: ['Enter the longitude too.'],
      });
      expect(createErrors({ longitude: '26.08' })).toEqual({
        latitude: ['Enter the latitude too.'],
      });
    });

    it('accepts a decimal comma', () => {
      expect(createErrors({ latitude: '44,4702', longitude: '26,0823' })).toEqual({});
    });
  });

  describe('map link', () => {
    it.each(['https://maps.app.goo.gl/abc', 'http://example.com', 'HTTPS://EXAMPLE.COM/x?y=1'])(
      'accepts %s',
      (mapUrl) => {
        expect(createErrors({ mapUrl })).toEqual({});
      },
    );

    it.each([
      'maps.google.com',
      'ftp://example.com/file',
      'javascript:alert(1)',
      'geo:44.47,26.08',
      'https://',
      'https://exa mple.com',
      'see https://example.com',
    ])('rejects %s', (mapUrl) => {
      expect(Object.keys(createErrors({ mapUrl }))).toEqual(['mapUrl']);
    });
  });

  it('requires an activity', () => {
    expect(createErrors({ activityType: '' }).activityType).toBeDefined();
    // Keys are rows in a lookup table, so unknown ones are allowed.
    expect(createErrors({ activityType: 'yoga' })).toEqual({});
  });

  it('reports several cross-field problems together', () => {
    const errors = createErrors({
      endTime: '08:00',
      maxParticipants: '5',
      deadlineDate: '2026-11-15',
      deadlineTime: '10:00',
      mapUrl: 'nope',
    });
    expect(Object.keys(errors).sort()).toEqual(
      ['deadlineDate', 'endTime', 'mapUrl', 'maxParticipants'].sort(),
    );
  });

  it('validates across the spring-forward change in the session zone', () => {
    const now = new Date('2026-03-20T10:00:00Z');
    // 04:30 on the change day; the default deadline is 01:30 the same morning.
    expect(createErrors({ date: '2026-03-29', startTime: '04:30' }, now)).toEqual({});
    // 02:45 is before 04:30 on the clock and in real time.
    expect(
      createErrors(
        { date: '2026-03-29', startTime: '04:30', deadlineDate: '2026-03-29', deadlineTime: '02:45' },
        now,
      ),
    ).toEqual({});
    // 03:30 does not exist and becomes 04:30, which is not after a 04:30 start.
    expect(
      createErrors({ date: '2026-03-29', startTime: '04:30', endTime: '03:30' }, now).endTime,
    ).toBeDefined();
  });
});

describe('trainingFormSchema: edit', () => {
  it('accepts an unchanged scheduled session', () => {
    expect(editErrors(makeSession(), {})).toEqual({});
  });

  describe('scheduled', () => {
    it('allows changing everything', () => {
      expect(
        editErrors(makeSession(), {
          title: 'New title',
          date: '2026-11-21',
          startTime: '10:00',
          endTime: '12:00',
          deadlineDate: '2026-11-20',
          deadlineTime: '20:00',
          minParticipants: '5',
          maxParticipants: '30',
        }),
      ).toEqual({});
    });

    it('does not allow the maximum below the number already going', () => {
      const session = makeSession({ going_count: 12, min_participants: 5, max_participants: 20 });
      expect(editErrors(session, { maxParticipants: '11' })).toEqual({
        maxParticipants: [
          '12 participants are already going, so the maximum cannot be lower than 12.',
        ],
      });
      expect(editErrors(session, { maxParticipants: '12' })).toEqual({});
      expect(editErrors(session, { maxParticipants: '13' })).toEqual({});
      expect(editErrors(session, { maxParticipants: '' })).toEqual({});
    });

    it('uses the singular for one participant going', () => {
      const session = makeSession({ going_count: 1, min_participants: 1, max_participants: 5 });
      // A maximum below 1 going can only be 0; with the minimum invalid too, the
      // "already going" rule is the one reported on the maximum.
      const errors = editErrors(session, { minParticipants: '0', maxParticipants: '0' });
      expect(errors.maxParticipants).toEqual([
        '1 participant is already going, so the maximum cannot be lower than 1.',
      ]);
    });

    it('requires a new deadline in the future', () => {
      expect(
        editErrors(makeSession(), { deadlineDate: '2026-11-10', deadlineTime: '11:00' }),
      ).toEqual({ deadlineDate: ['The RSVP deadline must be in the future.'] });
    });

    it('requires a future deadline when the stored one has passed (finalizing)', () => {
      const afterDeadline = new Date('2026-11-13T17:00:00Z');
      expect(editErrors(makeSession(), {}, afterDeadline)).toEqual({
        deadlineDate: ['The RSVP deadline must be in the future.'],
      });
    });

    it('still checks deadline ≤ start and end > start', () => {
      expect(
        editErrors(makeSession(), { deadlineDate: '2026-11-14', deadlineTime: '09:30' }).deadlineDate,
      ).toEqual(['The RSVP deadline must be at or before the start.']);
      expect(editErrors(makeSession(), { endTime: '08:59' }).endTime).toBeDefined();
    });
  });

  describe('confirmed', () => {
    const confirmed = makeSession({
      status: 'confirmed',
      going_count: 12,
      decided_at: '2026-11-13T16:00:01+00:00',
    });
    // The deadline has passed, as it always has for a confirmed session.
    const now = new Date('2026-11-13T18:00:00Z');

    it('accepts an unchanged form even though the deadline is in the past', () => {
      expect(editErrors(confirmed, {}, now)).toEqual({});
    });

    it('allows descriptive fields and a future start / end', () => {
      expect(
        editErrors(
          confirmed,
          {
            title: 'Moved: Saturday long run',
            description: '',
            locationName: 'Tineretului Park',
            mapUrl: '',
            startTime: '10:00',
            endTime: '11:30',
          },
          now,
        ),
      ).toEqual({});
    });

    it('freezes the deadline', () => {
      expect(editErrors(confirmed, { deadlineTime: '17:00' }, now)).toEqual({
        deadlineDate: ['The RSVP deadline cannot be changed after the training is confirmed.'],
      });
      expect(editErrors(confirmed, { deadlineDate: '', deadlineTime: '' }, now)).toEqual({
        deadlineDate: ['The RSVP deadline cannot be changed after the training is confirmed.'],
      });
    });

    it('freezes the minimum and maximum', () => {
      expect(editErrors(confirmed, { minParticipants: '8' }, now)).toEqual({
        minParticipants: ['The minimum cannot be changed after the training is confirmed.'],
      });
      expect(editErrors(confirmed, { maxParticipants: '25' }, now)).toEqual({
        maxParticipants: ['The maximum cannot be changed after the training is confirmed.'],
      });
      expect(editErrors(confirmed, { maxParticipants: '' }, now)).toEqual({
        maxParticipants: ['The maximum cannot be changed after the training is confirmed.'],
      });
    });

    it('rejects moving the start into the past, but not an untouched past start', () => {
      expect(editErrors(confirmed, { date: '2026-11-12', endTime: '' }, now).date).toEqual([
        'The start must be in the future.',
      ]);
      // During the session: the stored start has passed, editing the description is fine.
      const during = new Date('2026-11-14T07:30:00Z');
      expect(editErrors(confirmed, { description: 'Bring water' }, during)).toEqual({});
      // ...but a changed end must still be in the future.
      expect(editErrors(confirmed, { endTime: '09:15' }, during)).toEqual({
        endTime: ['The end time must be in the future.'],
      });
      expect(editErrors(confirmed, { endTime: '11:00' }, during)).toEqual({});
    });
  });
});

describe('toTrainingInput', () => {
  it('builds the snake_case payload with UTC timestamps and nulls for empty fields', () => {
    expect(toTrainingInput(validForm(), ZONE)).toEqual({
      title: 'Saturday long run',
      description: null,
      activity_type: 'other',
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
      min_participants: 10,
      max_participants: null,
    });
  });

  it('sends exactly the keys the contract lists', () => {
    expect(Object.keys(toTrainingInput(validForm(), ZONE)).sort()).toEqual(
      [
        'title',
        'description',
        'activity_type',
        'starts_at',
        'ends_at',
        'rsvp_deadline',
        'timezone',
        'location_name',
        'address',
        'latitude',
        'longitude',
        'map_url',
        'meeting_instructions',
        'min_participants',
        'max_participants',
      ].sort(),
    );
  });

  it('converts and trims every filled field', () => {
    const input = toTrainingInput(
      validForm({
        title: '  Hill repeats ',
        description: ' Bring water ',
        activityType: 'trail_running',
        endTime: '10:30',
        deadlineDate: '2026-11-13',
        deadlineTime: '18:00',
        locationName: ' Herastrau Park ',
        address: ' Sos. Nordului 7-9 ',
        latitude: ' 44,4702 ',
        longitude: '26.0823',
        mapUrl: ' https://maps.example.com/x ',
        meetingInstructions: ' North gate ',
        minParticipants: ' 8 ',
        maxParticipants: '20',
      }),
      ZONE,
    );
    expect(input).toEqual({
      title: 'Hill repeats',
      description: 'Bring water',
      activity_type: 'trail_running',
      starts_at: '2026-11-14T07:00:00.000Z',
      ends_at: '2026-11-14T08:30:00.000Z',
      rsvp_deadline: '2026-11-13T16:00:00.000Z',
      timezone: ZONE,
      location_name: 'Herastrau Park',
      address: 'Sos. Nordului 7-9',
      latitude: 44.4702,
      longitude: 26.0823,
      map_url: 'https://maps.example.com/x',
      meeting_instructions: 'North gate',
      min_participants: 8,
      max_participants: 20,
    });
  });

  it('interprets the wall time in the zone it is given', () => {
    expect(toTrainingInput(validForm(), 'Asia/Tokyo').starts_at).toBe('2026-11-14T00:00:00.000Z');
    expect(toTrainingInput(validForm(), 'America/New_York').starts_at).toBe(
      '2026-11-14T14:00:00.000Z',
    );
    expect(toTrainingInput(validForm(), 'America/New_York').timezone).toBe('America/New_York');
  });

  it('uses the right offset on each side of a DST change', () => {
    expect(toTrainingInput(validForm({ date: '2026-03-28' }), ZONE).starts_at).toBe(
      '2026-03-28T07:00:00.000Z',
    );
    expect(toTrainingInput(validForm({ date: '2026-03-29' }), ZONE).starts_at).toBe(
      '2026-03-29T06:00:00.000Z',
    );
    expect(toTrainingInput(validForm({ date: '2026-10-25' }), ZONE).starts_at).toBe(
      '2026-10-25T07:00:00.000Z',
    );
  });

  it('defaults the deadline to two real hours before the start, even across DST', () => {
    const input = toTrainingInput(validForm({ date: '2026-03-29', startTime: '04:30' }), ZONE);
    expect(input.starts_at).toBe('2026-03-29T01:30:00.000Z');
    expect(input.rsvp_deadline).toBe('2026-03-28T23:30:00.000Z');
  });

  it('throws on values that were not validated instead of sending garbage', () => {
    expect(() => toTrainingInput(emptyTrainingForm(), ZONE)).toThrow(RangeError);
    expect(() => toTrainingInput(validForm({ minParticipants: 'ten' }), ZONE)).toThrow(RangeError);
    expect(() => toTrainingInput(validForm({ endTime: 'soon' }), ZONE)).toThrow(RangeError);
    expect(() => toTrainingInput(validForm({ maxParticipants: 'x' }), ZONE)).toThrow(RangeError);
    expect(() => toTrainingInput(validForm({ latitude: 'x', longitude: '1' }), ZONE)).toThrow(
      RangeError,
    );
    expect(() => toTrainingInput(validForm({ deadlineDate: '2026-11-13' }), ZONE)).toThrow(
      RangeError,
    );
    expect(() => toTrainingInput(validForm(), 'Nope/Zone')).toThrow(RangeError);
  });
});

describe('fromSession', () => {
  it('prefills every field in the session zone', () => {
    expect(fromSession(makeSession())).toEqual({
      title: 'Saturday long run',
      description: 'Easy pace',
      activityType: 'trail_running',
      date: '2026-11-14',
      startTime: '09:00',
      endTime: '10:30',
      deadlineDate: '2026-11-13',
      deadlineTime: '18:00',
      locationName: 'Herastrau Park',
      address: 'Sos. Nordului 7-9',
      latitude: '44.4702',
      longitude: '26.0823',
      mapUrl: 'https://maps.example.com/?q=herastrau',
      meetingInstructions: 'Meet at the north gate',
      minParticipants: '10',
      maxParticipants: '20',
    });
  });

  it('uses empty strings for nulls and covers every form field', () => {
    const values = fromSession(
      makeSession({
        description: null,
        ends_at: null,
        address: null,
        latitude: null,
        longitude: null,
        map_url: null,
        meeting_instructions: null,
        max_participants: null,
      }),
    );
    expect(values).toMatchObject({
      description: '',
      endTime: '',
      address: '',
      latitude: '',
      longitude: '',
      mapUrl: '',
      meetingInstructions: '',
      maxParticipants: '',
    });
    expect(Object.keys(values).sort()).toEqual([...TRAINING_FORM_FIELDS].sort());
  });

  it('uses the session zone, not the community default or the device', () => {
    const values = fromSession(makeSession({ timezone: 'Asia/Tokyo' }));
    expect(values.startTime).toBe('16:00');
    expect(values.deadlineDate).toBe('2026-11-14');
    expect(values.deadlineTime).toBe('01:00');
  });

  it('round-trips: an untouched edit form sends the stored values back', () => {
    const session = makeSession();
    const input = toTrainingInput(fromSession(session), session.timezone, session);
    expect(input).toEqual({
      title: session.title,
      description: session.description,
      activity_type: session.activity_type,
      starts_at: session.starts_at,
      ends_at: session.ends_at,
      rsvp_deadline: session.rsvp_deadline,
      timezone: session.timezone,
      location_name: session.location_name,
      address: session.address,
      latitude: session.latitude,
      longitude: session.longitude,
      map_url: session.map_url,
      meeting_instructions: session.meeting_instructions,
      min_participants: session.min_participants,
      max_participants: session.max_participants,
    });
  });

  it('round-trips to the same instants without the stored session too', () => {
    const session = makeSession();
    const input = toTrainingInput(fromSession(session), session.timezone);
    expect(new Date(input.starts_at).getTime()).toBe(new Date(session.starts_at).getTime());
    expect(new Date(input.ends_at ?? '').getTime()).toBe(new Date(session.ends_at ?? '').getTime());
    expect(new Date(input.rsvp_deadline ?? '').getTime()).toBe(
      new Date(session.rsvp_deadline).getTime(),
    );
  });

  it('keeps stored instants exact when untouched: sub-minute precision and the repeated DST hour', () => {
    // Second pass through 03:30 on the fall-back day, with seconds: neither survives a wall-clock round trip.
    const session = makeSession({
      status: 'confirmed',
      starts_at: '2026-10-25T07:00:00+00:00',
      ends_at: null,
      rsvp_deadline: '2026-10-25T01:30:20.123456+00:00',
    });
    const form = fromSession(session);
    expect(form.deadlineTime).toBe('03:30');
    expect(toTrainingInput(form, session.timezone, session).rsvp_deadline).toBe(
      session.rsvp_deadline,
    );
    // So the frozen-deadline rule does not fire on an untouched confirmed session.
    expect(editErrors(session, {}, new Date('2026-10-25T02:00:00Z'))).toEqual({});
  });

  it('sends a new instant once the field is edited', () => {
    const session = makeSession();
    const form = { ...fromSession(session), startTime: '09:30' };
    expect(toTrainingInput(form, session.timezone, session).starts_at).toBe(
      '2026-11-14T07:30:00.000Z',
    );
  });
});

describe('editableFields', () => {
  it('scheduled: everything', () => {
    expect([...editableFields('scheduled')].sort()).toEqual([...TRAINING_FORM_FIELDS].sort());
    expect(isEditable('scheduled')).toBe(true);
  });

  it('confirmed: everything except the deadline and participant limits', () => {
    const fields = editableFields('confirmed');
    for (const frozen of ['deadlineDate', 'deadlineTime', 'minParticipants', 'maxParticipants'] as const) {
      expect(fields.has(frozen)).toBe(false);
    }
    for (const open of [
      'title',
      'description',
      'activityType',
      'date',
      'startTime',
      'endTime',
      'locationName',
      'address',
      'latitude',
      'longitude',
      'mapUrl',
      'meetingInstructions',
    ] as const) {
      expect(fields.has(open)).toBe(true);
    }
    expect(fields.size).toBe(TRAINING_FORM_FIELDS.length - 4);
    expect(isEditable('confirmed')).toBe(true);
  });

  it.each(['cancelled', 'completed'] as const)('%s: nothing', (status) => {
    expect(editableFields(status).size).toBe(0);
    expect(isEditable(status)).toBe(false);
  });
});
