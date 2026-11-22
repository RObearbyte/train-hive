/**
 * TanStack Query keys for the event feed (discussion under an event).
 *
 * Cached shapes:
 * - `eventFeedKeys.feed(sessionId)`        -> `EventFeed`
 * - `eventFeedKeys.unread(communityId)`    -> `EventFeedUnread[]`
 */
export const eventFeedKeys = {
  all: ['eventFeed'] as const,
  feeds: () => ['eventFeed', 'feed'] as const,
  feed: (sessionId: string) => ['eventFeed', 'feed', sessionId] as const,
  unreads: () => ['eventFeed', 'unread'] as const,
  unread: (communityId: string | null) => ['eventFeed', 'unread', communityId] as const,
};
