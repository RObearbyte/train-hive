import type {
  EventSubtype,
  RsvpResponse,
  TrainingInput,
  TrainingSession,
} from '@/lib/database.types';
import { toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

import type { MyRsvps } from './keys';

/** Newest sessions kept in the list; older history arrives with statistics (Milestone 4). */
export const SESSION_LIST_LIMIT = 200;

/**
 * Sessions of a community, newest start first. RLS returns rows only to
 * active members, so a removed member simply gets an empty list.
 */
export async function fetchCommunitySessions(communityId: string): Promise<TrainingSession[]> {
  const { data, error } = await getSupabase()
    .from('training_sessions')
    .select('*')
    .eq('community_id', communityId)
    .order('starts_at', { ascending: false })
    .limit(SESSION_LIST_LIMIT);
  if (error) throw toAppError(error);
  return data;
}

/** One session, or null when it does not exist or the caller may not see it. */
export async function fetchSession(sessionId: string): Promise<TrainingSession | null> {
  const { data, error } = await getSupabase()
    .from('training_sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle();
  if (error) throw toAppError(error);
  return data;
}

/**
 * The caller's answers in every community they belong to, keyed by session id.
 * Session ids are unique, so one map serves whichever community is active and
 * switching never needs a different cache entry.
 */
export async function fetchMyRsvps(userId: string): Promise<MyRsvps> {
  const { data, error } = await getSupabase()
    .from('training_rsvps')
    .select('session_id, response')
    .eq('user_id', userId);
  if (error) throw toAppError(error);

  const mine: MyRsvps = {};
  for (const row of data) mine[row.session_id] = row.response;
  return mine;
}

export type Participant = {
  userId: string;
  response: RsvpResponse;
  /** Falls back to a neutral label when the profile is not visible (a former member). */
  displayName: string;
  respondedAt: string;
};

export const UNKNOWN_PARTICIPANT_NAME = 'Former member';

/** Everyone who answered for a session, with their display names. */
export async function fetchParticipants(sessionId: string): Promise<Participant[]> {
  const { data, error } = await getSupabase()
    .from('training_rsvps')
    // training_rsvps has a single foreign key to profiles; the name keeps the embed unambiguous.
    .select('user_id, response, responded_at, profile:profiles!training_rsvps_user_id_fkey(display_name)')
    .eq('session_id', sessionId);
  if (error) throw toAppError(error);

  return data.map((row) => ({
    userId: row.user_id,
    response: row.response,
    displayName: row.profile?.display_name ?? UNKNOWN_PARTICIPANT_NAME,
    respondedAt: row.responded_at,
  }));
}

/**
 * The organizer's display name, or null when their profile is not visible.
 * training_sessions has two foreign keys to profiles (organizer_id and
 * cancelled_by), so the embed must name the one it means.
 */
export async function fetchOrganizerName(sessionId: string): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from('training_sessions')
    .select('organizer:profiles!training_sessions_organizer_id_fkey(display_name)')
    .eq('id', sessionId)
    .maybeSingle();
  if (error) throw toAppError(error);
  return data?.organizer?.display_name ?? null;
}

/**
 * Creates an event of any kind (organizer only). Throws AppError: `forbidden`,
 * `validation_failed` with the column in `field`, `network_error`, ...
 */
export async function createTraining(
  communityId: string,
  input: TrainingInput,
): Promise<TrainingSession> {
  const { data, error } = await getSupabase().rpc('create_training', {
    p_community_id: communityId,
    p_input: input,
  });
  if (error) throw toAppError(error);
  return data;
}

/**
 * Replaces the editable fields of a training (organizer only). Throws
 * AppError: `session_not_editable`, `validation_failed` (also for a frozen
 * field that was changed), `forbidden`, `not_found`, ...
 */
export async function updateTraining(
  sessionId: string,
  input: TrainingInput,
): Promise<TrainingSession> {
  const { data, error } = await getSupabase().rpc('update_training', {
    p_session_id: sessionId,
    p_input: input,
  });
  if (error) throw toAppError(error);
  return data;
}

/**
 * Cancels an event (organizer only) with an optional note of up to 300 characters (null = none). Already cancelled returns the row
 * unchanged. Throws AppError: `session_not_cancellable`, `forbidden`, `not_found`, ...
 */
export async function cancelTraining(
  sessionId: string,
  reason: string | null = null,
): Promise<TrainingSession> {
  const { data, error } = await getSupabase().rpc('cancel_training', {
    p_session_id: sessionId,
    p_reason: reason,
  });
  if (error) throw toAppError(error);
  return data;
}

/** The event subtype lookup table (all kinds), in display order. */
export async function fetchEventSubtypes(): Promise<EventSubtype[]> {
  const { data, error } = await getSupabase()
    .from('event_subtypes')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error) throw toAppError(error);
  return data;
}
