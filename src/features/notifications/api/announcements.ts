import type { Announcement } from '@/lib/database.types';
import { toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

import type { AnnouncementFeed } from './keys';

/** Newest published announcements kept in the feed. */
export const FEED_LIMIT = 100;
/** Scheduled and cancelled announcements an organizer sees. */
export const MANAGED_LIMIT = 50;

/**
 * Published announcements of the community, newest first, and the ids I have
 * read (own `announcement_reads` rows only, by RLS). RLS shows members only
 * the published ones; the explicit status filter also keeps an organizer's
 * scheduled drafts out of the feed.
 */
export async function fetchAnnouncementFeed(communityId: string): Promise<AnnouncementFeed> {
  const supabase = getSupabase();
  const [items, reads] = await Promise.all([
    supabase
      .from('announcements')
      .select('*')
      .eq('community_id', communityId)
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(FEED_LIMIT),
    supabase.from('announcement_reads').select('announcement_id'),
  ]);
  if (items.error) throw toAppError(items.error);
  if (reads.error) throw toAppError(reads.error);
  return { items: items.data, readIds: reads.data.map((row) => row.announcement_id) };
}

/**
 * Scheduled and cancelled announcements. Only organizers can see them (RLS);
 * for a member this is an empty list.
 */
export async function fetchManagedAnnouncements(communityId: string): Promise<Announcement[]> {
  const { data, error } = await getSupabase()
    .from('announcements')
    .select('*')
    .eq('community_id', communityId)
    .in('status', ['scheduled', 'cancelled'])
    .order('created_at', { ascending: false })
    .limit(MANAGED_LIMIT);
  if (error) throw toAppError(error);
  return data;
}

/** One announcement, or null when it does not exist or the caller may not see it. */
export async function fetchAnnouncement(id: string): Promise<Announcement | null> {
  const { data, error } = await getSupabase()
    .from('announcements')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw toAppError(error);
  return data;
}

export type AnnouncementPayload = {
  title: string;
  body: string;
  /** UTC ISO instant, or null to publish now. */
  scheduledFor: string | null;
};

/** Organizer only. Throws AppError: `forbidden`, `validation_failed:<title|body|scheduled_for>`. */
export async function createAnnouncement(
  communityId: string,
  input: AnnouncementPayload,
): Promise<Announcement> {
  const { data, error } = await getSupabase().rpc('create_announcement', {
    p_community_id: communityId,
    p_title: input.title,
    p_body: input.body,
    p_scheduled_for: input.scheduledFor,
  });
  if (error) throw toAppError(error);
  return data;
}

/** Organizer, while `scheduled`. Full replace; a null time publishes now. */
export async function updateAnnouncement(
  id: string,
  input: AnnouncementPayload,
): Promise<Announcement> {
  const { data, error } = await getSupabase().rpc('update_announcement', {
    p_id: id,
    p_title: input.title,
    p_body: input.body,
    p_scheduled_for: input.scheduledFor,
  });
  if (error) throw toAppError(error);
  return data;
}

/** Organizer, while `scheduled`. Throws `announcement_not_cancellable` once published. */
export async function cancelAnnouncement(id: string): Promise<Announcement> {
  const { data, error } = await getSupabase().rpc('cancel_announcement', { p_id: id });
  if (error) throw toAppError(error);
  return data;
}

/** Idempotent; also marks the announcement's notification read on the server. */
export async function markAnnouncementRead(id: string): Promise<void> {
  const { error } = await getSupabase().rpc('mark_announcement_read', { p_id: id });
  if (error) throw toAppError(error);
}
