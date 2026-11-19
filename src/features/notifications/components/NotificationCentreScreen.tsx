import { useRouter, type Href } from 'expo-router';
import { View } from 'react-native';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import type { AppNotification } from '@/lib/database.types';
import { isValidTimeZone } from '@/lib/datetime';
import { userMessage } from '@/lib/errors';
import { useNow } from '@/lib/useNow';
import {
  Banner,
  Button,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  LoadingState,
  Screen,
  Text,
  useTheme,
} from '@/ui';

import { hrefForLink, parseAppLink } from '../domain/deepLink';
import { useActivity } from '../hooks/useActivity';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
} from '../hooks/useActivityMutations';
import { NotificationRow } from './NotificationRow';
import { PushPromptCard } from './PushPromptCard';

/** The notification centre, opened from the bell. A back button (or gesture) returns to where you were. */
export function NotificationCentreScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const now = useNow();
  const { community } = useCurrentMembership();
  const activity = useActivity();
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead(community?.id ?? null);

  const zone = community && isValidTimeZone(community.timezone) ? community.timezone : 'UTC';

  const back = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const openNotification = (note: AppNotification) => {
    if (note.read_at === null) markRead.mutate(note);
    // Only allowlisted internal routes are opened, whatever the row says.
    const link = parseAppLink(note.deep_link);
    if (link) router.push(hrefForLink(link) as Href);
  };

  const hasNotes = activity.notifications.length > 0;
  const actionError = markAll.error ?? markRead.error;

  let body;
  if (activity.notificationsError && !hasNotes) {
    body = (
      <ErrorState
        message={userMessage(activity.notificationsError.code, activity.notificationsError.field)}
        onRetry={activity.refetch}
      />
    );
  } else if (activity.isLoading && !hasNotes) {
    body = <LoadingState message="Loading notifications" />;
  } else if (!hasNotes) {
    body = (
      <EmptyState
        title="No notifications yet"
        message="Updates about events and announcements will show up here."
      />
    );
  } else {
    body = (
      <View style={{ gap: spacing.sm }}>
        {activity.notificationsError ? (
          <Banner
            tone="warning"
            message={userMessage(
              activity.notificationsError.code,
              activity.notificationsError.field,
            )}
            action={{ label: 'Try again', onPress: activity.refetch }}
          />
        ) : null}
        <Card>
          {activity.notifications.map((note, index) => (
            <View key={note.id}>
              {index > 0 ? <Divider /> : null}
              <NotificationRow
                notification={note}
                zone={zone}
                now={now}
                onPress={() => openNotification(note)}
              />
            </View>
          ))}
        </Card>
      </View>
    );
  }

  return (
    <Screen
      scroll
      edges={['top', 'left', 'right']}
      onRefresh={activity.refetch}
      refreshing={activity.isRefetching}
    >
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={back} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Text variant="title" accessibilityRole="header" style={{ flex: 1 }}>
          Notifications
        </Text>
        {activity.unreadNotificationCount > 0 ? (
          <Button
            label="Mark all read"
            variant="ghost"
            size="sm"
            loading={markAll.isPending}
            onPress={() => markAll.mutate()}
          />
        ) : null}
      </View>
      <PushPromptCard />
      {actionError ? (
        <Banner tone="error" message={userMessage(actionError.code, actionError.field)} />
      ) : null}
      {body}
    </Screen>
  );
}
