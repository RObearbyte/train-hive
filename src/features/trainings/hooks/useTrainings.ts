import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useSession } from '@/features/community/hooks/SessionProvider';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import type { EventKind, RsvpResponse, TrainingSession } from '@/lib/database.types';
import { toAppError, type AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';

import { rsvpKeys, trainingKeys, type MyRsvps } from '../api/keys';
import {
  fetchEventSubtypes,
  fetchCommunitySessions,
  fetchMyRsvps,
  fetchOrganizerName,
  fetchParticipants,
  fetchSession,
  type Participant,
} from '../api/trainings';
import { subtypeLabel, subtypeOptions, type SubtypeOption } from '../domain/events';
import { nextSession, splitSessions } from '../domain/status';

const NO_SESSIONS: TrainingSession[] = [];
const NO_RSVPS: MyRsvps = {};

export type CommunityTrainings = {
  upcoming: TrainingSession[];
  past: TrainingSession[];
  /** The next session that is still on, for Home. */
  next: TrainingSession | null;
  /** My answer for a session (`no_response` when I have none). */
  myResponse: (sessionId: string) => RsvpResponse;
  /** First load, nothing to show yet. */
  isLoading: boolean;
  isRefetching: boolean;
  /** Set when the sessions could not be loaded; cached data may still be shown. */
  error: AppError | null;
  refetch: () => void;
};

/**
 * The community's sessions split for display, plus my answers. `now` decides
 * the upcoming / past split and is for display only.
 */
export function useCommunityTrainings(now: Date): CommunityTrainings {
  const { userId } = useSession();
  const { community } = useCurrentMembership();
  const communityId = community?.id ?? null;

  const sessions = useQuery({
    queryKey: trainingKeys.list(communityId),
    queryFn: () => fetchCommunitySessions(communityId as string),
    enabled: communityId !== null,
  });

  const mine = useQuery({
    queryKey: rsvpKeys.mine(userId),
    queryFn: () => fetchMyRsvps(userId as string),
    enabled: communityId !== null && userId !== null,
  });

  const list = sessions.data ?? NO_SESSIONS;
  const answers = mine.data ?? NO_RSVPS;
  const { upcoming, past } = splitSessions(list, now);
  const error = sessions.error ?? mine.error;

  return {
    upcoming,
    past,
    next: nextSession(list, now),
    myResponse: (sessionId) => answers[sessionId] ?? 'no_response',
    isLoading: sessions.isPending || mine.isPending,
    isRefetching: sessions.isRefetching || mine.isRefetching,
    error: error ? toAppError(error) : null,
    refetch: () => {
      Promise.all([sessions.refetch(), mine.refetch()]).catch((refetchError: unknown) =>
        reportError('trainings.refetch', refetchError),
      );
    },
  };
}

/**
 * One session. Shows the copy from the list cache immediately while the
 * fresh row loads. `data` is null when the session does not exist or is not
 * visible to the caller (for example after being removed from the community).
 */
export function useTraining(sessionId: string) {
  const queryClient = useQueryClient();
  return useQuery<TrainingSession | null>({
    queryKey: trainingKeys.detail(sessionId),
    queryFn: () => fetchSession(sessionId),
    placeholderData: () => {
      const lists = queryClient.getQueriesData<TrainingSession[]>({
        queryKey: trainingKeys.lists(),
      });
      for (const [, list] of lists) {
        const found = list?.find((session) => session.id === sessionId);
        if (found) return found;
      }
      return undefined;
    },
  });
}

function useMyRsvpsQuery(communityId: string | null) {
  const { userId } = useSession();
  return useQuery({
    queryKey: rsvpKeys.mine(userId),
    queryFn: () => fetchMyRsvps(userId as string),
    enabled: communityId !== null && userId !== null,
  });
}

/** My answer for one session, from the same cache the list uses. */
export function useMyResponse(sessionId: string, communityId: string | null): RsvpResponse {
  const mine = useMyRsvpsQuery(communityId);
  return mine.data?.[sessionId] ?? 'no_response';
}

export type MyAnswersState = {
  /** 'loading': not known yet; 'error': could not be loaded; 'ready': answers are known. */
  status: 'loading' | 'error' | 'ready';
  retry: () => void;
};

/**
 * Whether "my answers" are known. Until they are, "No answer yet" would be a
 * guess, so the RSVP control shows a loading or error state instead of live buttons.
 */
export function useMyAnswersState(): MyAnswersState {
  const { community } = useCurrentMembership();
  const mine = useMyRsvpsQuery(community?.id ?? null);
  const status = mine.data !== undefined ? 'ready' : mine.isError ? 'error' : 'loading';
  return {
    status,
    retry: () => {
      mine.refetch().catch((error: unknown) => reportError('rsvp.mineRetry', error));
    },
  };
}

export function useParticipants(sessionId: string) {
  return useQuery<Participant[]>({
    queryKey: trainingKeys.participants(sessionId),
    queryFn: () => fetchParticipants(sessionId),
  });
}

export function useOrganizerName(sessionId: string, organizerId: string | null | undefined) {
  return useQuery<string | null>({
    queryKey: trainingKeys.organizer(organizerId ?? ''),
    queryFn: () => fetchOrganizerName(sessionId),
    enabled: organizerId !== undefined && organizerId !== null,
    // Names change rarely; do not refetch on every visit.
    staleTime: 5 * 60_000,
  });
}

function useSubtypeRows() {
  return useQuery({
    queryKey: trainingKeys.eventSubtypes,
    queryFn: fetchEventSubtypes,
    staleTime: 60 * 60_000,
  });
}

/**
 * Choices for the subtype picker of one kind: the `event_subtypes` table once loaded, the
 * bundled list until then (or when the table cannot be read). `selected` is always among them,
 * so editing an event with a subtype this list lacks does not silently change it.
 */
export function useSubtypeOptions(kind: EventKind, selected: string): SubtypeOption[] {
  const rows = useSubtypeRows();
  return subtypeOptions(kind, rows.data, selected);
}

/**
 * Label for a subtype: the server's label when the lookup table has loaded, otherwise the
 * bundled label (which also covers unknown keys).
 */
export function useSubtypeLabel(): (kind: EventKind, key: string) => string {
  const rows = useSubtypeRows();
  return (kind, key) => subtypeLabel(kind, key, rows.data);
}
