/**
 * Wording for event cards and details. Pure, so every status has tested
 * text and the provisional / final distinction cannot drift between screens.
 */
import type { RsvpResponse } from '@/lib/database.types';

import type { ParticipationSummary, TrainingDisplayStatus } from './status';

/** True while the outcome can still change (the UI must not present these as decided). */
export function isProvisional(status: TrainingDisplayStatus): boolean {
  return status === 'awaiting_minimum' || status === 'minimum_reached' || status === 'finalizing';
}

/**
 * One plain sentence answering "will it happen?". `deadlineText` is the RSVP
 * deadline already formatted in the session's zone, e.g. "Sat 14 Nov, 07:00".
 */
export function statusExplanation(
  status: TrainingDisplayStatus,
  summary: Pick<ParticipationSummary, 'remainingToMin'>,
  deadlineText: string,
): string {
  switch (status) {
    case 'awaiting_minimum': {
      const needed =
        summary.remainingToMin === 1
          ? '1 more person is needed'
          : `${summary.remainingToMin} more people are needed`;
      return `Not decided yet. ${needed} by ${deadlineText}, or the training is cancelled.`;
    }
    case 'minimum_reached':
      return `Enough people so far, but not final. It is confirmed at the deadline, ${deadlineText}, if the minimum still holds.`;
    case 'finalizing':
      return 'Responses are closed. The final decision is being made now.';
    case 'confirmed':
      return 'Final: this training is happening.';
    case 'registration_open':
      return `Registration is open until ${deadlineText}. This event is happening.`;
    case 'registration_closed':
      return 'Registration is closed. This event is happening.';
    case 'cancelled_insufficient':
      return 'Cancelled: too few people had signed up by the deadline.';
    case 'cancelled_organizer':
      return 'Cancelled by the organizer.';
    case 'completed':
      return 'This event has taken place.';
  }
}

/** Short badge label; awaiting shows the number still needed. */
export function statusBadgeLabel(
  status: TrainingDisplayStatus,
  summary: Pick<ParticipationSummary, 'remainingToMin'>,
): string | undefined {
  if (status === 'awaiting_minimum' && summary.remainingToMin > 0) {
    return `${summary.remainingToMin} more needed`;
  }
  return undefined;
}

/** "Am I going?" as one line. */
export function myRsvpText(response: RsvpResponse | null | undefined): string {
  if (response === 'going') return "You're going";
  if (response === 'not_going') return "You're not going";
  return 'No answer yet';
}

/** Spoken summary of a card: when, what, where, how many, status, my answer. */
export function cardAccessibilityLabel(parts: {
  when: string;
  title: string;
  location: string;
  participation: string;
  statusLabel: string;
  myRsvp: string;
}): string {
  return [
    parts.title,
    parts.when,
    parts.location,
    parts.participation,
    `Status: ${parts.statusLabel}`,
    parts.myRsvp,
  ].join('. ');
}

export type ParticipantLike = { response: RsvpResponse; displayName: string };

/** Participants split into the two groups shown on details, each sorted by name. */
export function groupParticipants<T extends ParticipantLike>(
  participants: readonly T[],
): { going: T[]; notGoing: T[] } {
  const byName = (a: T, b: T) =>
    a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' });
  return {
    going: participants.filter((p) => p.response === 'going').sort(byName),
    notGoing: participants.filter((p) => p.response === 'not_going').sort(byName),
  };
}

export type ParticipationLines = {
  /** "12 going" without a minimum; "8 / 10 confirmed" below the minimum, "11 confirmed (minimum 6)" once reached. */
  count: string;
  /** "2 more participants needed", only while that can still change the outcome. */
  need: string | null;
  /** "4 spots left" / "Full", only while people can still join. */
  spots: string | null;
};

/**
 * What to show under the progress bar. Hints that invite action ("2 more
 * needed", "4 spots left") are dropped once the session is decided or
 * responses are closed, where they would be misleading.
 */
export function participationLines(
  summary: ParticipationSummary,
  status: TrainingDisplayStatus,
): ParticipationLines {
  // No minimum (every kind but training): just who is going, and free places while registration is open.
  if (summary.min === null) {
    return {
      count: summary.text,
      need: null,
      spots: status === 'registration_open' ? summary.spotsText : null,
    };
  }
  const open = status === 'awaiting_minimum' || status === 'minimum_reached';
  return {
    count:
      summary.remainingToMin > 0
        ? summary.text
        : `${summary.going} confirmed (minimum ${summary.min})`,
    need: status === 'awaiting_minimum' ? summary.needText : null,
    spots: open ? summary.spotsText : null,
  };
}
