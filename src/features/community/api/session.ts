import { AppError, toAppError } from '@/lib/errors';
import { getSupabase, hasStoredSession } from '@/lib/supabase';

let inFlight: Promise<string> | null = null;

async function signInIfNeeded(): Promise<string> {
  const supabase = getSupabase();

  const { data, error } = await supabase.auth.getSession();
  if (error) throw toAppError(error);
  if (data.session) return data.session.user.id;

  // An account is stored but could not be loaded (offline with an expired
  // token). Signing in again would replace it with a new, empty account.
  if (await hasStoredSession()) {
    throw new AppError('network_error', {
      message: 'A stored session exists but could not be restored.',
    });
  }

  const result = await supabase.auth.signInAnonymously();
  if (result.error) throw toAppError(result.error);
  if (!result.data.session) throw toAppError(new Error('Anonymous sign-in returned no session.'));
  return result.data.session.user.id;
}

/**
 * Returns the current user id, creating an anonymous account first when this
 * device has none. Called right before the first RPC (submitting an
 * invitation code), never on first paint: without a session every RPC is
 * rejected. Concurrent calls share one sign-in so a double tap cannot create
 * two accounts.
 */
export function ensureSession(): Promise<string> {
  inFlight ??= signInIfNeeded().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Tries to load the stored session again (after "offline at start"). The
 * result reaches the app through the auth state listener; this only reports
 * failure.
 */
export async function retryRestoreSession(): Promise<void> {
  const { error } = await getSupabase().auth.getSession();
  if (error) throw toAppError(error);
}
