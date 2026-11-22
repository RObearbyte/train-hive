import { useRouter } from 'expo-router';

import { eventFeedHref } from '@/features/notifications/components/routes';
import { Card, Icon, ListItem } from '@/ui';

import { discussionLabel, discussionSubtitle, unreadRowFor } from '../domain/feed';
import { useEventFeedUnread } from '../hooks/useEventFeed';

/**
 * Entry to the discussion on the event details: "Discussion (2 new)". The
 * counts come from one request per community; if it fails the entry is still
 * there, without counts.
 */
export function DiscussionEntry({ sessionId, communityId }: { sessionId: string; communityId: string }) {
  const router = useRouter();
  const unread = useEventFeedUnread(communityId);
  const row = unreadRowFor(unread.data, sessionId);
  const title = discussionLabel(row);
  const subtitle = unread.isError ? undefined : discussionSubtitle(row);

  return (
    <Card>
      <ListItem
        title={title}
        subtitle={subtitle}
        leading={<Icon name="megaphone" size={22} color={row && row.unread_count > 0 ? 'primary' : 'textMuted'} />}
        onPress={() => router.push(eventFeedHref(sessionId))}
        accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      />
    </Card>
  );
}
