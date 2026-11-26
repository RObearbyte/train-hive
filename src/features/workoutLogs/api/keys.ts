/**
 * TanStack Query keys for workout logs. Everything here is personal (health-related) data:
 * the hooks keep it in memory only briefly after a screen is gone.
 *
 * Cached shapes:
 * - `workoutKeys.screen(sessionId)`            -> `WorkoutLogScreen` (the log screen / event entry)
 * - `workoutKeys.list(userId)`                 -> infinite list of `WorkoutLogPage`
 * - `workoutKeys.myStats(userId, communityId)` -> `MyWorkoutStats`
 * - `workoutKeys.community(communityId, w)`    -> `CommunityWorkoutStats` (organizers)
 * - `workoutKeys.candidates(sessionId)`        -> `MaxEffortCandidates` (the max-effort question of a log)
 * - `workoutKeys.records(userId)`              -> `PersonalRecords`
 *
 * Every key starts with `workoutLogs`, so a save, a delete and the withdrawal of the
 * `workout_logs` consent (which removes `workoutKeys.all`) reach the records too.
 */
import type { StatisticsWindow } from '@/lib/database.types';

export const workoutKeys = {
  all: ['workoutLogs'] as const,
  screen: (sessionId: string) => ['workoutLogs', 'screen', sessionId] as const,
  list: (userId: string | null) => ['workoutLogs', 'list', userId] as const,
  myStats: (userId: string | null, communityId: string | null) =>
    ['workoutLogs', 'myStats', userId, communityId] as const,
  community: (communityId: string | null, window: StatisticsWindow) =>
    ['workoutLogs', 'community', communityId, window] as const,
  candidates: (sessionId: string) => ['workoutLogs', 'candidates', sessionId] as const,
  records: (userId: string | null) => ['workoutLogs', 'records', userId] as const,
};
