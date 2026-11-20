/**
 * P1: status, participation text and RSVP rules per event kind. A training keeps the
 * minimum-driven statuses; every other kind is created confirmed and shows whether
 * registration is open. The clock here is display-only, like in the app.
 */
import { describe, expect, it } from 'vitest';

import { QueryClient } from '@tanstack/react-query';

import { trainingKeys } from '@/features/trainings/api/keys';
import { applyRsvpToCache, rollbackRsvpInCache } from '@/features/rsvp/domain/rsvpCache';
import { canChangeRsvp, rsvpBlockedMessage } from '@/features/rsvp/domain/rsvp';
import type { EventKind, SessionStatus, TrainingSession } from '@/lib/database.types';
import { statusMeta, TRAINING_DISPLAY_STATUSES } from '@/ui/theme/status';

import {
  participationLines,
  isProvisional,
  statusBadgeLabel,
  statusExplanation,
} from './presentation';
import { deriveDisplayStatus, participationSummary } from './status';

const DEADLINE = '2026-11-14T05:00:00.000Z';
const BEFORE = new Date('2026-11-13T12:00:00Z');
const AT_DEADLINE = new Date(DEADLINE);
const AFTER = new Date('2026-11-14T05:30:00Z');

type Fields = Pick<
  TrainingSession,
  | 'status'
  | 'cancel_reason'
  | 'going_count'
  | 'min_participants'
  | 'max_participants'
  | 'rsvp_deadline'
  | 'event_kind'
>;

function event(kind: EventKind, overrides: Partial<Fields> = {}): Fields {
  return {
    status: kind === 'training' ? 'scheduled' : 'confirmed',
    cancel_reason: null,
    going_count: 3,
    min_participants: kind === 'training' ? 5 : null,
    max_participants: null,
    rsvp_deadline: DEADLINE,
    event_kind: kind,
    ...overrides,
  };
}

const NON_TRAINING: EventKind[] = ['race', 'sports_event', 'social'];

describe('deriveDisplayStatus per kind', () => {
  it.each(NON_TRAINING)('%s: registration is open until the deadline, then closed', (kind) => {
    expect(deriveDisplayStatus(event(kind), BEFORE)).toBe('registration_open');
    expect(deriveDisplayStatus(event(kind), new Date('2026-11-14T04:59:59.999Z'))).toBe('registration_open');
    expect(deriveDisplayStatus(event(kind), AT_DEADLINE)).toBe('registration_closed');
    expect(deriveDisplayStatus(event(kind), AFTER)).toBe('registration_closed');
  });

  it.each(NON_TRAINING)('%s: never shows the minimum-driven statuses, whatever the count', (kind) => {
    const seen = new Set<string>();
    for (const going of [0, 1, 4, 5, 50]) {
      for (const now of [BEFORE, AFTER]) {
        seen.add(deriveDisplayStatus(event(kind, { going_count: going }), now));
      }
    }
    expect([...seen].sort()).toEqual(['registration_closed', 'registration_open']);
  });

  it.each(NON_TRAINING)('%s: cancelled and completed read as for a training', (kind) => {
    expect(deriveDisplayStatus(event(kind, { status: 'cancelled', cancel_reason: 'organizer' }), BEFORE)).toBe(
      'cancelled_organizer',
    );
    expect(deriveDisplayStatus(event(kind, { status: 'completed' }), AFTER)).toBe('completed');
  });

  it('a training is unchanged: awaiting, reached, finalizing, then the server decision', () => {
    expect(deriveDisplayStatus(event('training', { going_count: 2 }), BEFORE)).toBe('awaiting_minimum');
    expect(deriveDisplayStatus(event('training', { going_count: 5 }), BEFORE)).toBe('minimum_reached');
    expect(deriveDisplayStatus(event('training', { going_count: 5 }), AFTER)).toBe('finalizing');
    expect(deriveDisplayStatus(event('training', { status: 'confirmed' }), AFTER)).toBe('confirmed');
    expect(
      deriveDisplayStatus(
        event('training', { status: 'cancelled', cancel_reason: 'insufficient_participation' }),
        AFTER,
      ),
    ).toBe('cancelled_insufficient');
  });

  it('a confirmed training is "Confirmed", a confirmed race is not', () => {
    expect(deriveDisplayStatus(event('training', { status: 'confirmed' }), BEFORE)).toBe('confirmed');
    expect(deriveDisplayStatus(event('race', { status: 'confirmed' }), BEFORE)).not.toBe('confirmed');
  });
});

describe('the two registration statuses in the UI map', () => {
  it('are known to the UI kit with distinct glyphs, labels and fills', () => {
    expect(TRAINING_DISPLAY_STATUSES).toContain('registration_open');
    expect(TRAINING_DISPLAY_STATUSES).toContain('registration_closed');
    expect(statusMeta.registration_open.label).toBe('Registration open');
    expect(statusMeta.registration_closed.label).toBe('Registration closed');
    expect(statusMeta.registration_open.icon).not.toBe(statusMeta.registration_closed.icon);
    expect(statusMeta.registration_open.visual).not.toBe(statusMeta.registration_closed.visual);
  });

  it('every status keeps its own glyph + label pair (never colour alone)', () => {
    const pairs = TRAINING_DISPLAY_STATUSES.map((s) => `${statusMeta[s].icon}|${statusMeta[s].label}`);
    expect(new Set(pairs).size).toBe(TRAINING_DISPLAY_STATUSES.length);
    expect(new Set(TRAINING_DISPLAY_STATUSES.map((s) => statusMeta[s].label)).size).toBe(
      TRAINING_DISPLAY_STATUSES.length,
    );
  });
});

describe('participation without a minimum', () => {
  it('"N going", and "N of MAX going" with a maximum', () => {
    expect(participationSummary({ going_count: 12, min_participants: null, max_participants: null }).text).toBe(
      '12 going',
    );
    expect(participationSummary({ going_count: 12, min_participants: null, max_participants: 30 }).text).toBe(
      '12 of 30 going',
    );
  });

  it('has nothing to reach: no "more needed", min is null, spots still counted', () => {
    const summary = participationSummary({ going_count: 29, min_participants: null, max_participants: 30 });
    expect(summary.min).toBeNull();
    expect(summary.remainingToMin).toBe(0);
    expect(summary.needText).toBeNull();
    expect(summary.spotsText).toBe('1 spot left');
    expect(participationSummary({ going_count: 30, min_participants: null, max_participants: 30 }).isFull).toBe(
      true,
    );
  });

  it('a training still counts against its minimum', () => {
    expect(participationSummary({ going_count: 7, min_participants: 10, max_participants: null }).text).toBe(
      '7 / 10 confirmed',
    );
  });

  it('shows free places only while registration is open', () => {
    const summary = participationSummary({ going_count: 12, min_participants: null, max_participants: 30 });
    expect(participationLines(summary, 'registration_open')).toEqual({
      count: '12 of 30 going',
      need: null,
      spots: '18 spots left',
    });
    expect(participationLines(summary, 'registration_closed').spots).toBeNull();
    expect(participationLines(summary, 'registration_closed').count).toBe('12 of 30 going');
    expect(participationLines(summary, 'cancelled_organizer').spots).toBeNull();
  });
});

describe('wording of the registration statuses', () => {
  const none = { remainingToMin: 0 };

  it('is final (not provisional) and explains itself', () => {
    expect(isProvisional('registration_open')).toBe(false);
    expect(isProvisional('registration_closed')).toBe(false);
    expect(statusExplanation('registration_open', none, 'Sat 14 Nov, 07:00')).toMatch(/open until Sat 14 Nov, 07:00/);
    expect(statusExplanation('registration_closed', none, 'x')).toMatch(/closed/i);
    expect(statusBadgeLabel('registration_open', none)).toBeUndefined();
  });

  it('says "event" for what happened, not "training"', () => {
    expect(statusExplanation('completed', none, 'x')).toBe('This event has taken place.');
  });
});

describe('canChangeRsvp per kind', () => {
  function rsvp(kind: EventKind, status: SessionStatus, extra: Partial<TrainingSession> = {}) {
    return {
      event_kind: kind,
      status,
      rsvp_deadline: DEADLINE,
      going_count: 3,
      max_participants: null as number | null,
      ...extra,
    };
  }

  it.each(NON_TRAINING)('%s: answers are accepted while confirmed and before the deadline', (kind) => {
    expect(canChangeRsvp(rsvp(kind, 'confirmed'), BEFORE)).toEqual({ allowed: true });
    expect(canChangeRsvp(rsvp(kind, 'confirmed'), new Date('2026-11-14T04:59:59.999Z'))).toEqual({
      allowed: true,
    });
  });

  it.each(NON_TRAINING)('%s: closed at the deadline, cancelled and completed explain themselves', (kind) => {
    expect(canChangeRsvp(rsvp(kind, 'confirmed'), AT_DEADLINE)).toEqual({ allowed: false, reason: 'closed' });
    expect(canChangeRsvp(rsvp(kind, 'cancelled'), BEFORE)).toEqual({ allowed: false, reason: 'cancelled' });
    expect(canChangeRsvp(rsvp(kind, 'completed'), BEFORE)).toEqual({ allowed: false, reason: 'completed' });
  });

  it.each(NON_TRAINING)('%s: capacity blocks only switching to going', (kind) => {
    const full = rsvp(kind, 'confirmed', { going_count: 20, max_participants: 20 });
    expect(canChangeRsvp(full, BEFORE, { from: 'no_response', to: 'going' })).toEqual({
      allowed: false,
      reason: 'full',
    });
    expect(canChangeRsvp(full, BEFORE, { from: 'going', to: 'not_going' })).toEqual({ allowed: true });
    expect(canChangeRsvp(full, BEFORE, { from: 'going', to: 'going' })).toEqual({ allowed: true });
  });

  it('a non-training event never uses the "closed because confirmed" rule of a training', () => {
    expect(canChangeRsvp(rsvp('training', 'confirmed'), BEFORE)).toEqual({ allowed: false, reason: 'closed' });
    expect(canChangeRsvp(rsvp('race', 'confirmed'), BEFORE)).toEqual({ allowed: true });
  });

  it('a training still answers while scheduled and not after the deadline', () => {
    expect(canChangeRsvp(rsvp('training', 'scheduled'), BEFORE)).toEqual({ allowed: true });
    expect(canChangeRsvp(rsvp('training', 'scheduled'), AFTER)).toEqual({ allowed: false, reason: 'closed' });
  });

  it('a non-training event is never open while "scheduled" (the server never stores that)', () => {
    expect(canChangeRsvp(rsvp('social', 'scheduled'), BEFORE)).toEqual({ allowed: false, reason: 'closed' });
  });

  it('says "Registration is closed" for events and "Responses are closed" for trainings', () => {
    expect(rsvpBlockedMessage('closed', 'race')).toBe('Registration is closed.');
    expect(rsvpBlockedMessage('closed', 'training')).toBe('Responses are closed.');
    expect(rsvpBlockedMessage('closed')).toBe('Responses are closed.');
    expect(rsvpBlockedMessage('full', 'social')).toBe('This event is full.');
  });
});

describe('optimistic RSVP on non-training events (real QueryClient)', () => {
  const COMMUNITY = 'community-1';
  const USER = 'user-1';

  function session(id: string, kind: EventKind, going: number): TrainingSession {
    return {
      id,
      community_id: COMMUNITY,
      organizer_id: 'o',
      title: id,
      description: null,
      activity_type: 'other',
      event_kind: kind,
      event_subtype: 'other',
      starts_at: '2026-11-14T07:00:00+00:00',
      ends_at: null,
      rsvp_deadline: DEADLINE,
      timezone: 'Europe/Bucharest',
      location_name: 'Park',
      address: null,
      latitude: null,
      longitude: null,
      map_url: null,
      meeting_instructions: null,
      min_participants: kind === 'training' ? 5 : null,
      max_participants: 10,
      distance_km: null,
      elevation_gain_m: null,
      obstacle_count: null,
      event_notes: null,
      going_count: going,
      status: kind === 'training' ? 'scheduled' : 'confirmed',
      cancel_reason: null,
      cancellation_reason: null,
      decided_at: null,
      cancelled_at: null,
      cancelled_by: null,
      attendance_finalized_at: null,
      attendance_finalized_by: null,
      created_at: '2026-11-01T10:00:00+00:00',
      updated_at: '2026-11-01T10:00:00+00:00',
    };
  }

  it('going to a race and a social event moves the count, and a rollback restores it exactly', () => {
    const queryClient = new QueryClient();
    const list = [session('race', 'race', 4), session('social', 'social', 0), session('t', 'training', 2)];
    queryClient.setQueryData(trainingKeys.list(COMMUNITY), list);
    queryClient.setQueryData(trainingKeys.detail('race'), list[0]);

    const snapshot = applyRsvpToCache(queryClient, {
      sessionId: 'race',
      userId: USER,
      previous: 'no_response',
      next: 'going',
    });
    const after = queryClient.getQueryData<TrainingSession[]>(trainingKeys.list(COMMUNITY)) ?? [];
    expect(after.map((s) => s.going_count)).toEqual([5, 0, 2]);
    expect(queryClient.getQueryData<TrainingSession>(trainingKeys.detail('race'))?.going_count).toBe(5);
    // The shown status text follows the cache: "5 of 10 going".
    expect(participationSummary(after[0]).text).toBe('5 of 10 going');

    rollbackRsvpInCache(queryClient, snapshot);
    const restored = queryClient.getQueryData<TrainingSession[]>(trainingKeys.list(COMMUNITY)) ?? [];
    expect(restored.map((s) => s.going_count)).toEqual([4, 0, 2]);
    expect(queryClient.getQueryData<TrainingSession>(trainingKeys.detail('race'))?.going_count).toBe(4);
  });
});
