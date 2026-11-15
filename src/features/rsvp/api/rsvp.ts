import type { RsvpResponse, SetRsvpResult } from '@/lib/database.types';
import { toAppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';

/**
 * Sets the caller's answer. The server locks the session, enforces the
 * deadline and capacity, and returns the resulting count and status.
 * Throws AppError: `rsvp_closed`, `session_full`, `not_a_member`, `not_found`,
 * `network_error`, ...
 */
export async function setRsvp(sessionId: string, response: RsvpResponse): Promise<SetRsvpResult> {
  const { data, error } = await getSupabase().rpc('set_rsvp', {
    p_session_id: sessionId,
    p_response: response,
  });
  if (error) throw toAppError(error);

  const result = data as SetRsvpResult | null;
  if (
    !result ||
    typeof result.going_count !== 'number' ||
    typeof result.status !== 'string' ||
    typeof result.response !== 'string'
  ) {
    throw toAppError(new Error('set_rsvp returned an unexpected result.'));
  }
  return result;
}
