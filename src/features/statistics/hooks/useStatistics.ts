import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';

import { useSession } from '@/features/community/hooks/SessionProvider';
import type {
  AttendanceHistoryPage,
  CommunityStatistics,
  MemberStatistics,
  MemberStatisticsSummary,
  MyStatistics,
  StatisticsWindow,
} from '@/lib/database.types';
import type { AppError } from '@/lib/errors';

import {
  fetchCommunityStatistics,
  fetchMemberAttendanceHistory,
  fetchMemberStatistics,
  fetchMemberSummary,
  fetchMyAttendanceHistory,
  fetchMyStatistics,
} from '../api/statistics';
import { statisticsKeys } from '../api/keys';
import { flattenHistory } from '../domain/summaries';
import { windowStore } from '../domain/windows';

/** The selected time filter, shared by the tab and the member screen, kept while the app runs. */
export function useStatsWindow(): [StatisticsWindow, (value: StatisticsWindow) => void] {
  const value = useSyncExternalStore(windowStore.subscribe, windowStore.get, windowStore.get);
  const set = useCallback((next: StatisticsWindow) => windowStore.set(next), []);
  return [value, set];
}

/** My numbers for the window. */
export function useMyStatistics(communityId: string | null, window: StatisticsWindow) {
  const { userId } = useSession();
  return useQuery<MyStatistics, AppError>({
    queryKey: statisticsKeys.mine(communityId, userId, window),
    queryFn: () => fetchMyStatistics(communityId as string, window),
    enabled: communityId !== null && userId !== null,
  });
}

/** My attendance history, newest first, loaded page by page (`next_before` is passed back verbatim). */
export function useMyAttendanceHistory(communityId: string | null, window: StatisticsWindow) {
  const { userId } = useSession();
  const query = useInfiniteQuery<
    AttendanceHistoryPage,
    AppError,
    { pages: AttendanceHistoryPage[]; pageParams: (string | null)[] },
    ReturnType<typeof statisticsKeys.history>,
    string | null
  >({
    queryKey: statisticsKeys.history(communityId, userId, window),
    initialPageParam: null,
    queryFn: ({ pageParam }) => fetchMyAttendanceHistory(communityId as string, window, pageParam),
    // null / undefined end the list: `next_before` is null exactly when `has_more` is false.
    getNextPageParam: (last) => (last.has_more ? last.next_before : null),
    enabled: communityId !== null && userId !== null,
  });
  return { query, items: flattenHistory(query.data?.pages) };
}

/** Organizer: one member's attendance history, same paging rule (`next_before` verbatim, window in the key). */
export function useMemberAttendanceHistory(
  communityId: string | null,
  memberId: string | null,
  window: StatisticsWindow,
  enabled = true,
) {
  const query = useInfiniteQuery<
    AttendanceHistoryPage,
    AppError,
    { pages: AttendanceHistoryPage[]; pageParams: (string | null)[] },
    ReturnType<typeof statisticsKeys.memberHistory>,
    string | null
  >({
    queryKey: statisticsKeys.memberHistory(communityId, memberId, window),
    initialPageParam: null,
    queryFn: ({ pageParam }) =>
      fetchMemberAttendanceHistory(communityId as string, memberId as string, window, pageParam),
    getNextPageParam: (last) => (last.has_more ? last.next_before : null),
    enabled: enabled && communityId !== null && memberId !== null,
  });
  return { query, items: flattenHistory(query.data?.pages) };
}

/** Organizer: one member's numbers. Pass `enabled = false` for non-organizers (the server refuses them anyway). */
export function useMemberStatistics(
  communityId: string | null,
  memberId: string | null,
  window: StatisticsWindow,
  enabled = true,
) {
  return useQuery<MemberStatistics, AppError>({
    queryKey: statisticsKeys.member(communityId, memberId, window),
    queryFn: () => fetchMemberStatistics(communityId as string, memberId as string, window),
    enabled: enabled && communityId !== null && memberId !== null,
  });
}

/** Organizer: the community overview. */
export function useCommunityStatistics(
  communityId: string | null,
  window: StatisticsWindow,
  enabled: boolean,
) {
  return useQuery<CommunityStatistics, AppError>({
    queryKey: statisticsKeys.community(communityId, window),
    queryFn: () => fetchCommunityStatistics(communityId as string, window),
    enabled: enabled && communityId !== null,
  });
}

/** Organizer: every active member's numbers. */
export function useMemberSummary(
  communityId: string | null,
  window: StatisticsWindow,
  enabled: boolean,
) {
  return useQuery<MemberStatisticsSummary, AppError>({
    queryKey: statisticsKeys.summary(communityId, window),
    queryFn: () => fetchMemberSummary(communityId as string, window),
    enabled: enabled && communityId !== null,
  });
}
