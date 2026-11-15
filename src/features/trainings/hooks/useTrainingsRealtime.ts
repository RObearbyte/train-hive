import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { useSession } from '@/features/community/hooks/SessionProvider';
import {
  membershipKeys,
  useCurrentMembership,
} from '@/features/community/hooks/useCurrentMembership';
import { reportError } from '@/lib/logger';
import { getSupabase } from '@/lib/supabase';

import { rsvpKeys, trainingKeys } from '../api/keys';
import {
  createCoalescer,
  resubscribeDelayMs,
  topicsForTable,
  type RealtimeTopic,
} from '../domain/coalesce';

const ALL_TOPICS: RealtimeTopic[] = ['sessions', 'rsvps', 'membership'];

function invalidateTopics(queryClient: QueryClient, topics: RealtimeTopic[]): void {
  for (const topic of topics) {
    if (topic === 'sessions') {
      void queryClient.invalidateQueries({ queryKey: trainingKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: trainingKeys.details() });
    } else if (topic === 'rsvps') {
      void queryClient.invalidateQueries({ queryKey: rsvpKeys.all });
      void queryClient.invalidateQueries({ queryKey: trainingKeys.allParticipants() });
    } else {
      void queryClient.invalidateQueries({ queryKey: membershipKeys.all });
    }
  }
}

/**
 * Live updates for the signed-in member's community. Mount once, inside `(app)`.
 *
 * One channel listens for changes to the community's sessions and RSVPs and
 * to my own membership. An event never touches the cache: it only marks the
 * affected queries stale, coalesced so a burst causes one refetch. Duplicate
 * or out-of-order events are therefore harmless.
 *
 * Every (re)subscription and every return to the foreground also invalidates
 * everything once, to cover events missed while disconnected. A failed
 * channel is rebuilt with backoff. The channel is removed on unmount, which
 * includes leaving `(app)` after sign-out or removal.
 *
 * Known limit: when I am removed from the community, RLS stops delivering
 * events to me, including that removal. It is picked up by the next refetch
 * (foreground, reconnect, pull to refresh, or a rejected RSVP).
 */
export function useTrainingsRealtime(): void {
  const queryClient = useQueryClient();
  const { userId } = useSession();
  const { community } = useCurrentMembership();
  const communityId = community?.id ?? null;
  // Bumped to rebuild the channel after a failure.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (communityId === null || userId === null) return;

    const supabase = getSupabase();
    const coalescer = createCoalescer<RealtimeTopic>(
      (topics) => invalidateTopics(queryClient, topics),
      { delayMs: 400, maxWaitMs: 2000 },
    );
    const onChange = (table: string) => () => {
      for (const topic of topicsForTable(table)) coalescer.add(topic);
    };

    let closedByUs = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const channel = supabase
      .channel(`community:${communityId}:${attempt}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'training_sessions',
          filter: `community_id=eq.${communityId}`,
        },
        onChange('training_sessions'),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'training_rsvps',
          filter: `community_id=eq.${communityId}`,
        },
        onChange('training_rsvps'),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'memberships', filter: `user_id=eq.${userId}` },
        onChange('memberships'),
      )
      .subscribe((status, error) => {
        if (closedByUs) return;
        if (status === 'SUBSCRIBED') {
          // Catch up on anything that changed while not subscribed.
          for (const topic of ALL_TOPICS) coalescer.add(topic);
          return;
        }
        // CHANNEL_ERROR, TIMED_OUT or an unexpected CLOSED: build a new channel later.
        if (error) reportError('realtime.channel', error);
        if (retryTimer === null) {
          retryTimer = setTimeout(
            () => setAttempt((current) => current + 1),
            resubscribeDelayMs(attempt),
          );
        }
      });

    const appState = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      // The socket is paused in the background; do not trust that nothing was missed.
      for (const topic of ALL_TOPICS) coalescer.add(topic);
    });

    return () => {
      closedByUs = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      appState.remove();
      coalescer.cancel();
      supabase.removeChannel(channel).catch((error: unknown) => {
        reportError('realtime.removeChannel', error);
      });
    };
  }, [queryClient, communityId, userId, attempt]);
}
