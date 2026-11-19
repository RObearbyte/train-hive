import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { useSession } from '@/features/community/hooks/SessionProvider';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
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

import { unreadAnnouncements } from '../domain/unread';
import { useActivity, useManagedAnnouncements } from '../hooks/useActivity';
import { AnnouncementRow } from './AnnouncementRow';
import { ManagedAnnouncementCard } from './ManagedAnnouncementCard';
import { announcementHref } from './routes';

/**
 * All announcements, reached from the Home feed ("See all announcements").
 * Organizers also get the New announcement action and their scheduled and
 * cancelled announcements with Edit and Cancel.
 */
export function AnnouncementsScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const now = useNow();
  const { userId } = useSession();
  const { community, isOrganizer } = useCurrentMembership();
  const activity = useActivity();
  const managed = useManagedAnnouncements(isOrganizer);

  const zone = community && isValidTimeZone(community.timezone) ? community.timezone : 'UTC';
  const unreadIds = new Set(
    unreadAnnouncements(activity.announcements, activity.readIds, userId).map((item) => item.id),
  );

  const back = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };
  const refresh = () => {
    activity.refetch();
    if (isOrganizer) managed.refetch();
  };

  const hasFeed = activity.announcements.length > 0;
  const hasManaged = isOrganizer && managed.items.length > 0;

  let feed;
  if (activity.announcementsError && !hasFeed) {
    feed = (
      <ErrorState
        message={userMessage(activity.announcementsError.code, activity.announcementsError.field)}
        onRetry={activity.refetch}
      />
    );
  } else if (activity.isLoading && !hasFeed) {
    feed = <LoadingState message="Loading announcements" />;
  } else if (!hasFeed) {
    feed = (
      <EmptyState
        title="No announcements yet"
        message={
          isOrganizer
            ? 'Announcements you publish show up here for the whole community.'
            : 'When your organizer posts an announcement, it will show up here.'
        }
      />
    );
  } else {
    feed = (
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
        <Card>
          {activity.announcements.map((item, index) => (
            <View key={item.id}>
              {index > 0 ? <Divider /> : null}
              <AnnouncementRow
                announcement={item}
                unread={unreadIds.has(item.id)}
                zone={zone}
                now={now}
                onPress={() => router.push(announcementHref(item.id))}
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
      onRefresh={refresh}
      refreshing={activity.isRefetching}
    >
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={back} />
      </View>
      <Text variant="title" accessibilityRole="header">
        Announcements
      </Text>

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

      {feed}
    </Screen>
  );
}
