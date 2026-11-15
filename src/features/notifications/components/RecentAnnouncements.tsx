import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { useSession } from '@/features/community/hooks/SessionProvider';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { isValidTimeZone } from '@/lib/datetime';
import { useNow } from '@/lib/useNow';
import { Button, Card, Divider, Text, useTheme } from '@/ui';

import { unreadAnnouncements } from '../domain/unread';
import { useActivity } from '../hooks/useActivity';
import { announcementHref } from './routes';
import { AnnouncementRow } from './AnnouncementRow';

const RECENT_COUNT = 3;

/**
 * The newest announcements on Home, with unread dots. Renders nothing while
 * loading, on error or when there are none: Home has its own states, and the
 * Activity tab shows this feed's loading and error states in full.
 */
export function RecentAnnouncements() {
  const router = useRouter();
  const { spacing } = useTheme();
  const now = useNow();
  const { userId } = useSession();
  const { community } = useCurrentMembership();
  const activity = useActivity();

  const recent = activity.announcements.slice(0, RECENT_COUNT);
  if (recent.length === 0) return null;

  const unread = new Set(
    unreadAnnouncements(activity.announcements, activity.readIds, userId).map((item) => item.id),
  );
  const zone = community && isValidTimeZone(community.timezone) ? community.timezone : 'UTC';

  return (
    <View style={{ gap: spacing.sm }}>
      <View
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <Text variant="heading">Recent announcements</Text>
        <Button label="See all" variant="ghost" size="sm" onPress={() => router.navigate('/activity')} />
      </View>
      <Card>
        {recent.map((item, index) => (
          <View key={item.id}>
            {index > 0 ? <Divider /> : null}
            <AnnouncementRow
              announcement={item}
              unread={unread.has(item.id)}
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
