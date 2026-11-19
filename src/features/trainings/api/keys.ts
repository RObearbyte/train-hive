/**
 * Every TanStack Query key for trainings and RSVPs, in one place, so
 * optimistic updates, Realtime invalidation and screens agree on them.
 *
 * Cached shapes:
 * - `trainingKeys.list(communityId)`   → `TrainingSession[]`
 * - `trainingKeys.detail(sessionId)`   → `TrainingSession | null`
 * - `trainingKeys.participants(id)`    → `Participant[]`
 * - `trainingKeys.eventSubtypes`        → `EventSubtype[]`
 * - `rsvpKeys.mine(userId)`            → `MyRsvps` (session id → response)
 */
import type { RsvpResponse } from '@/lib/database.types';

export const trainingKeys = {
  all: ['trainings'] as const,
  lists: () => ['trainings', 'list'] as const,
  list: (communityId: string | null) => ['trainings', 'list', communityId] as const,
  details: () => ['trainings', 'detail'] as const,
  detail: (sessionId: string) => ['trainings', 'detail', sessionId] as const,
  allParticipants: () => ['trainings', 'participants'] as const,
  participants: (sessionId: string) => ['trainings', 'participants', sessionId] as const,
  eventSubtypes: ['trainings', 'event-subtypes'] as const,
  organizer: (userId: string) => ['trainings', 'organizer', userId] as const,
};

export const rsvpKeys = {
  all: ['rsvps'] as const,
  mine: (userId: string | null) => ['rsvps', 'mine', userId] as const,
};

/** My answers, by session id. A session without an entry is `no_response`. */
export type MyRsvps = Record<string, RsvpResponse>;
