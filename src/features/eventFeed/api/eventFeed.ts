import type { EventFeed, EventFeedUnread, EventPost } from '@/lib/database.types';
import { AppError, toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

import { isEventFeed, isEventFeedUnreadList } from '../domain/feed';

/** The whole feed of an event. Throws AppError: `not_a_member`, `not_found`. */
export async function fetchEventFeed(sessionId: string): Promise<EventFeed> {
  const { data, error } = await getSupabase().rpc('get_event_feed', { p_session_id: sessionId });
  if (error) throw toAppError(error);
  if (!isEventFeed(data)) {
    throw new AppError('unknown', {
      message: 'get_event_feed returned an unexpected shape',
      original: data,
    });
  }
  return data;
}

/** Events of the community that have posts, with my unread counts. */
export async function fetchEventFeedUnread(communityId: string): Promise<EventFeedUnread[]> {
  const { data, error } = await getSupabase().rpc('get_event_feed_unread', {
    p_community_id: communityId,
  });
  if (error) throw toAppError(error);
  if (!isEventFeedUnreadList(data)) {
    throw new AppError('unknown', {
      message: 'get_event_feed_unread returned an unexpected shape',
      original: data,
    });
  }
  return data;
}

/** Organizers only. Throws `forbidden`, `event_closed`, `validation_failed:body`, `rate_limited`. */
export async function createEventPost(sessionId: string, body: string): Promise<EventPost> {
  const { data, error } = await getSupabase().rpc('create_event_post', {
    p_session_id: sessionId,
    p_body: body,
  });
  if (error) throw toAppError(error);
  return data;
}

/**
 * Any active member: a comment on the event, optionally anonymous (never for organizers).
 * Throws `not_a_member`, `anonymous_not_allowed`, `event_closed`, `validation_failed:body`,
 * `rate_limited` (anonymous only), `alias_pool_exhausted`.
 */
export async function createEventComment(
  sessionId: string,
  body: string,
  anonymous: boolean,
): Promise<EventPost> {
  const { data, error } = await getSupabase().rpc('create_event_comment', {
    p_session_id: sessionId,
    p_body: body,
    p_anonymous: anonymous,
  });
  if (error) throw toAppError(error);
  return data;
}

/**
 * Any active member, to a post or a comment (one level), optionally anonymous. Throws
 * `not_a_member`, `not_a_top_level_post`, `post_deleted`, `event_closed`, `anonymous_not_allowed`,
 * `validation_failed:body`, `rate_limited` (anonymous only), `alias_pool_exhausted`.
 */
export async function replyToEventPost(
  postId: string,
  body: string,
  anonymous: boolean,
): Promise<EventPost> {
  const { data, error } = await getSupabase().rpc('reply_to_event_post', {
    p_post_id: postId,
    p_body: body,
    p_anonymous: anonymous,
  });
  if (error) throw toAppError(error);
  return data;
}

/** Organizers any item, authors their own comments and replies (anonymous ones too). Idempotent. */
export async function deleteEventPost(postId: string): Promise<void> {
  const { error } = await getSupabase().rpc('delete_event_post', { p_post_id: postId });
  if (error) throw toAppError(error);
}

/** Moves my read cursor to the server's now; also marks the event's notifications read. */
export async function markEventFeedRead(sessionId: string): Promise<void> {
  const { error } = await getSupabase().rpc('mark_event_feed_read', { p_session_id: sessionId });
  if (error) throw toAppError(error);
}
