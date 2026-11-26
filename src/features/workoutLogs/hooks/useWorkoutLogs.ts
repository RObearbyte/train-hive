import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useSession } from '@/features/community/hooks/SessionProvider';
import { consentKeys } from '@/features/legal/api/keys';
import type {
  CommunityWorkoutStats,
  DeleteWorkoutLogResult,
  LiftKey,
  MaxEffortCandidates,
  MaxEffortConfirmation,
  MyWorkoutStats,
  PersonalRecords,
  StatisticsWindow,
  WorkoutLog,
  WorkoutLogInput,
  WorkoutLogPage,
  WorkoutLogScreen,
} from '@/lib/database.types';
import { toAppError, type AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';

import {
  confirmMaxEffort,
  deleteWorkoutLog,
  fetchCommunityWorkoutStats,
  fetchMaxEffortCandidates,
  fetchMyWorkoutStats,
  fetchPersonalRecords,
  fetchWorkoutLogPage,
  fetchWorkoutLogScreen,
  saveWorkoutLog,
} from '../api/workoutLogs';
import { workoutKeys } from '../api/keys';
import { applyConfirmation } from '../domain/personalRecords';

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

/**
 * The max-effort question of my log of an event. `enabled`: only for a strength log that exists
 * (the server answers `not_found` without a log).
 */
export function useMaxEffortCandidates(sessionId: string, enabled: boolean) {
  const { userId } = useSession();
  return useQuery<MaxEffortCandidates, AppError>({
    queryKey: workoutKeys.candidates(sessionId),
    queryFn: () => fetchMaxEffortCandidates(sessionId).catch((error: unknown) => Promise.reject(toAppError(error))),
    enabled: enabled && userId !== null,
    ...SENSITIVE,
  });
}

/** Reads the max-effort question fresh from the server (right after a save) and caches it. */
export function useLoadMaxEffortCandidates(sessionId: string) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.fetchQuery<MaxEffortCandidates, AppError>({
      queryKey: workoutKeys.candidates(sessionId),
      queryFn: () => fetchMaxEffortCandidates(sessionId).catch((error: unknown) => Promise.reject(toAppError(error))),
      staleTime: 0,
      gcTime: SENSITIVE.gcTime,
    });
}

export type MaxEffortAnswer = { lift: LiftKey; reps: number; weightKg: number; confirmed: boolean };

/**
 * Yes / No to one candidate. Not optimistic: the server checks the set and decides whether it is
 * a record; its answer is written into the question and the records are read again.
 */
export function useConfirmMaxEffort(sessionId: string) {
  const queryClient = useQueryClient();
  const { userId } = useSession();
  return useMutation<MaxEffortConfirmation, AppError, MaxEffortAnswer>({
    mutationFn: async (answer) => {
      try {
        return await confirmMaxEffort(sessionId, answer);
      } catch (error) {
        throw toAppError(error);
      }
    },
    onSuccess: (result) => {
      queryClient.setQueryData<MaxEffortCandidates>(workoutKeys.candidates(sessionId), (current) =>
        current ? applyConfirmation(current, result) : current,
      );
    },
    onError: (error) => reportError('workoutLogs.confirmMaxEffort', error.code),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: workoutKeys.records(userId) });
      void queryClient.invalidateQueries({ queryKey: workoutKeys.candidates(sessionId) });
    },
  });
}

/** My personal bests. */
export function useMyPersonalRecords() {
  const { userId } = useSession();
  return useQuery<PersonalRecords, AppError>({
    queryKey: workoutKeys.records(userId),
    queryFn: () => fetchPersonalRecords().catch((error: unknown) => Promise.reject(toAppError(error))),
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
