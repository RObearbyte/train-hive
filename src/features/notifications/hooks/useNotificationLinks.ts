import { useQueryClient } from '@tanstack/react-query';
import { router, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { isRunningInExpoGo } from 'expo';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { invalidateUnlessRsvpPending } from '@/features/rsvp/domain/rsvpCache';
import { trainingKeys } from '@/features/trainings/api/keys';
import { reportError } from '@/lib/logger';

import { activityKeys } from '../api/keys';
import { markNotificationRead } from '../api/notifications';
import {
  clearLaunchTap,
  onNotificationReceived,
  onNotificationTap,
  readLaunchTap,
  type NotificationTap,
} from '../api/pushNative';
import { targetFromPushData } from '../domain/deepLink';
import { createNavigationQueue } from '../domain/navigationQueue';

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
 *   notification's validated deep link. Taps are queued until this hook
 *   mounts with a membership, i.e. after the app gate has resolved, and each
 *   notification is handled once per session. Only allowlisted internal
 *   routes are ever opened (see `targetFromPushData`).
 */
export function useNotificationLinks(): void {
  const queryClient = useQueryClient();
  const { community } = useCurrentMembership();
  const ready = community !== null;
  const [queue] = useState(() => createNavigationQueue(go));

  useEffect(() => {
    queue.setReady(ready);
    return () => queue.setReady(false);
  }, [queue, ready]);

  useEffect(() => {
    if (!pushUsable) return;

    const handleTap = (tap: NotificationTap) => {
      const { href, notificationId } = targetFromPushData(tap.data);
      if (href === null) {
        reportError('push.link', new Error('Ignored a notification without a valid link.'));
        return;
      }
      const accepted = queue.offer({ id: notificationId ?? tap.identifier, href });
      if (accepted && notificationId !== null) {
        // Opening it counts as having seen it.
        markNotificationRead(notificationId)
          .then(() => queryClient.invalidateQueries({ queryKey: activityKeys.all }))
          .catch((error: unknown) => reportError('push.markRead', error));
      }
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
      invalidateUnlessRsvpPending(queryClient, { queryKey: trainingKeys.lists() });
      invalidateUnlessRsvpPending(queryClient, { queryKey: trainingKeys.details() });
    });
    return () => {
      stopTap();
      stopReceived();
    };
  }, [queue, queryClient]);
}
