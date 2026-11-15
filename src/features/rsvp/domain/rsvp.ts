/**
 * RSVP rules for the UI.
 *
 * `canChangeRsvp` is advisory: it decides whether to show the buttons and
 * what to say when they are disabled. The server (`set_rsvp`) is the
 * authority and uses its own clock; `now` here is for display only.
 */
import type { RsvpResponse, TrainingSession } from '@/lib/database.types';

export type RsvpBlockedReason =
  /** Session was cancelled. */
  | 'cancelled'
  /** Session is over. */
  | 'completed'
  /** Deadline passed or the session is already confirmed. */
  | 'closed'
  /** No spots left; only blocks switching TO going. */
  | 'full';

export type RsvpChangeCheck = { allowed: true } | { allowed: false; reason: RsvpBlockedReason };

type RsvpSessionFields = Pick<
  TrainingSession,
  'status' | 'rsvp_deadline' | 'going_count' | 'max_participants'
>;

/**
 * Can the member change their response?
 *
 * Without `change` it answers "are responses open at all". With `change` it
 * also reports `full` when moving to `going` from another response while the
 * session is at capacity (a member who is already going is never blocked by
 * `full`, and can always step down while responses are open).
 */
export function canChangeRsvp(
  session: RsvpSessionFields,
  now: Date,
  change?: { from: RsvpResponse | null | undefined; to: RsvpResponse },
): RsvpChangeCheck {
  if (session.status === 'cancelled') return { allowed: false, reason: 'cancelled' };
  if (session.status === 'completed') return { allowed: false, reason: 'completed' };
  if (session.status !== 'scheduled') return { allowed: false, reason: 'closed' };
  // Q2-10: the DEVICE clock gates the buttons here (display only). A phone whose clock runs fast
  // hides them while the server would still accept an answer. Open decision: always show them for a
  // 'scheduled' session and let the server's `rsvp_closed` explain.
  if (now.getTime() >= new Date(session.rsvp_deadline).getTime()) {
    return { allowed: false, reason: 'closed' };
  }

  if (
    change &&
    change.to === 'going' &&
    change.from !== 'going' &&
    session.max_participants !== null &&
    session.going_count >= session.max_participants
  ) {
    return { allowed: false, reason: 'full' };
  }
  return { allowed: true };
}

/** Short text for a disabled RSVP control. */
export function rsvpBlockedMessage(reason: RsvpBlockedReason): string {
  switch (reason) {
    case 'cancelled':
      return 'This training was cancelled.';
    case 'completed':
      return 'This training is over.';
    case 'closed':
      return 'Responses are closed.';
    case 'full':
      return 'This training is full.';
  }
}

function goingDelta(
  previous: RsvpResponse | null | undefined,
  next: RsvpResponse | null | undefined,
): number {
  return (next === 'going' ? 1 : 0) - (previous === 'going' ? 1 : 0);
}

/**
 * Returns the session with `going_count` adjusted for a response change, for
 * optimistic UI. A missing previous response counts as `no_response`.
 *
 * Exactly reversible: `applyOptimisticRsvp(applyOptimisticRsvp(s, a, b), b, a)`
 * has the same `going_count` as `s` (the count is never clamped, so a rollback
 * always restores the original number). The input is not mutated; when the
 * count does not change the same object is returned.
 */
export function applyOptimisticRsvp<T extends Pick<TrainingSession, 'going_count'>>(
  session: T,
  previousResponse: RsvpResponse | null | undefined,
  nextResponse: RsvpResponse | null | undefined,
): T {
  const delta = goingDelta(previousResponse, nextResponse);
  if (delta === 0) return session;
  return { ...session, going_count: session.going_count + delta };
}
