/**
 * QA (M1-Q1 part 2): the Milestone 1 minimum / status rules, checked against
 * the product wording rather than against the implementation: exact strings,
 * every derived status, deadline boundaries, and "provisional looks different
 * from final".
 */
import { describe, expect, it } from 'vitest';

import {
  isProvisional,
  participationLines,
  statusBadgeLabel,
  statusExplanation,
} from '@/features/trainings/domain/presentation';
import {
  deriveDisplayStatus,
  isPast,
  nextSession,
  participationSummary,
  splitSessions,
  type TrainingDisplayStatus,
} from '@/features/trainings/domain/status';
import { canChangeRsvp } from '@/features/rsvp/domain/rsvp';
import type { SessionStatus, TrainingSession } from '@/lib/database.types';
import { statusMeta, TRAINING_DISPLAY_STATUSES } from '@/ui/theme/status';

const DEADLINE = '2026-11-14T05:00:00.000Z';
const at = (iso: string) => new Date(iso);

function fields(overrides: Partial<Pick<TrainingSession, 'status' | 'cancel_reason' | 'going_count' | 'min_participants' | 'rsvp_deadline'>> = {}) {
  return {
    status: 'scheduled' as SessionStatus,
    cancel_reason: null,
    going_count: 7,
    min_participants: 10,
    rsvp_deadline: DEADLINE,
    ...overrides,
  };
}

describe('the product wording', () => {
  it('"7 / 10 confirmed" and "3 more participants needed"', () => {
    const summary = participationSummary({ going_count: 7, min_participants: 10, max_participants: null });
    expect(summary.text).toBe('7 / 10 confirmed');
    expect(summary.needText).toBe('3 more participants needed');
    expect(statusBadgeLabel('awaiting_minimum', summary)).toBe('3 more needed');
  });

  it('singular: "1 more participant needed"', () => {
    expect(participationSummary({ going_count: 9, min_participants: 10, max_participants: null }).needText).toBe(
      '1 more participant needed',
    );
  });

  it('no "more needed" text once the minimum is reached or passed', () => {
    for (const going of [10, 11, 50]) {
      const summary = participationSummary({ going_count: going, min_participants: 10, max_participants: null });
      expect(summary.needText).toBeNull();
      expect(participationLines(summary, 'minimum_reached').need).toBeNull();
    }
  });

  it('the count line never claims "N / min confirmed" above the minimum', () => {
    const summary = participationSummary({ going_count: 12, min_participants: 10, max_participants: 20 });
    expect(participationLines(summary, 'minimum_reached').count).toBe('12 confirmed (minimum 10)');
  });

  it('"insufficient participation" and "cancelled by organizer" are different words', () => {
    const none = { remainingToMin: 0 };
    const a = statusExplanation('cancelled_insufficient', none, 'x');
    const b = statusExplanation('cancelled_organizer', none, 'x');
    expect(a).not.toBe(b);
    expect(a).toMatch(/too few/i);
    expect(b).toMatch(/organizer/i);
    expect(statusMeta.cancelled_insufficient.label).not.toBe(statusMeta.cancelled_organizer.label);
    expect(statusMeta.cancelled_organizer.label).not.toBe(statusMeta.completed.label);
  });
});

describe('every stored state maps to exactly one display status', () => {
  const cases: [string, ReturnType<typeof fields>, string, TrainingDisplayStatus][] = [
    ['scheduled below min', fields({ going_count: 9 }), '2026-11-13T12:00:00Z', 'awaiting_minimum'],
    ['scheduled at min', fields({ going_count: 10 }), '2026-11-13T12:00:00Z', 'minimum_reached'],
    ['scheduled above min', fields({ going_count: 30 }), '2026-11-13T12:00:00Z', 'minimum_reached'],
    ['scheduled, 1 ms before deadline', fields(), '2026-11-14T04:59:59.999Z', 'awaiting_minimum'],
    ['scheduled, exactly at deadline', fields(), DEADLINE, 'finalizing'],
    ['scheduled, past deadline, enough people', fields({ going_count: 12 }), '2026-11-14T05:00:30Z', 'finalizing'],
    ['confirmed', fields({ status: 'confirmed', going_count: 12 }), '2026-11-14T06:00:00Z', 'confirmed'],
    ['confirmed, before the deadline (organizer edit path)', fields({ status: 'confirmed' }), '2026-11-13T00:00:00Z', 'confirmed'],
    ['cancelled: insufficient', fields({ status: 'cancelled', cancel_reason: 'insufficient_participation' }), DEADLINE, 'cancelled_insufficient'],
    ['cancelled: organizer', fields({ status: 'cancelled', cancel_reason: 'organizer' }), '2026-11-12T00:00:00Z', 'cancelled_organizer'],
    ['completed', fields({ status: 'completed' }), '2026-11-15T00:00:00Z', 'completed'],
  ];
  it.each(cases)('%s', (_name, session, now, expected) => {
    expect(deriveDisplayStatus(session, at(now))).toBe(expected);
  });

  it('a cancelled session never shows as awaiting or confirmed, whatever the count and clock', () => {
    for (const going of [0, 9, 10, 99]) {
      for (const now of ['2026-11-01T00:00:00Z', DEADLINE, '2027-01-01T00:00:00Z']) {
        const status = deriveDisplayStatus(fields({ status: 'cancelled', cancel_reason: 'organizer', going_count: going }), at(now));
        expect(status).toBe('cancelled_organizer');
      }
    }
  });

  it('the displayed status of a decided session ignores the clock completely', () => {
    for (const stored of ['confirmed', 'completed'] as const) {
      const seen = new Set(['2000-01-01T00:00:00Z', DEADLINE, '2100-01-01T00:00:00Z'].map((now) => deriveDisplayStatus(fields({ status: stored }), at(now))));
      expect(seen.size).toBe(1);
    }
  });
});

describe('provisional is visibly different from final', () => {
  const provisional: TrainingDisplayStatus[] = ['awaiting_minimum', 'minimum_reached', 'finalizing'];
  const final: TrainingDisplayStatus[] = ['confirmed', 'cancelled_insufficient', 'cancelled_organizer', 'completed'];

  it('isProvisional matches the architecture table', () => {
    for (const status of provisional) expect(isProvisional(status)).toBe(true);
    for (const status of final) expect(isProvisional(status)).toBe(false);
  });

  it('Confirmed is not drawn like Minimum reached (filled versus dashed outline)', () => {
    expect(statusMeta.confirmed.visual).toBe('filled');
    expect(statusMeta.confirmed.dashed).toBe(false);
    expect(statusMeta.minimum_reached.visual).toBe('outlined');
    expect(statusMeta.minimum_reached.dashed).toBe(true);
    expect(statusMeta.confirmed.icon).not.toBe(statusMeta.minimum_reached.icon);
  });

  it('no two statuses share both a glyph and a label, and none relies on color alone', () => {
    const keys = TRAINING_DISPLAY_STATUSES.map((status) => `${statusMeta[status].icon}|${statusMeta[status].label}`);
    expect(new Set(keys).size).toBe(TRAINING_DISPLAY_STATUSES.length);
    const labels = TRAINING_DISPLAY_STATUSES.map((status) => statusMeta[status].label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const status of TRAINING_DISPLAY_STATUSES) expect(statusMeta[status].label.length).toBeGreaterThan(3);
  });

  it('every explanation sentence says whether it is final', () => {
    const s = { remainingToMin: 2 };
    expect(statusExplanation('awaiting_minimum', s, 'x')).toMatch(/not decided/i);
    expect(statusExplanation('minimum_reached', s, 'x')).toMatch(/not final/i);
    expect(statusExplanation('confirmed', s, 'x')).toMatch(/final/i);
  });
});

describe('Home / list sectioning near the edges', () => {
  const base = { id: 'a', starts_at: '2026-11-14T07:00:00Z', ends_at: null as string | null, status: 'scheduled' as SessionStatus };

  it('a session is upcoming up to its start and past from the start on (no end time)', () => {
    expect(isPast(base, at('2026-11-14T06:59:59.999Z'))).toBe(false);
    expect(isPast(base, at('2026-11-14T07:00:00Z'))).toBe(true);
  });

  it('with an end time it stays upcoming (running) until the end', () => {
    const running = { ...base, ends_at: '2026-11-14T08:30:00Z' };
    expect(isPast(running, at('2026-11-14T08:29:59Z'))).toBe(false);
    expect(isPast(running, at('2026-11-14T08:30:00Z'))).toBe(true);
  });

  it('a cancelled upcoming session is listed but never chosen as "next training"', () => {
    const cancelled = { ...base, id: 'c', status: 'cancelled' as SessionStatus };
    const later = { ...base, id: 'l', starts_at: '2026-11-15T07:00:00Z' };
    const now = at('2026-11-10T00:00:00Z');
    expect(splitSessions([cancelled, later], now).upcoming.map((s) => s.id)).toEqual(['c', 'l']);
    expect(nextSession([cancelled, later], now)?.id).toBe('l');
    expect(nextSession([cancelled], now)).toBeNull();
  });

  it('equal start times sort stably by id so a refetch never reshuffles cards', () => {
    const rows = ['d', 'b', 'c', 'a'].map((id) => ({ ...base, id }));
    const now = at('2026-11-10T00:00:00Z');
    const once = splitSessions(rows, now).upcoming.map((s) => s.id);
    const reversed = splitSessions([...rows].reverse(), now).upcoming.map((s) => s.id);
    expect(once).toEqual(['a', 'b', 'c', 'd']);
    expect(reversed).toEqual(once);
  });
});

describe('the RSVP control follows the stored state (advisory; server decides)', () => {
  const session = { status: 'scheduled' as SessionStatus, rsvp_deadline: DEADLINE, going_count: 3, max_participants: 4 };

  it('open, closed exactly at the deadline, never open for decided sessions', () => {
    expect(canChangeRsvp(session, at('2026-11-14T04:59:59.999Z')).allowed).toBe(true);
    expect(canChangeRsvp(session, at(DEADLINE)).allowed).toBe(false);
    for (const status of ['confirmed', 'cancelled', 'completed'] as const) {
      expect(canChangeRsvp({ ...session, status }, at('2026-11-01T00:00:00Z')).allowed).toBe(false);
    }
  });

  it('a full session blocks switching to going, never stepping down or staying', () => {
    const full = { ...session, going_count: 4 };
    const now = at('2026-11-12T00:00:00Z');
    expect(canChangeRsvp(full, now, { from: 'no_response', to: 'going' })).toEqual({ allowed: false, reason: 'full' });
    expect(canChangeRsvp(full, now, { from: 'not_going', to: 'going' })).toEqual({ allowed: false, reason: 'full' });
    expect(canChangeRsvp(full, now, { from: 'going', to: 'not_going' }).allowed).toBe(true);
    expect(canChangeRsvp(full, now, { from: 'going', to: 'no_response' }).allowed).toBe(true);
  });

  // Documented as Q2-10 in the QA report (no test: it is a design decision, not a bug in a function):
  // with a device clock 10 minutes AHEAD of the server, canChangeRsvp() already says "closed"
  // while the server would still accept the answer, and RsvpControl then shows no buttons at all.
  it('characterization: the decision uses whatever clock it is handed', () => {
    const serverNow = at('2026-11-14T04:55:00Z');
    const deviceNow = at('2026-11-14T05:05:00Z'); // 10 minutes fast
    expect(canChangeRsvp(session, serverNow).allowed).toBe(true);
    expect(canChangeRsvp(session, deviceNow).allowed).toBe(false);
  });
});
