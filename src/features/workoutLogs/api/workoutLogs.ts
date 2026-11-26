import { recordConsent } from '@/features/legal/api/consents';
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
import { AppError, toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

import { isMaxEffortCandidates, isMaxEffortConfirmation, isPersonalRecords } from '../domain/personalRecords';
import {
  isCommunityWorkoutStats,
  isMyWorkoutStats,
  isWorkoutLog,
  isWorkoutLogPage,
  isWorkoutLogScreen,
} from '../domain/workoutLog';

export const PAGE_SIZE = 20;

/** Keeps only the function name: the answer is personal data and must not reach AppError.original or the logs. */
function unexpected(fn: string): AppError {
  return new AppError('unknown', { message: `${fn} returned an unexpected shape` });
}

/** What the log screen needs for one event. Throws AppError (`not_found`, `not_a_member`, ...). */
export async function fetchWorkoutLogScreen(sessionId: string): Promise<WorkoutLogScreen> {
  const { data, error } = await getSupabase().rpc('get_my_workout_log', { p_session_id: sessionId });
  if (error) throw toAppError(error);
  if (!isWorkoutLogScreen(data)) throw unexpected('get_my_workout_log');
  return data;
}

/**
 * Saves the whole log. When the agreement is not on record (`recordFirst`), records it first.
 * Throws AppError: `consent_required` (field `workout_logs`), `not_loggable`, `event_not_ended`,
 * `not_eligible`, `validation_failed:<field>`, ...
 */
export async function saveWorkoutLog(
  sessionId: string,
  input: WorkoutLogInput,
  recordFirst: boolean,
): Promise<WorkoutLog> {
  if (recordFirst) await recordConsent('workout_logs');
  const { data, error } = await getSupabase().rpc('save_workout_log', {
    p_session_id: sessionId,
    p_input: input,
  });
  if (error) throw toAppError(error);
  if (!isWorkoutLog(data)) throw unexpected('save_workout_log');
  return data;
}

export async function deleteWorkoutLog(sessionId: string): Promise<DeleteWorkoutLogResult> {
  const { data, error } = await getSupabase().rpc('delete_my_workout_log', { p_session_id: sessionId });
  if (error) throw toAppError(error);
  const result = data as DeleteWorkoutLogResult | null;
  if (typeof result !== 'object' || result === null || typeof result.deleted !== 'boolean') {
    throw unexpected('delete_my_workout_log');
  }
  return result;
}

/** One page of my logs, newest event first; pass the previous page's `next_before`. */
export async function fetchWorkoutLogPage(before: string | null): Promise<WorkoutLogPage> {
  const { data, error } = await getSupabase().rpc('list_my_workout_logs', {
    p_limit: PAGE_SIZE,
    p_before: before,
  });
  if (error) throw toAppError(error);
  if (!isWorkoutLogPage(data)) throw unexpected('list_my_workout_logs');
  return data;
}

/** My totals (all time), optionally for one community. */
export async function fetchMyWorkoutStats(communityId: string | null): Promise<MyWorkoutStats> {
  const { data, error } = await getSupabase().rpc('get_my_workout_stats', {
    p_community_id: communityId,
    p_from: null,
    p_to: null,
  });
  if (error) throw toAppError(error);
  if (!isMyWorkoutStats(data)) throw unexpected('get_my_workout_stats');
  return data;
}

/**
 * The qualifying sets of my log of an event (heaviest set per record lift x 1-3 reps).
 * Throws AppError `not_found` when I have no log of it.
 */
export async function fetchMaxEffortCandidates(sessionId: string): Promise<MaxEffortCandidates> {
  const { data, error } = await getSupabase().rpc('get_max_effort_candidates', { p_session_id: sessionId });
  if (error) throw toAppError(error);
  if (!isMaxEffortCandidates(data)) throw unexpected('get_max_effort_candidates');
  return data;
}

/**
 * Confirms (true) or removes (false) a maximal effort. Throws AppError `set_not_found`,
 * `consent_required` (field `workout_logs`), `not_found`, `validation_failed:<lift|reps|weight_kg|confirmed>`.
 */
export async function confirmMaxEffort(
  sessionId: string,
  answer: { lift: LiftKey; reps: number; weightKg: number; confirmed: boolean },
): Promise<MaxEffortConfirmation> {
  const { data, error } = await getSupabase().rpc('confirm_max_effort', {
    p_session_id: sessionId,
    p_lift: answer.lift,
    p_reps: answer.reps,
    p_weight_kg: answer.weightKg,
    p_confirmed: answer.confirmed,
  });
  if (error) throw toAppError(error);
  if (!isMaxEffortConfirmation(data)) throw unexpected('confirm_max_effort');
  return data;
}

/** My personal bests (running computed from my logs, lifts from confirmed max efforts). */
export async function fetchPersonalRecords(): Promise<PersonalRecords> {
  const { data, error } = await getSupabase().rpc('get_my_personal_records');
  if (error) throw toAppError(error);
  if (!isPersonalRecords(data)) throw unexpected('get_my_personal_records');
  return data;
}

/** Organizers only: approximate totals. Throws `forbidden` for members. */
export async function fetchCommunityWorkoutStats(
  communityId: string,
  window: StatisticsWindow,
): Promise<CommunityWorkoutStats> {
  const { data, error } = await getSupabase().rpc('get_community_workout_stats', {
    p_community_id: communityId,
    p_window: window,
  });
  if (error) throw toAppError(error);
  if (!isCommunityWorkoutStats(data)) throw unexpected('get_community_workout_stats');
  return data;
}
