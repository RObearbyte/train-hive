import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { useSession } from '@/features/community/hooks/SessionProvider';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { createCoalescer, resubscribeDelayMs } from '@/features/trainings/domain/coalesce';
import { reportError } from '@/lib/logger';
import { getSupabase } from '@/lib/supabase';

import { eventFeedKeys } from '../api/keys';

/**
 * Live updates for the discussions of the active community. Mount once,
 * inside `(app)`. Same rules as the other channels: an event never touches the
 * cache, it only marks the feed and unread queries stale (coalesced), and
 * every (re)subscription and return to the foreground refetches once to cover
 * missed events. RLS filters rows per subscriber; the community filter only
 * keeps the traffic small. A deletion arrives as an UPDATE.
 */
export function useEventFeedRealtime(): void {
  const queryClient = useQueryClient();
  const { userId } = useSession();
  const { community } = useCurrentMembership();
  const communityId = community?.id ?? null;
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (communityId === null || userId === null) return;

    const supabase = getSupabase();
    const coalescer = createCoalescer<'feed'>(
      () => void queryClient.invalidateQueries({ queryKey: eventFeedKeys.all }),
      { delayMs: 400, maxWaitMs: 2000 },
    );

    let closedByUs = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const channel = supabase
      .channel(`event-feed:${communityId}:${userId}:${attempt}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'event_posts',
          filter: `community_id=eq.${communityId}`,
        },
        () => coalescer.add('feed'),
      )
      .subscribe((status, error) => {
        if (closedByUs) return;
        if (status === 'SUBSCRIBED') {
          coalescer.add('feed');
          return;
        }
        if (error) reportError('realtime.eventFeed', error);
        if (retryTimer === null) {
          retryTimer = setTimeout(
            () => setAttempt((current) => current + 1),
            resubscribeDelayMs(attempt),
          );
        }
      });

    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') coalescer.add('feed');
    });

    return () => {
      closedByUs = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      appState.remove();
      coalescer.cancel();
      supabase.removeChannel(channel).catch((error: unknown) => {
        reportError('realtime.eventFeed.removeChannel', error);
      });
    };
  }, [queryClient, communityId, userId, attempt]);
}
