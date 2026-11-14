/**
 * Derived training status: the single source for the table in
 * docs/ARCHITECTURE.md section 6.
 *
 * `now` is used for DISPLAY only. The server enforces the RSVP deadline
 * (`set_rsvp` rejects once `now() >= rsvp_deadline`) and makes the
 * confirm / cancel decision (`finalize_due_sessions`). Nothing here may be
 * used to allow or deny an action on its own.
 */
import type { TrainingSession } from '@/lib/database.types';

/** Structurally identical to the status type the UI kit defines. */
export type TrainingDisplayStatus =
  | 'awaiting_minimum'
  | 'minimum_reached'
  | 'finalizing'
  | 'confirmed'
  | 'cancelled_insufficient'
  | 'cancelled_organizer'
  | 'completed';

type StatusFields = Pick<
  TrainingSession,
  'status' | 'cancel_reason' | 'going_count' | 'min_participants' | 'rsvp_deadline'
>;

export function deriveDisplayStatus(session: StatusFields, now: Date): TrainingDisplayStatus {
  switch (session.status) {
    case 'completed':
      return 'completed';
    case 'confirmed':
      return 'confirmed';
    case 'cancelled':
      // The table check guarantees a reason on cancelled rows; only an explicit
      // insufficient_participation is reported as such.
      return session.cancel_reason === 'insufficient_participation'
        ? 'cancelled_insufficient'
        : 'cancelled_organizer';
    case 'scheduled':
      // Deadline passed but the server job has not decided yet.
      if (now.getTime() >= new Date(session.rsvp_deadline).getTime()) return 'finalizing';
      return session.going_count < session.min_participants
        ? 'awaiting_minimum'
        : 'minimum_reached';
  }
}

export type ParticipationSummary = {
  going: number;
  min: number;
  max: number | null;
  /** Participants still needed to reach the minimum (0 once reached). */
  remainingToMin: number;
  /** Free places under the maximum, or null when there is no maximum. */
  spotsLeft: number | null;
  isFull: boolean;
  /** e.g. "7 / 10 confirmed": going count against the minimum. */
  text: string;
  /** e.g. "3 more participants needed", or null once the minimum is reached. */
  needText: string | null;
  /** e.g. "5 spots left", "1 spot left", "Full", or null when there is no maximum. */
  spotsText: string | null;
};

export function participationSummary(
  session: Pick<TrainingSession, 'going_count' | 'min_participants' | 'max_participants'>,
): ParticipationSummary {
  const going = Math.max(0, session.going_count);
  const min = session.min_participants;
  const max = session.max_participants;
  const remainingToMin = Math.max(0, min - going);
  const spotsLeft = max === null ? null : Math.max(0, max - going);
  const isFull = max !== null && going >= max;

  let needText: string | null = null;
  if (remainingToMin === 1) needText = '1 more participant needed';
  else if (remainingToMin > 1) needText = `${remainingToMin} more participants needed`;

  let spotsText: string | null = null;
  if (spotsLeft === 0) spotsText = 'Full';
  else if (spotsLeft === 1) spotsText = '1 spot left';
  else if (spotsLeft !== null) spotsText = `${spotsLeft} spots left`;

  return {
    going,
    min,
    max,
    remainingToMin,
    spotsLeft,
    isFull,
    text: `${going} / ${min} confirmed`,
    needText,
    spotsText,
  };
}

type TimeFields = Pick<TrainingSession, 'status' | 'starts_at' | 'ends_at'>;

function endTime(session: TimeFields): number {
  return new Date(session.ends_at ?? session.starts_at).getTime();
}

/**
 * Past = completed, or its end (start when there is no end) is at or before
 * `now`. Cancelled sessions stay in "upcoming" until their time passes, so
 * members still see the cancellation. List sectioning only.
 */
export function isPast(session: TimeFields, now: Date): boolean {
  return session.status === 'completed' || endTime(session) <= now.getTime();
}

export function isUpcoming(session: TimeFields, now: Date): boolean {
  return !isPast(session, now);
}

type SortFields = Pick<TrainingSession, 'starts_at' | 'id'>;

/** Soonest first; ties broken by id so the order is stable across refetches. */
export function compareUpcoming(a: SortFields, b: SortFields): number {
  const diff = new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
  if (diff !== 0) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Most recent first. */
export function comparePast(a: SortFields, b: SortFields): number {
  return compareUpcoming(b, a);
}

/** Splits into the two list sections, each sorted for display. Does not mutate the input. */
export function splitSessions<T extends TimeFields & SortFields>(
  sessions: readonly T[],
  now: Date,
): { upcoming: T[]; past: T[] } {
  const upcoming: T[] = [];
  const past: T[] = [];
  for (const session of sessions) (isPast(session, now) ? past : upcoming).push(session);
  upcoming.sort(compareUpcoming);
  past.sort(comparePast);
  return { upcoming, past };
}

/** The next training that is still on (not cancelled), for the Home tab; null when none. */
export function nextSession<T extends TimeFields & SortFields>(
  sessions: readonly T[],
  now: Date,
): T | null {
  const { upcoming } = splitSessions(sessions, now);
  return upcoming.find((session) => session.status !== 'cancelled') ?? null;
}
