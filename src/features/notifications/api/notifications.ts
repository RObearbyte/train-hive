import type { AppNotification } from '@/lib/database.types';
import { toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

/** Newest notifications kept in the center. */
export const NOTIFICATION_LIMIT = 100;

/** My notifications in the community, newest first (RLS: own rows of an active membership). */
export async function fetchNotifications(
  communityId: string,
  userId: string,
): Promise<AppNotification[]> {
  const { data, error } = await getSupabase()
    .from('notifications')
    .select('*')
    .eq('community_id', communityId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(NOTIFICATION_LIMIT);
  if (error) throw toAppError(error);
  return data;
}

/** Idempotent. Throws `not_found` for a notification that is gone. */
export async function markNotificationRead(id: string): Promise<void> {
  const { error } = await getSupabase().rpc('mark_notification_read', { p_id: id });
  if (error) throw toAppError(error);
}

/** Returns how many notifications changed. */
export async function markAllNotificationsRead(communityId: string): Promise<number> {
  const { data, error } = await getSupabase().rpc('mark_all_notifications_read', {
    p_community_id: communityId,
  });
  if (error) throw toAppError(error);
  return data;
}
