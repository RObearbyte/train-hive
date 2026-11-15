import { describe, expect, it } from 'vitest';

import {
  comparePast,
  compareUpcoming,
  deriveDisplayStatus,
  isPast,
  isUpcoming,
  nextSession,
  participationSummary,
  splitSessions,
  type TrainingDisplayStatus,
} from '@/features/trainings/domain/status';
import type { TrainingSession } from '@/lib/database.types';

const DEADLINE = '2026-11-14T05:00:00.000Z';
const BEFORE_DEADLINE = new Date('2026-11-13T12:00:00Z');
const AFTER_DEADLINE = new Date('2026-11-14T05:30:00Z');

function makeSession(overrides: Partial<TrainingSession> = {}): TrainingSession {
  return {
    id: 'session-1',
    community_id: 'community-1',
    organizer_id: 'user-1',
    title: 'Saturday long run',
    description: null,
    activity_type: 'running',
    starts_at: '2026-11-14T07:00:00.000Z',
    ends_at: '2026-11-14T08:30:00.000Z',
    rsvp_deadline: DEADLINE,
    timezone: 'Europe/Bucharest',
    location_name: 'Herastrau Park',
    address: null,
    latitude: null,
    longitude: null,
    map_url: null,
    meeting_instructions: null,
    min_participants: 10,
    max_participants: null,
    going_count: 0,
    status: 'scheduled',
    cancel_reason: null,
    decided_at: null,
    cancelled_at: null,
    cancelled_by: null,
    attendance_finalized_at: null,
    attendance_finalized_by: null,
    created_at: '2026-11-01T10:00:00.000Z',
    updated_at: '2026-11-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('deriveDisplayStatus (ARCHITECTURE.md section 6)', () => {
  it('scheduled, going < min → awaiting_minimum', () => {
    expect(deriveDisplayStatus(makeSession({ going_count: 3 }), BEFORE_DEADLINE)).toBe(
      'awaiting_minimum',
    );
  });

  it('scheduled, going ≥ min → minimum_reached', () => {
    expect(deriveDisplayStatus(makeSession({ going_count: 12 }), BEFORE_DEADLINE)).toBe(
      'minimum_reached',
    );
  });

  it.each<[string, number, TrainingDisplayStatus]>([
    ['zero going', 0, 'awaiting_minimum'],
    ['min − 1', 9, 'awaiting_minimum'],
    ['exactly min', 10, 'minimum_reached'],
    ['min + 1', 11, 'minimum_reached'],
    ['at max', 20, 'minimum_reached'],
  ])('threshold: %s', (_label, going, expected) => {
    const session = makeSession({ going_count: going, min_participants: 10, max_participants: 20 });
    expect(deriveDisplayStatus(session, BEFORE_DEADLINE)).toBe(expected);
  });

  it('handles a minimum of 1', () => {
    const session = makeSession({ min_participants: 1 });
    expect(deriveDisplayStatus({ ...session, going_count: 0 }, BEFORE_DEADLINE)).toBe(
      'awaiting_minimum',
    );
    expect(deriveDisplayStatus({ ...session, going_count: 1 }, BEFORE_DEADLINE)).toBe(
      'minimum_reached',
    );
  });

  it('scheduled, deadline passed and not yet decided → finalizing, whatever the count', () => {
    expect(deriveDisplayStatus(makeSession({ going_count: 3 }), AFTER_DEADLINE)).toBe('finalizing');
    expect(deriveDisplayStatus(makeSession({ going_count: 12 }), AFTER_DEADLINE)).toBe(
      'finalizing',
    );
  });

  it('switches to finalizing exactly at the deadline, like the server (now >= deadline)', () => {
    const session = makeSession({ going_count: 12 });
    expect(deriveDisplayStatus(session, new Date('2026-11-14T04:59:59.999Z'))).toBe(
      'minimum_reached',
    );
    expect(deriveDisplayStatus(session, new Date(DEADLINE))).toBe('finalizing');
  });

  it('reads a deadline in the +00:00 form Postgres returns', () => {
    const session = makeSession({ rsvp_deadline: '2026-11-14T05:00:00+00:00' });
    expect(deriveDisplayStatus(session, BEFORE_DEADLINE)).toBe('awaiting_minimum');
    expect(deriveDisplayStatus(session, AFTER_DEADLINE)).toBe('finalizing');
  });

  it('confirmed → confirmed, before or after the deadline and whatever the count', () => {
    const session = makeSession({ status: 'confirmed', going_count: 2, decided_at: DEADLINE });
    expect(deriveDisplayStatus(session, BEFORE_DEADLINE)).toBe('confirmed');
    expect(deriveDisplayStatus(session, AFTER_DEADLINE)).toBe('confirmed');
  });

  it('cancelled for insufficient participation → cancelled_insufficient', () => {
    const session = makeSession({
      status: 'cancelled',
      cancel_reason: 'insufficient_participation',
    });
    expect(deriveDisplayStatus(session, AFTER_DEADLINE)).toBe('cancelled_insufficient');
  });

  it('cancelled by the organizer → cancelled_organizer, even with the minimum reached', () => {
    const session = makeSession({ status: 'cancelled', cancel_reason: 'organizer', going_count: 15 });
    expect(deriveDisplayStatus(session, BEFORE_DEADLINE)).toBe('cancelled_organizer');
    expect(deriveDisplayStatus(session, AFTER_DEADLINE)).toBe('cancelled_organizer');
  });

  it('completed → completed', () => {
    expect(deriveDisplayStatus(makeSession({ status: 'completed' }), AFTER_DEADLINE)).toBe(
      'completed',
    );
  });

  it('never reports a stored decision as provisional', () => {
    const provisional: TrainingDisplayStatus[] = [
      'awaiting_minimum',
      'minimum_reached',
      'finalizing',
    ];
    for (const status of ['confirmed', 'cancelled', 'completed'] as const) {
      for (const now of [BEFORE_DEADLINE, AFTER_DEADLINE]) {
        const session = makeSession({
          status,
          cancel_reason: status === 'cancelled' ? 'organizer' : null,
        });
        expect(provisional).not.toContain(deriveDisplayStatus(session, now));
      }
    }
  });
});

describe('participationSummary', () => {
  it('matches the spec example: 7 of 10, 3 more needed', () => {
    const summary = participationSummary(makeSession({ going_count: 7, min_participants: 10 }));
    expect(summary).toEqual({
      going: 7,
      min: 10,
      max: null,
      remainingToMin: 3,
      spotsLeft: null,
      isFull: false,
      text: '7 / 10 confirmed',
      needText: '3 more participants needed',
      spotsText: null,
    });
  });

  it.each([
    [0, 10, '10 more participants needed'],
    [8, 10, '2 more participants needed'],
    [9, 10, '1 more participant needed'],
    [10, 10, null],
    [11, 10, null],
    [0, 1, '1 more participant needed'],
    [1, 1, null],
  ])('needText for %i going with a minimum of %i', (going, min, expected) => {
    const summary = participationSummary(makeSession({ going_count: going, min_participants: min }));
    expect(summary.needText).toBe(expected);
    expect(summary.remainingToMin).toBe(Math.max(0, min - going));
  });

  it.each([
    [0, 20, 20, false, '20 spots left'],
    [9, 20, 11, false, '11 spots left'],
    [10, 20, 10, false, '10 spots left'],
    [18, 20, 2, false, '2 spots left'],
    [19, 20, 1, false, '1 spot left'],
    [20, 20, 0, true, 'Full'],
  ])('capacity for %i going with a maximum of %i', (going, max, spotsLeft, isFull, spotsText) => {
    const summary = participationSummary(
      makeSession({ going_count: going, min_participants: 10, max_participants: max }),
    );
    expect(summary.spotsLeft).toBe(spotsLeft);
    expect(summary.isFull).toBe(isFull);
    expect(summary.spotsText).toBe(spotsText);
  });

  it('is never full without a maximum', () => {
    const summary = participationSummary(makeSession({ going_count: 500 }));
    expect(summary.isFull).toBe(false);
    expect(summary.spotsLeft).toBeNull();
    expect(summary.spotsText).toBeNull();
  });

  it('handles max equal to min', () => {
    const summary = participationSummary(
      makeSession({ going_count: 10, min_participants: 10, max_participants: 10 }),
    );
    expect(summary.isFull).toBe(true);
    expect(summary.needText).toBeNull();
    expect(summary.text).toBe('10 / 10 confirmed');
  });

  it('keeps the minimum as the denominator once it is exceeded', () => {
    expect(
      participationSummary(makeSession({ going_count: 12, min_participants: 10 })).text,
    ).toBe('12 / 10 confirmed');
  });

  it('never shows negative numbers for an out-of-range count', () => {
    const over = participationSummary(
      makeSession({ going_count: 22, min_participants: 10, max_participants: 20 }),
    );
    expect(over.spotsLeft).toBe(0);
    expect(over.isFull).toBe(true);

    const under = participationSummary(makeSession({ going_count: -1, min_participants: 10 }));
    expect(under.going).toBe(0);
    expect(under.text).toBe('0 / 10 confirmed');
    expect(under.remainingToMin).toBe(10);
  });
});

describe('upcoming / past', () => {
  const start = '2026-11-14T07:00:00.000Z';
  const end = '2026-11-14T08:30:00.000Z';

  it('is upcoming until its end, then past', () => {
    const session = makeSession({ starts_at: start, ends_at: end });
    expect(isUpcoming(session, new Date('2026-11-14T06:00:00Z'))).toBe(true);
    // In progress.
    expect(isUpcoming(session, new Date('2026-11-14T08:00:00Z'))).toBe(true);
    expect(isPast(session, new Date('2026-11-14T08:29:59Z'))).toBe(false);
    expect(isPast(session, new Date(end))).toBe(true);
    expect(isUpcoming(session, new Date(end))).toBe(false);
  });

  it('uses start + 2 hours when there is no end', () => {
    const session = makeSession({ starts_at: start, ends_at: null });
    expect(isPast(session, new Date('2026-11-14T08:59:59Z'))).toBe(false);
    expect(isPast(session, new Date('2026-11-14T09:00:00Z'))).toBe(true);
  });

  it('treats a completed session as past regardless of time', () => {
    const session = makeSession({ status: 'completed' });
    expect(isPast(session, new Date('2026-11-01T00:00:00Z'))).toBe(true);
  });

  it('keeps a cancelled future session in upcoming', () => {
    const session = makeSession({ status: 'cancelled', cancel_reason: 'organizer' });
    expect(isUpcoming(session, new Date('2026-11-13T00:00:00Z'))).toBe(true);
    expect(isPast(session, new Date('2026-11-15T00:00:00Z'))).toBe(true);
  });

  it('is always exactly one of upcoming or past', () => {
    for (const now of ['2026-11-13T00:00:00Z', start, end, '2026-11-15T00:00:00Z']) {
      for (const status of ['scheduled', 'confirmed', 'cancelled', 'completed'] as const) {
        const session = makeSession({ status });
        expect(isUpcoming(session, new Date(now))).toBe(!isPast(session, new Date(now)));
      }
    }
  });

  const now = new Date('2026-11-14T00:00:00Z');
  const sessions = [
    makeSession({ id: 'next-week', starts_at: '2026-11-21T07:00:00Z', ends_at: null }),
    makeSession({ id: 'last-month', starts_at: '2026-10-10T07:00:00Z', ends_at: null }),
    makeSession({ id: 'today', starts_at: '2026-11-14T07:00:00Z', ends_at: null }),
    makeSession({ id: 'yesterday', starts_at: '2026-11-13T07:00:00Z', ends_at: null }),
    makeSession({ id: 'tomorrow', starts_at: '2026-11-15T07:00:00Z', ends_at: null }),
  ];

  it('splits and sorts: upcoming soonest first, past most recent first', () => {
    const { upcoming, past } = splitSessions(sessions, now);
    expect(upcoming.map((s) => s.id)).toEqual(['today', 'tomorrow', 'next-week']);
    expect(past.map((s) => s.id)).toEqual(['yesterday', 'last-month']);
  });

  it('does not mutate its input', () => {
    const before = sessions.map((s) => s.id);
    splitSessions(sessions, now);
    expect(sessions.map((s) => s.id)).toEqual(before);
  });

  it('breaks start-time ties by id, in both directions', () => {
    const a = makeSession({ id: 'a' });
    const b = makeSession({ id: 'b' });
    expect(compareUpcoming(a, b)).toBeLessThan(0);
    expect(compareUpcoming(b, a)).toBeGreaterThan(0);
    expect(compareUpcoming(a, a)).toBe(0);
    expect(comparePast(a, b)).toBeGreaterThan(0);
    expect([b, a].sort(compareUpcoming).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('compares instants, not strings', () => {
    const earlier = makeSession({ id: 'x', starts_at: '2026-11-14T09:00:00+02:00' }); // 07:00Z
    const later = makeSession({ id: 'y', starts_at: '2026-11-14T08:00:00Z' });
    expect(compareUpcoming(earlier, later)).toBeLessThan(0);
  });

  it('nextSession skips cancelled sessions and returns null when nothing is on', () => {
    const list = [
      makeSession({
        id: 'cancelled-today',
        starts_at: '2026-11-14T07:00:00Z',
        ends_at: null,
        status: 'cancelled',
        cancel_reason: 'organizer',
      }),
      makeSession({ id: 'tomorrow', starts_at: '2026-11-15T07:00:00Z', ends_at: null }),
      makeSession({ id: 'yesterday', starts_at: '2026-11-13T07:00:00Z', ends_at: null }),
    ];
    expect(nextSession(list, now)?.id).toBe('tomorrow');
    expect(nextSession([list[0], list[2]], now)).toBeNull();
    expect(nextSession([], now)).toBeNull();
  });
});
