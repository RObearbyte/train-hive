import type { PushPlatform } from '@/lib/database.types';
import { toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

/**
 * Upserts this installation's Expo push token for the signed-in user
 * (`register_push_token`; re-assigns a token another account held here).
 * Throws AppError: `validation_failed:<token|platform|device_label>`, `not_a_member`.
 */
export async function registerPushToken(
  token: string,
  platform: PushPlatform,
  deviceLabel: string | null,
): Promise<void> {
  const { error } = await getSupabase().rpc('register_push_token', {
    p_token: token,
    p_platform: platform,
    p_device_label: deviceLabel,
  });
  if (error) throw toAppError(error);
}
