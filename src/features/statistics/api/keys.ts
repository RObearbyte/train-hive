import type { StatisticsWindow } from '@/lib/database.types';

/**
 * Every TanStack Query key for statistics. The window and the signed-in user
 * are part of each key, so switching the filter or the account never shows
 * another window's or another person's numbers.
 *
 * Cached shapes:
 * - `mine`      -> `MyStatistics`
 * - `history`   -> infinite query of `AttendanceHistoryPage`
 * - `member`    -> `MemberStatistics` (organizer looking at one member)
 * - `community` -> `CommunityStatistics` (organizer)
 * - `summary`   -> `MemberStatisticsSummary` (organizer)
 */
export const statisticsKeys = {
  all: ['statistics'] as const,
  mine: (communityId: string | null, userId: string | null, window: StatisticsWindow) =>
    ['statistics', 'mine', communityId, userId, window] as const,
  history: (communityId: string | null, userId: string | null, window: StatisticsWindow) =>
    ['statistics', 'history', communityId, userId, window] as const,
  member: (communityId: string | null, memberId: string | null, window: StatisticsWindow) =>
    ['statistics', 'member', communityId, memberId, window] as const,
  community: (communityId: string | null, window: StatisticsWindow) =>
    ['statistics', 'community', communityId, window] as const,
  summary: (communityId: string | null, window: StatisticsWindow) =>
    ['statistics', 'summary', communityId, window] as const,
};
