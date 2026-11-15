import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { useSession } from '@/features/community/hooks/SessionProvider';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { createCoalescer, resubscribeDelayMs } from '@/features/trainings/domain/coalesce';
import { reportError } from '@/lib/logger';
import { getSupabase } from '@/lib/supabase';

import { activityKeys } from '../api/keys';
import { activityTopicsForTable, type ActivityTopic } from '../domain/realtime';

const ALL_TOPICS: ActivityTopic[] = ['announcements', 'notifications'];

function invalidateTopics(queryClient: QueryClient, topics: ActivityTopic[]): void {
  for (const topic of topics) {
    if (topic === 'announcements') {
      void queryClient.invalidateQueries({ queryKey: activityKeys.feeds() });
      void queryClient.invalidateQueries({ queryKey: activityKeys.manageds() });
      void queryClient.invalidateQueries({ queryKey: activityKeys.announcements() });
    } else {
      void queryClient.invalidateQueries({ queryKey: activityKeys.notificationLists() });
    }
  }
}

/**
 * Live updates for announcements (community filter) and my notifications
 * (`user_id` filter). Mount once, inside `(app)`. Same rules as the trainings
 * channel: an event never touches the cache, it only marks queries stale
 * (coalesced), and every (re)subscription and return to the foreground
 * refetches once to cover missed events. RLS filters events per subscriber;
 * the filters only keep the traffic small. Announcement events for rows a
 * member may not see (scheduled ones) are never delivered to them.
 */
export function useActivityRealtime(): void {
  const queryClient = useQueryClient();
  const { userId } = useSession();
  const { community } = useCurrentMembership();
  const communityId = community?.id ?? null;
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (communityId === null || userId === null) return;

    const supabase = getSupabase();
    const coalescer = createCoalescer<ActivityTopic>(
      (topics) => invalidateTopics(queryClient, topics),
      { delayMs: 400, maxWaitMs: 2000 },
    );
    const onChange = (table: string) => () => {
      for (const topic of activityTopicsForTable(table)) coalescer.add(topic);
    };

    let closedByUs = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const channel = supabase
      .channel(`activity:${communityId}:${userId}:${attempt}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'announcements',
          filter: `community_id=eq.${communityId}`,
        },
        onChange('announcements'),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
        onChange('notifications'),
      )
      .subscribe((status, error) => {
        if (closedByUs) return;
        if (status === 'SUBSCRIBED') {
          for (const topic of ALL_TOPICS) coalescer.add(topic);
          return;
        }
        if (error) reportError('realtime.activity', error);
        if (retryTimer === null) {
          retryTimer = setTimeout(
            () => setAttempt((current) => current + 1),
            resubscribeDelayMs(attempt),
          );
        }
      });

    const appState = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      for (const topic of ALL_TOPICS) coalescer.add(topic);
    });

    return () => {
      closedByUs = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      appState.remove();
      coalescer.cancel();
      supabase.removeChannel(channel).catch((error: unknown) => {
        reportError('realtime.activity.removeChannel', error);
      });
    };
  }, [queryClient, communityId, userId, attempt]);
}
