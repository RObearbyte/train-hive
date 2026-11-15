import { describe, expect, it } from 'vitest';

import {
  defaultDeadline,
  formFieldForColumn,
  frozenFormFields,
  serverFieldError,
} from './formState';
import { TRAINING_FORM_FIELDS } from './schema';

describe('formFieldForColumn', () => {
  it('maps every editable p_input column to a form field', () => {
    expect(formFieldForColumn('title')).toBe('title');
    expect(formFieldForColumn('activity_type')).toBe('activityType');
    expect(formFieldForColumn('starts_at')).toBe('date');
    expect(formFieldForColumn('ends_at')).toBe('endTime');
    expect(formFieldForColumn('rsvp_deadline')).toBe('deadlineDate');
    expect(formFieldForColumn('location_name')).toBe('locationName');
    expect(formFieldForColumn('map_url')).toBe('mapUrl');
    expect(formFieldForColumn('meeting_instructions')).toBe('meetingInstructions');
    expect(formFieldForColumn('min_participants')).toBe('minParticipants');
    expect(formFieldForColumn('max_participants')).toBe('maxParticipants');
    expect(formFieldForColumn('latitude')).toBe('latitude');
    expect(formFieldForColumn('longitude')).toBe('longitude');
    expect(formFieldForColumn('address')).toBe('address');
    expect(formFieldForColumn('description')).toBe('description');
  });

  it('returns null for columns without a field, unknown columns and prototype keys', () => {
    expect(formFieldForColumn('timezone')).toBeNull();
    expect(formFieldForColumn('going_count')).toBeNull();
    expect(formFieldForColumn('toString')).toBeNull();
    expect(formFieldForColumn(undefined)).toBeNull();
  });

  it('only ever points at real form fields', () => {
    const fields = new Set<string>(TRAINING_FORM_FIELDS);
    for (const column of ['title', 'starts_at', 'ends_at', 'rsvp_deadline', 'max_participants']) {
      expect(fields.has(formFieldForColumn(column) as string)).toBe(true);
    }
  });
});

describe('serverFieldError', () => {
  it('puts validation_failed:<column> on the matching field with a specific message', () => {
    expect(serverFieldError({ code: 'validation_failed', field: 'max_participants' })).toEqual({
      field: 'maxParticipants',
      message:
        'The maximum cannot be lower than the minimum or the number already going. It cannot be changed once responses have closed.',
    });
    expect(serverFieldError({ code: 'validation_failed', field: 'starts_at' })?.field).toBe('date');
  });

  it('falls back to the generic field message', () => {
    expect(serverFieldError({ code: 'validation_failed', field: 'title' })).toEqual({
      field: 'title',
      message: 'The title is not valid. Please check it and try again.',
    });
  });

  it('returns null when there is no field to show it on', () => {
    expect(serverFieldError({ code: 'validation_failed', field: 'timezone' })).toBeNull();
    expect(serverFieldError({ code: 'validation_failed' })).toBeNull();
    expect(serverFieldError({ code: 'forbidden', field: 'title' })).toBeNull();
    expect(serverFieldError({ code: 'network_error' })).toBeNull();
  });
});

describe('frozenFormFields', () => {
  const deadline = '2026-11-20T07:00:00.000Z';
  const START = '2026-11-21T07:00:00.000Z';
  const before = new Date('2026-11-20T06:59:59.000Z');
  const after = new Date('2026-11-20T07:00:00.000Z');
  const limits = ['deadlineDate', 'deadlineTime', 'minParticipants', 'maxParticipants'];

  it('locks nothing on a scheduled session before its deadline', () => {
    const frozen = frozenFormFields({ status: 'scheduled', rsvp_deadline: deadline, starts_at: START, ends_at: null }, before);
    expect(frozen.fields.size).toBe(0);
    expect(frozen.reason).toBeNull();
  });

  it('locks the deadline and limits on a scheduled session at or after its deadline', () => {
    const frozen = frozenFormFields({ status: 'scheduled', rsvp_deadline: deadline, starts_at: START, ends_at: null }, after);
    expect([...frozen.fields].sort()).toEqual([...limits].sort());
    expect(frozen.reason).toBe('Locked because the RSVP deadline has passed.');
  });

  it('locks the deadline and limits on a confirmed session', () => {
    const frozen = frozenFormFields({ status: 'confirmed', rsvp_deadline: deadline, starts_at: START, ends_at: null }, before);
    expect([...frozen.fields].sort()).toEqual([...limits].sort());
    expect(frozen.fields.has('title')).toBe(false);
    expect(frozen.reason).toBe('Locked because the training is confirmed.');
  });

  it('locks everything on cancelled and completed sessions', () => {
    for (const status of ['cancelled', 'completed'] as const) {
      const frozen = frozenFormFields({ status, rsvp_deadline: deadline, starts_at: START, ends_at: null }, before);
      expect(frozen.fields.size).toBe(TRAINING_FORM_FIELDS.length);
    }
  });
});

describe('defaultDeadline', () => {
  it('is two hours before the start, in the session zone', () => {
    expect(defaultDeadline({ date: '2026-11-14', startTime: '09:00' }, 'Europe/Bucharest')).toEqual({
      wall: { date: '2026-11-14', time: '07:00' },
      text: 'Sat 14 Nov, 07:00',
    });
  });

  it('crosses midnight', () => {
    expect(defaultDeadline({ date: '2026-11-14', startTime: '01:30' }, 'Europe/Bucharest')).toEqual({
      wall: { date: '2026-11-13', time: '23:30' },
      text: 'Fri 13 Nov, 23:30',
    });
  });

  it('is two real hours before the start across a daylight-saving change', () => {
    // Bucharest springs forward at 03:00 on 2026-03-29, so 04:30 minus 2 hours is 01:30.
    expect(
      defaultDeadline({ date: '2026-03-29', startTime: '04:30' }, 'Europe/Bucharest')?.wall,
    ).toEqual({ date: '2026-03-29', time: '01:30' });
  });

  it('is null until the date and start time are valid', () => {
    expect(defaultDeadline({ date: '', startTime: '09:00' }, 'Europe/Bucharest')).toBeNull();
    expect(defaultDeadline({ date: '2026-02-30', startTime: '09:00' }, 'UTC')).toBeNull();
    expect(defaultDeadline({ date: '2026-11-14', startTime: '9' }, 'UTC')).toBeNull();
    expect(defaultDeadline({ date: '2026-11-14', startTime: '09:00' }, 'Nowhere/Zone')).toBeNull();
  });
});
