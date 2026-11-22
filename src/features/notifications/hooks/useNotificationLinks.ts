import { useQueryClient } from '@tanstack/react-query';
import { router, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Platform } from 'react-native';
import { isRunningInExpoGo } from 'expo';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { eventFeedKeys } from '@/features/eventFeed/api/keys';
import { invalidateUnlessRsvpPending } from '@/features/rsvp/domain/rsvpCache';
import { trainingKeys } from '@/features/trainings/api/keys';
import { reportError } from '@/lib/logger';

import { activityKeys } from '../api/keys';
import { fetchNotificationCommunityId, markNotificationRead } from '../api/notifications';
import {
  clearLaunchTap,
  onNotificationReceived,
  onNotificationTap,
  readLaunchTap,
  type NotificationTap,
} from '../api/pushNative';
import { targetFromPushData } from '../domain/deepLink';
import {
  initialNavState,
  step,
  type NavCommand,
  type NavContext,
  type NavEvent,
} from '../domain/notificationNavigation';

function go(href: string): void {
  // `href` comes from the deep-link allowlist (`targetFromPushData`), never from raw push data.
  const target = href as Href;
  if (href === '/activity') router.navigate(target);
  else router.push(target);
}

const pushUsable =
  (Platform.OS === 'ios' || Platform.OS === 'android') &&
  !(Platform.OS === 'android' && isRunningInExpoGo());

/**
 * Connects notification events to the app. Mount once, inside `(app)`.
 *
 * - A notification arriving while the app is open refreshes the activity,
 *   training and RSVP queries (the banner itself is shown by the foreground
 *   handler).
 * - A tap, from the background or from a cold start, navigates to the
 *   notification's validated deep link, switching to the notification's
 *   community first when it is another one of mine. The decisions live in the
 *   pure state machine `notificationNavigation`; this hook only feeds it the
 *   tap, the server's answer and the current memberships, and carries out the
 *   commands it returns. Only allowlisted internal routes are ever opened (see
 *   `targetFromPushData`).
 */
export function useNotificationLinks(): void {
  const queryClient = useQueryClient();
  const { communities, activeCommunityId, selectCommunity } = useCurrentMembership();

  const select = useRef(selectCommunity);
  useEffect(() => {
    select.current = selectCommunity;
  });

  const machine = useRef(initialNavState());
  // Answers that arrive later (the community lookup) go back in through here.
  const later = useRef<(event: NavEvent) => void>(() => undefined);
  // Runs the machine on one input and carries out what it answers.
  const send = useCallback(
    (event: NavEvent) => {
      const result = step(machine.current, event);
      machine.current = result.state;
      for (const command of result.commands) run(command);

      function run(command: NavCommand): void {
        switch (command.type) {
          case 'lookup':
            // The payload has no community id: ask the server which community the notification is for.
            fetchNotificationCommunityId(command.notificationId)
              .then((communityId) => later.current({ type: 'community-found', seq: command.seq, communityId }))
              .catch((error: unknown) => {
                // Could not tell: open it in the current community rather than lose the tap.
                reportError('push.community', error);
                later.current({ type: 'community-found', seq: command.seq, communityId: null });
              });
            return;
          case 'switch':
            select.current(command.communityId);
            return;
          case 'navigate':
            go(command.href);
            if (command.notificationId !== null) {
              // Opening it counts as having seen it.
              markNotificationRead(command.notificationId)
                .then(() => queryClient.invalidateQueries({ queryKey: activityKeys.all }))
                .catch((error: unknown) => reportError('push.markRead', error));
            }
            return;
        }
      }
    },
    [queryClient],
  );

  useEffect(() => {
    later.current = send;
  }, [send]);

  // The memberships, as explicit input: every change is judged again by the machine.
  const memberKey = communities.map((item) => item.community_id).join(',');
  const context = useMemo<NavContext>(
    () => ({
      ready: communities.length > 0 && activeCommunityId !== null,
      activeId: activeCommunityId,
      memberIds: communities.map((item) => item.community_id),
    }),
    // `memberKey` stands for the list of ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [memberKey, activeCommunityId],
  );
  useEffect(() => {
    send({ type: 'context', context });
  }, [send, context]);

  useEffect(() => {
    if (!pushUsable) return;

    const handleTap = (tap: NotificationTap) => {
      const { href, notificationId } = targetFromPushData(tap.data);
      if (href === null) {
        reportError('push.link', new Error('Ignored a notification without a valid link.'));
        return;
      }
      send({ type: 'tap', tap: { id: notificationId ?? tap.identifier, href, notificationId } });
    };

    readLaunchTap()
      .then((tap) => {
        if (!tap) return undefined;
        handleTap(tap);
        return clearLaunchTap();
      })
      .catch((error: unknown) => reportError('push.launchTap', error));

    const stopTap = onNotificationTap(handleTap);
    const stopReceived = onNotificationReceived(() => {
      void queryClient.invalidateQueries({ queryKey: activityKeys.all });
      void queryClient.invalidateQueries({ queryKey: eventFeedKeys.all });
      invalidateUnlessRsvpPending(queryClient, { queryKey: trainingKeys.lists() });
      invalidateUnlessRsvpPending(queryClient, { queryKey: trainingKeys.details() });
    });
    return () => {
      stopTap();
      stopReceived();
      send({ type: 'reset' });
    };
  }, [send, queryClient]);
}
