import { describe, expect, it } from 'vitest';

import {
  applyOptimisticRsvp,
  canChangeRsvp,
  rsvpBlockedMessage,
  type RsvpBlockedReason,
} from '@/features/rsvp/domain/rsvp';
import type { RsvpResponse, TrainingSession } from '@/lib/database.types';

const DEADLINE = '2026-11-14T05:00:00.000Z';
const OPEN = new Date('2026-11-13T12:00:00Z');
const LATE = new Date('2026-11-14T05:00:01Z');

type RsvpSession = Pick<
  TrainingSession,
  'status' | 'rsvp_deadline' | 'going_count' | 'max_participants' | 'event_kind'
>;

function makeSession(overrides: Partial<RsvpSession> = {}): RsvpSession {
  return {
    status: 'scheduled',
    event_kind: 'training',
    rsvp_deadline: DEADLINE,
    going_count: 5,
    max_participants: 10,
    ...overrides,
  };
}

const RESPONSES: RsvpResponse[] = ['going', 'not_going', 'no_response'];

describe('canChangeRsvp', () => {
  it('allows changes while scheduled and before the deadline', () => {
    expect(canChangeRsvp(makeSession(), OPEN)).toEqual({ allowed: true });
    for (const from of [...RESPONSES, null, undefined]) {
      for (const to of RESPONSES) {
        expect(canChangeRsvp(makeSession(), OPEN, { from, to })).toEqual({ allowed: true });
      }
    }
  });

  it('closes exactly at the deadline, like the server (now >= rsvp_deadline)', () => {
    expect(canChangeRsvp(makeSession(), new Date('2026-11-14T04:59:59.999Z'))).toEqual({
      allowed: true,
    });
    expect(canChangeRsvp(makeSession(), new Date(DEADLINE))).toEqual({
      allowed: false,
      reason: 'closed',
    });
    expect(canChangeRsvp(makeSession(), LATE)).toEqual({ allowed: false, reason: 'closed' });
  });

  it('is closed once confirmed, even before the deadline', () => {
    expect(canChangeRsvp(makeSession({ status: 'confirmed' }), OPEN)).toEqual({
      allowed: false,
      reason: 'closed',
    });
  });

  it('reports cancelled and completed as their own reasons, before the deadline check', () => {
    for (const now of [OPEN, LATE]) {
      expect(canChangeRsvp(makeSession({ status: 'cancelled' }), now)).toEqual({
        allowed: false,
        reason: 'cancelled',
      });
      expect(canChangeRsvp(makeSession({ status: 'completed' }), now)).toEqual({
        allowed: false,
        reason: 'completed',
      });
    }
  });

  describe('full', () => {
    const full = makeSession({ going_count: 10, max_participants: 10 });

    it('blocks switching to going from anything else', () => {
      for (const from of ['not_going', 'no_response', null, undefined] as const) {
        expect(canChangeRsvp(full, OPEN, { from, to: 'going' })).toEqual({
          allowed: false,
          reason: 'full',
        });
      }
    });

    it('does not block a member who is already going', () => {
      expect(canChangeRsvp(full, OPEN, { from: 'going', to: 'going' })).toEqual({ allowed: true });
      expect(canChangeRsvp(full, OPEN, { from: 'going', to: 'not_going' })).toEqual({
        allowed: true,
      });
    });

    it('does not block declining', () => {
      expect(canChangeRsvp(full, OPEN, { from: 'no_response', to: 'not_going' })).toEqual({
        allowed: true,
      });
      expect(canChangeRsvp(full, OPEN, { from: 'not_going', to: 'no_response' })).toEqual({
        allowed: true,
      });
    });

    it('is not reported when no change is given', () => {
      expect(canChangeRsvp(full, OPEN)).toEqual({ allowed: true });
    });

    it.each([
      [9, 10, true],
      [10, 10, false],
      [11, 10, false],
      [0, 1, true],
      [1, 1, false],
    ])('%i going of max %i → can join: %s', (going, max, allowed) => {
      const session = makeSession({ going_count: going, max_participants: max });
      expect(canChangeRsvp(session, OPEN, { from: 'no_response', to: 'going' }).allowed).toBe(
        allowed,
      );
    });

    it('never applies without a maximum', () => {
      const session = makeSession({ going_count: 9999, max_participants: null });
      expect(canChangeRsvp(session, OPEN, { from: null, to: 'going' })).toEqual({ allowed: true });
    });

    it('gives way to closed and cancelled', () => {
      expect(canChangeRsvp(full, LATE, { from: null, to: 'going' })).toEqual({
        allowed: false,
        reason: 'closed',
      });
      expect(
        canChangeRsvp({ ...full, status: 'cancelled' }, OPEN, { from: null, to: 'going' }),
      ).toEqual({ allowed: false, reason: 'cancelled' });
    });
  });

  it('has a message for every reason', () => {
    const reasons: RsvpBlockedReason[] = ['cancelled', 'completed', 'closed', 'full'];
    const messages = reasons.map((reason) => rsvpBlockedMessage(reason));
    expect(new Set(messages).size).toBe(reasons.length);
    for (const message of messages) expect(message.length).toBeGreaterThan(5);
  });
});

describe('applyOptimisticRsvp', () => {
  const session = { id: 'session-1', going_count: 5, title: 'Run' };

  it.each<[RsvpResponse | null | undefined, RsvpResponse, number]>([
    ['no_response', 'going', 6],
    ['not_going', 'going', 6],
    [null, 'going', 6],
    [undefined, 'going', 6],
    ['going', 'not_going', 4],
    ['going', 'no_response', 4],
    ['going', 'going', 5],
    ['not_going', 'no_response', 5],
    ['no_response', 'not_going', 5],
    [null, 'not_going', 5],
    ['not_going', 'not_going', 5],
  ])('%s → %s gives %i going', (previous, next, expected) => {
    expect(applyOptimisticRsvp(session, previous, next).going_count).toBe(expected);
  });

  it('does not mutate the session and keeps its other fields', () => {
    const next = applyOptimisticRsvp(session, 'no_response', 'going');
    expect(session.going_count).toBe(5);
    expect(next).not.toBe(session);
    expect(next).toEqual({ id: 'session-1', going_count: 6, title: 'Run' });
  });

  it('returns the same object when the count does not change', () => {
    expect(applyOptimisticRsvp(session, 'going', 'going')).toBe(session);
    expect(applyOptimisticRsvp(session, 'not_going', 'no_response')).toBe(session);
  });

  it('is exactly reversible for every pair of responses and every count', () => {
    const states = [...RESPONSES, null, undefined];
    for (const count of [0, 1, 5, 10]) {
      for (const previous of states) {
        for (const next of states) {
          const original = { going_count: count, max_participants: 10 };
          const applied = applyOptimisticRsvp(original, previous, next);
          const rolledBack = applyOptimisticRsvp(applied, next, previous);
          expect(rolledBack).toEqual(original);
        }
      }
    }
  });

  it('stays reversible even from a stale count of zero', () => {
    const stale = { going_count: 0 };
    const applied = applyOptimisticRsvp(stale, 'going', 'not_going');
    expect(applyOptimisticRsvp(applied, 'not_going', 'going')).toEqual(stale);
  });

  it('composes: a chain of changes equals the single net change', () => {
    const chained = applyOptimisticRsvp(
      applyOptimisticRsvp(applyOptimisticRsvp(session, 'no_response', 'going'), 'going', 'not_going'),
      'not_going',
      'going',
    );
    expect(chained.going_count).toBe(applyOptimisticRsvp(session, 'no_response', 'going').going_count);
  });
});
