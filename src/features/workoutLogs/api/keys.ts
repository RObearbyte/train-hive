/**
 * TanStack Query keys for workout logs. Everything here is personal (health-related) data:
 * the hooks keep it in memory only briefly after a screen is gone.
 *
 * Cached shapes:
 * - `workoutKeys.screen(sessionId)`            -> `WorkoutLogScreen` (the log screen / event entry)
 * - `workoutKeys.list(userId)`                 -> infinite list of `WorkoutLogPage`
 * - `workoutKeys.myStats(userId, communityId)` -> `MyWorkoutStats`
 * - `workoutKeys.community(communityId, w)`    -> `CommunityWorkoutStats` (organizers)
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
};
