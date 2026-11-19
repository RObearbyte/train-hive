import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
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
  SegmentedControl,
  Text,
  useTheme,
} from '@/ui';

import { hrefForLink, parseAppLink } from '../domain/deepLink';
import { unreadAnnouncements } from '../domain/unread';
import { useSession } from '@/features/community/hooks/SessionProvider';
import { useActivity, useManagedAnnouncements } from '../hooks/useActivity';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
} from '../hooks/useActivityMutations';
import { announcementHref } from './routes';
import { AnnouncementRow } from './AnnouncementRow';
import { ManagedAnnouncementCard } from './ManagedAnnouncementCard';
import { NotificationRow } from './NotificationRow';
import { PushPromptCard } from './PushPromptCard';

type Section = 'announcements' | 'notifications';

/** The Activity tab: announcements feed and notification center. */
export function ActivityScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const now = useNow();
  const { userId } = useSession();
  const { community, isOrganizer } = useCurrentMembership();
  const activity = useActivity();
  const managed = useManagedAnnouncements(isOrganizer);
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead(community?.id ?? null);
  const [section, setSection] = useState<Section>('announcements');

  const zone = community && isValidTimeZone(community.timezone) ? community.timezone : 'UTC';
  const unreadAnnouncementIds = new Set(
    unreadAnnouncements(activity.announcements, activity.readIds, userId).map((item) => item.id),
  );

  const openNotification = (note: AppNotification) => {
    if (note.read_at === null) markRead.mutate(note);
    const link = parseAppLink(note.deep_link);
    if (link) router.push(hrefForLink(link) as Href);
  };

  const refresh = () => {
    activity.refetch();
    if (isOrganizer) managed.refetch();
  };

  const options = [
    {
      value: 'announcements' as const,
      label:
        activity.unreadAnnouncementCount > 0
          ? `Announcements (${activity.unreadAnnouncementCount})`
          : 'Announcements',
      accessibilityLabel:
        activity.unreadAnnouncementCount > 0
          ? `Announcements, ${activity.unreadAnnouncementCount} unread`
          : 'Announcements',
    },
    {
      value: 'notifications' as const,
      label:
        activity.unreadNotificationCount > 0
          ? `Notifications (${activity.unreadNotificationCount})`
          : 'Notifications',
      accessibilityLabel:
        activity.unreadNotificationCount > 0
          ? `Notifications, ${activity.unreadNotificationCount} unread`
          : 'Notifications',
    },
  ];

  let body;
  if (section === 'announcements') {
    const hasFeed = activity.announcements.length > 0;
    const hasManaged = isOrganizer && managed.items.length > 0;
    body = (
      <>
        {isOrganizer ? (
          <Button
            label="New announcement"
            icon="plus"
            fullWidth
            onPress={() => router.push('/announcements/new')}
          />
        ) : null}

        {isOrganizer && managed.error ? (
          <Banner
            tone="warning"
            message={`Scheduled announcements could not be loaded. ${userMessage(managed.error.code, managed.error.field)}`}
            action={{ label: 'Try again', onPress: managed.refetch }}
          />
        ) : null}
        {hasManaged ? (
          <View style={{ gap: spacing.sm }}>
            <Text variant="heading">Scheduled and cancelled</Text>
            {managed.items.map((item) => (
              <ManagedAnnouncementCard key={item.id} announcement={item} zone={zone} />
            ))}
          </View>
        ) : null}

        {activity.announcementsError && !hasFeed ? (
          <ErrorState
            message={userMessage(activity.announcementsError.code, activity.announcementsError.field)}
            onRetry={activity.refetch}
          />
        ) : activity.isLoading && !hasFeed ? (
          <LoadingState message="Loading announcements" />
        ) : !hasFeed ? (
          <EmptyState
            title="No announcements yet"
            message={
              isOrganizer
                ? 'Announcements you publish show up here for the whole community.'
                : 'When your organizer posts an announcement, it will show up here.'
            }
          />
        ) : (
          <View style={{ gap: spacing.sm }}>
            {activity.announcementsError ? (
              <Banner
                tone="warning"
                message={userMessage(
                  activity.announcementsError.code,
                  activity.announcementsError.field,
                )}
                action={{ label: 'Try again', onPress: activity.refetch }}
              />
            ) : null}
            <Text variant="heading">Announcements</Text>
            <Card>
              {activity.announcements.map((item, index) => (
                <View key={item.id}>
                  {index > 0 ? <Divider /> : null}
                  <AnnouncementRow
                    announcement={item}
                    unread={unreadAnnouncementIds.has(item.id)}
                    zone={zone}
                    now={now}
                    onPress={() => router.push(announcementHref(item.id))}
                  />
                </View>
              ))}
            </Card>
          </View>
        )}
      </>
    );
  } else {
    const hasNotes = activity.notifications.length > 0;
    const actionError = markAll.error ?? markRead.error;
    body = (
      <>
        {actionError ? (
          <Banner tone="error" message={userMessage(actionError.code, actionError.field)} />
        ) : null}
        {activity.notificationsError && !hasNotes ? (
          <ErrorState
            message={userMessage(
              activity.notificationsError.code,
              activity.notificationsError.field,
            )}
            onRetry={activity.refetch}
          />
        ) : activity.isLoading && !hasNotes ? (
          <LoadingState message="Loading notifications" />
        ) : !hasNotes ? (
          <EmptyState
            title="No notifications yet"
            message="Updates about events and announcements will show up here."
          />
        ) : (
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
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.sm,
              }}
            >
              <Text variant="heading">Notifications</Text>
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
        )}
      </>
    );
  }

  return (
    <Screen
      scroll
      edges={['top', 'left', 'right']}
      onRefresh={refresh}
      refreshing={activity.isRefetching}
    >
      <Text variant="title">Activity</Text>
      <PushPromptCard />
      <SegmentedControl
        accessibilityLabel="Activity sections"
        options={options}
        value={section}
        onChange={setSection}
      />
      {body}
    </Screen>
  );
}
