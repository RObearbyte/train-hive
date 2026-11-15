import { toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

import type { NotificationPrefs, PrefsPatch } from '../domain/preferencesCache';

function pick(row: NotificationPrefs): NotificationPrefs {
  return {
    push_enabled: row.push_enabled,
    training_reminders: row.training_reminders,
    announcements: row.announcements,
    training_updates: row.training_updates,
  };
}

/** My push preferences; all true when I never saved any (the server says so). */
export async function fetchNotificationPreferences(): Promise<NotificationPrefs> {
  const { data, error } = await getSupabase().rpc('get_notification_preferences');
  if (error) throw toAppError(error);
  return pick(data);
}

/** Saves the given fields; the others keep their value. Returns the stored preferences. */
export async function saveNotificationPreferences(patch: PrefsPatch): Promise<NotificationPrefs> {
  const { data, error } = await getSupabase().rpc('set_notification_preferences', {
    p_push_enabled: patch.push_enabled ?? null,
    p_training_reminders: patch.training_reminders ?? null,
    p_announcements: patch.announcements ?? null,
    p_training_updates: patch.training_updates ?? null,
  });
  if (error) throw toAppError(error);
  return pick(data);
}
