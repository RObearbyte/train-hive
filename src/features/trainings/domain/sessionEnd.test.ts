import { describe, expect, it } from 'vitest';

import { frozenFormFields } from './formState';
import { hasPredictedEnded, isPast, sessionEndInstant } from './status';
import { deviceSaysEnded, needsAttendance } from '@/features/attendance/domain/sheet';

const START = '2026-11-14T07:00:00.000Z';
const END = '2026-11-14T08:30:00.000Z';
const ms = (iso: string) => new Date(iso).getTime();
const at = (iso: string, deltaMs: number) => new Date(ms(iso) + deltaMs);
const HOUR = 3600_000;

describe('sessionEndInstant', () => {
  it('is ends_at when present', () => {
    expect(sessionEndInstant({ starts_at: START, ends_at: END })).toBe(ms(END));
  });
  it('is start + 2 hours when there is no end', () => {
    expect(sessionEndInstant({ starts_at: START, ends_at: null })).toBe(ms(START) + 2 * HOUR);
  });
});

describe('predicted end boundaries', () => {
  const withEnd = { starts_at: START, ends_at: END };
  const noEnd = { starts_at: START, ends_at: null };

  it('with ends_at: not ended at end-1s, ended at end', () => {
    expect(hasPredictedEnded(withEnd, at(END, -1000))).toBe(false);
    expect(hasPredictedEnded(withEnd, at(END, 0))).toBe(true);
  });
  it('without ends_at: not ended at +2h-1s, ended at +2h', () => {
    expect(hasPredictedEnded(noEnd, at(START, 2 * HOUR - 1000))).toBe(false);
    expect(hasPredictedEnded(noEnd, at(START, 2 * HOUR))).toBe(true);
    expect(hasPredictedEnded(noEnd, at(START, 1))).toBe(false);
  });
  it('isPast, needsAttendance and deviceSaysEnded agree', () => {
    const session = { status: 'confirmed' as const, ...noEnd };
    for (const [delta, expected] of [
      [2 * HOUR - 1000, false],
      [2 * HOUR, true],
    ] as const) {
      const now = at(START, delta);
      expect(isPast(session, now)).toBe(expected);
      expect(needsAttendance(session, now)).toBe(expected);
      expect(deviceSaysEnded(session, now)).toBe(expected);
    }
  });
});

describe('frozenFormFields time lock', () => {
  const base = {
    rsvp_deadline: '2026-11-14T05:00:00.000Z',
    starts_at: START,
    ends_at: END,
  };
  const times = ['date', 'startTime', 'endTime'] as const;

  it('locks date and times on a confirmed session that has ended', () => {
    const frozen = frozenFormFields({ ...base, status: 'confirmed' }, at(END, 0));
    for (const field of times) expect(frozen.fields.has(field)).toBe(true);
    expect(frozen.timeReason).toBe('This training has already ended');
    expect(frozen.fields.has('title')).toBe(false);
  });
  it('leaves the times editable one second before the end', () => {
    const frozen = frozenFormFields({ ...base, status: 'confirmed' }, at(END, -1000));
    for (const field of times) expect(frozen.fields.has(field)).toBe(false);
    expect(frozen.timeReason).toBeNull();
  });
  it('uses start + 2 hours when there is no end', () => {
    const session = { ...base, ends_at: null, status: 'confirmed' as const };
    expect(frozenFormFields(session, at(START, 2 * HOUR - 1000)).fields.has('date')).toBe(false);
    expect(frozenFormFields(session, at(START, 2 * HOUR)).fields.has('date')).toBe(true);
  });
  it('does not lock times of a scheduled session', () => {
    const frozen = frozenFormFields({ ...base, status: 'scheduled' }, at(END, 0));
    expect(frozen.fields.has('date')).toBe(false);
  });
});
