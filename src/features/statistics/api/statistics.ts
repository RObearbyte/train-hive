import type {
  AttendanceHistoryPage,
  CommunityStatistics,
  MemberStatistics,
  MemberStatisticsSummary,
  MyStatistics,
  StatisticsWindow,
} from '@/lib/database.types';
import { AppError, toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

/** Items per history page (the server accepts 1 to 100). */
export const HISTORY_PAGE_SIZE = 20;

/**
 * The statistics RPCs return jsonb shaped like the contract's payload types.
 * A null or non-object answer means the call did not do its job: surface it
 * as an error instead of rendering from nothing.
 */
function payload<T>(data: unknown, rpc: string): T {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new AppError('unknown', { message: `${rpc} returned no payload`, original: data });
  }
  return data as T;
}

/** The caller's own numbers (any active member). */
export async function fetchMyStatistics(
  communityId: string,
  window: StatisticsWindow,
): Promise<MyStatistics> {
  const { data, error } = await getSupabase().rpc('get_my_statistics', {
    p_community_id: communityId,
    p_window: window,
  });
  if (error) throw toAppError(error);
  return payload<MyStatistics>(data, 'get_my_statistics');
}

/** One page of my attendance history; `before` is the previous page's `next_before`, verbatim. */
export async function fetchMyAttendanceHistory(
  communityId: string,
  window: StatisticsWindow,
  before: string | null,
): Promise<AttendanceHistoryPage> {
  const { data, error } = await getSupabase().rpc('get_my_attendance_history', {
    p_community_id: communityId,
    p_window: window,
    p_limit: HISTORY_PAGE_SIZE,
    p_before: before,
  });
  if (error) throw toAppError(error);
  return payload<AttendanceHistoryPage>(data, 'get_my_attendance_history');
}

/** Organizers only: one page of a member's history (the member may be removed); `before` is the previous `next_before`, verbatim. */
export async function fetchMemberAttendanceHistory(
  communityId: string,
  userId: string,
  window: StatisticsWindow,
  before: string | null,
): Promise<AttendanceHistoryPage> {
  const { data, error } = await getSupabase().rpc('get_member_attendance_history', {
    p_community_id: communityId,
    p_user_id: userId,
    p_window: window,
    p_limit: HISTORY_PAGE_SIZE,
    p_before: before,
  });
  if (error) throw toAppError(error);
  return payload<AttendanceHistoryPage>(data, 'get_member_attendance_history');
}

/** Organizers only (`forbidden` otherwise). The member may be removed. */
export async function fetchMemberStatistics(
  communityId: string,
  userId: string,
  window: StatisticsWindow,
): Promise<MemberStatistics> {
  const { data, error } = await getSupabase().rpc('get_member_statistics', {
    p_community_id: communityId,
    p_user_id: userId,
    p_window: window,
  });
  if (error) throw toAppError(error);
  return payload<MemberStatistics>(data, 'get_member_statistics');
}

/** Organizers only (`forbidden` otherwise). */
export async function fetchCommunityStatistics(
  communityId: string,
  window: StatisticsWindow,
): Promise<CommunityStatistics> {
  const { data, error } = await getSupabase().rpc('get_community_statistics', {
    p_community_id: communityId,
    p_window: window,
  });
  if (error) throw toAppError(error);
  return payload<CommunityStatistics>(data, 'get_community_statistics');
}

/** Organizers only: every active member's numbers, by name (at most 500). */
export async function fetchMemberSummary(
  communityId: string,
  window: StatisticsWindow,
): Promise<MemberStatisticsSummary> {
  const { data, error } = await getSupabase().rpc('list_member_statistics_summary', {
    p_community_id: communityId,
    p_window: window,
  });
  if (error) throw toAppError(error);
  return payload<MemberStatisticsSummary>(data, 'list_member_statistics_summary');
}
