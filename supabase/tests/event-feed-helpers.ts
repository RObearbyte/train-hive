import { admin, asUser, rpc, rpcRow } from './helpers';

/**
 * Helpers for the event feed (P4) suites. Not a test file.
 */

export interface EventPost {
  id: string;
  session_id: string;
  community_id: string;
  author_id: string | null;
  parent_id: string | null;
  body: string | null;
  created_at: Date;
  deleted_at: Date | null;
}

export interface FeedRead {
  session_id: string;
  user_id: string;
  last_read_at: Date;
}

export interface FeedItem {
  id: string;
  parent_id: string | null;
  author_id: string | null;
  author_name: string | null;
  author_role: 'organizer' | 'member' | null;
  body: string;
  created_at: string;
  is_unread: boolean;
  can_delete: boolean;
}

export interface EventFeed {
  session_id: string;
  community_id: string;
  is_organizer: boolean;
  closes_at: string;
  is_open: boolean;
  can_post: boolean;
  can_reply: boolean;
  last_read_at: string | null;
  post_count: number;
  unread_count: number;
  posts: (FeedItem & { replies: FeedItem[] })[];
}

export interface FeedUnread {
  session_id: string;
  post_count: number;
  unread_count: number;
  last_post_at: string;
}

export function createPost(userId: string, sessionId: string | null, body: unknown = 'Bring water.'): Promise<EventPost> {
  return asUser(userId, (db) => rpcRow<EventPost>(db, 'create_event_post', [sessionId, body]));
}

export function replyTo(userId: string, postId: string | null, body: unknown = 'See you there!'): Promise<EventPost> {
  return asUser(userId, (db) => rpcRow<EventPost>(db, 'reply_to_event_post', [postId, body]));
}

export function deletePost(userId: string, postId: string | null): Promise<EventPost> {
  return asUser(userId, (db) => rpcRow<EventPost>(db, 'delete_event_post', [postId]));
}

export function markFeedRead(userId: string, sessionId: string | null): Promise<FeedRead> {
  return asUser(userId, (db) => rpcRow<FeedRead>(db, 'mark_event_feed_read', [sessionId]));
}

export function eventFeed(userId: string, sessionId: string | null): Promise<EventFeed> {
  return asUser(userId, (db) => rpc<EventFeed>(db, 'get_event_feed', [sessionId]));
}

export function feedUnread(userId: string, communityId: string | null): Promise<FeedUnread[]> {
  return asUser(userId, (db) => rpc<FeedUnread[]>(db, 'get_event_feed_unread', [communityId]));
}

/** The stored post row (superuser). */
export async function storedPost(id: string): Promise<EventPost | undefined> {
  const { rows } = await admin.query<EventPost>('select * from public.event_posts where id = $1', [id]);
  return rows[0];
}

/** Time travel: moves a post's created_at back by `minutes`. */
export async function agePost(id: string, minutes: number): Promise<void> {
  await admin.query(
    "update public.event_posts set created_at = created_at - make_interval(mins => $2) where id = $1",
    [id, minutes],
  );
}

/**
 * Time travel: makes an event end `daysAgo` days ago (deadline, start and end moved together,
 * so every table check still holds). With `endsAt: false` the event has no end time (the feed
 * then closes 30 days after start + 2 hours).
 */
export async function endEventDaysAgo(sessionId: string, daysAgo: number, endsAt = true): Promise<void> {
  await admin.query(
    `update public.training_sessions
     set rsvp_deadline = now() - make_interval(days => $2) - interval '5 hours',
         starts_at = now() - make_interval(days => $2) - interval '3 hours',
         ends_at = case when $3::boolean then now() - make_interval(days => $2) else null end
     where id = $1`,
    [sessionId, daysAgo, endsAt],
  );
}
