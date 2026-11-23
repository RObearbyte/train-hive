import type { AppOpenResult } from '@/lib/database.types';
import { AppError, toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

import { parseAppOpenResult } from '../domain/appOpen';

/**
 * Tells the server the app was opened (at most one write per hour on its side) and ends a pending
 * inactivity notice, which comes back in `notice`. Throws AppError: `not_authenticated`.
 */
export async function recordAppOpen(): Promise<AppOpenResult> {
  const { data, error } = await getSupabase().rpc('record_app_open');
  if (error) throw toAppError(error);
  const parsed = parseAppOpenResult(data);
  if (parsed === null) {
    throw new AppError('unknown', {
      message: 'record_app_open returned an unexpected shape',
      original: data,
    });
  }
  return parsed;
}
