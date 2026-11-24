import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';

import { discussionChip, type DiscussionChip } from '../domain/chip';
import { unreadRowFor } from '../domain/feed';
import { useEventFeedUnread } from './useEventFeed';

/**
 * The discussion chip of one event. Every card shares the same cached
 * `get_event_feed_unread(community)` query (one request per community, kept
 * fresh by `useEventFeedRealtime`). If that query fails (for example the P4
 * migration is missing) there is no data, so no chip and no banner.
 */
export function useDiscussionChip(sessionId: string): DiscussionChip | null {
  const { community } = useCurrentMembership();
  const unread = useEventFeedUnread(community?.id ?? null);
  if (unread.isError) return null;
  return discussionChip(unreadRowFor(unread.data, sessionId));
}
