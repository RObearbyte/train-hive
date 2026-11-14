import type { Profile } from '@/lib/database.types';
import { toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

/**
 * Changes the caller's display name. Throws AppError
 * (`validation_failed` with field `display_name`, `not_found`, `network_error`, ...).
 */
export async function updateDisplayName(displayName: string): Promise<Profile> {
  const { data, error } = await getSupabase().rpc('update_display_name', {
    p_display_name: displayName,
  });
  if (error) throw toAppError(error);
  return data;
}
