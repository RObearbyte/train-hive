import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useSession } from '@/features/community/hooks/SessionProvider';
import { consentKeys } from '@/features/legal/api/keys';
import type {
  CommunityWorkoutStats,
  DeleteWorkoutLogResult,
  MyWorkoutStats,
  StatisticsWindow,
  WorkoutLog,
  WorkoutLogInput,
  WorkoutLogPage,
  WorkoutLogScreen,
} from '@/lib/database.types';
import { toAppError, type AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';

import {
  deleteWorkoutLog,
  fetchCommunityWorkoutStats,
  fetchMyWorkoutStats,
  fetchWorkoutLogPage,
  fetchWorkoutLogScreen,
  saveWorkoutLog,
} from '../api/workoutLogs';
import { workoutKeys } from '../api/keys';

/**
 * Workout data is health-related: it is read again every time a screen asks and
 * dropped from memory shortly after the screen is gone.
 */
const SENSITIVE = { staleTime: 0, gcTime: 30_000 } as const;

/** The log screen context of one event (can_log, reason, consent, my log). */
export function useWorkoutLogScreen(sessionId: string) {
  const { userId } = useSession();
  return useQuery<WorkoutLogScreen, AppError>({
    queryKey: workoutKeys.screen(sessionId),
    queryFn: () => fetchWorkoutLogScreen(sessionId).catch((error: unknown) => Promise.reject(toAppError(error))),
    enabled: userId !== null,
    ...SENSITIVE,
  });
}

/** Everything that depends on my logs is read again after a change. */
function useRefreshWorkoutData() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: workoutKeys.all });
    void queryClient.invalidateQueries({ queryKey: consentKeys.all });
  };
}

/**
 * Saves the whole log (recording the agreement first when it is not on record). Not
 * optimistic: the server decides and returns the stored copy.
 */
export function useSaveWorkoutLog(sessionId: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshWorkoutData();
  return useMutation<WorkoutLog, AppError, { input: WorkoutLogInput; recordConsent: boolean }>({
    mutationFn: async ({ input, recordConsent }) => {
      try {
        return await saveWorkoutLog(sessionId, input, recordConsent);
      } catch (error) {
        throw toAppError(error);
      }
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<WorkoutLogScreen>(workoutKeys.screen(sessionId), (current) =>
        current ? { ...current, log: saved, has_consent: true } : current,
      );
    },
    onError: (error) => reportError('workoutLogs.save', error.code),
    onSettled: refresh,
  });
}

export function useDeleteWorkoutLog(sessionId: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshWorkoutData();
  return useMutation<DeleteWorkoutLogResult, AppError, void>({
    mutationFn: async () => {
      try {
        return await deleteWorkoutLog(sessionId);
      } catch (error) {
        throw toAppError(error);
      }
    },
    onSuccess: () => {
      queryClient.setQueryData<WorkoutLogScreen>(workoutKeys.screen(sessionId), (current) =>
        current ? { ...current, log: null } : current,
      );
    },
    onError: (error) => reportError('workoutLogs.delete', error.code),
    onSettled: refresh,
  });
}

/** My logs, newest event first, loaded page by page. */
export function useMyWorkoutLogs() {
  const { userId } = useSession();
  return useInfiniteQuery<
    WorkoutLogPage,
    AppError,
    { pages: WorkoutLogPage[]; pageParams: (string | null)[] },
    ReturnType<typeof workoutKeys.list>,
    string | null
  >({
    queryKey: workoutKeys.list(userId),
    initialPageParam: null,
    queryFn: ({ pageParam }) => fetchWorkoutLogPage(pageParam).catch((error: unknown) => Promise.reject(toAppError(error))),
    getNextPageParam: (last) => last.next_before,
    enabled: userId !== null,
    ...SENSITIVE,
  });
}

/** My totals (all time) for the community (null: every community). */
export function useMyWorkoutStats(communityId: string | null) {
  const { userId } = useSession();
  return useQuery<MyWorkoutStats, AppError>({
    queryKey: workoutKeys.myStats(userId, communityId),
    queryFn: () => fetchMyWorkoutStats(communityId).catch((error: unknown) => Promise.reject(toAppError(error))),
    enabled: userId !== null,
    ...SENSITIVE,
  });
}

/** Organizers: approximate community totals. */
export function useCommunityWorkoutStats(communityId: string | null, window: StatisticsWindow) {
  return useQuery<CommunityWorkoutStats, AppError>({
    queryKey: workoutKeys.community(communityId, window),
    queryFn: () =>
      fetchCommunityWorkoutStats(communityId as string, window).catch((error: unknown) =>
        Promise.reject(toAppError(error)),
      ),
    enabled: communityId !== null,
    ...SENSITIVE,
  });
}
