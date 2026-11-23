/**
 * Supabase Auth calls for e-mail linking and e-mail sign-in (code only, no
 * passwords, no OAuth). Every failure becomes an `EmailAuthError` with a kind
 * the screens turn into friendly text.
 *
 * - Link: `updateUser({ email })` on the anonymous session keeps the user id
 *   (and so memberships and data), sends the "Confirm email change" mail, and
 *   `verifyOtp({ type: 'email_change' })` completes it.
 * - Sign in: `signInWithOtp({ shouldCreateUser: false })` sends the "Magic
 *   Link" mail; `verifyOtp({ type: 'email' })` signs in.
 */
import { classifyAuthError, normalizeEmail, type AuthFailureKind } from '../domain/emailLinking';
import { getSupabase } from '@/lib/supabase';

export class EmailAuthError extends Error {
  readonly kind: AuthFailureKind;
  readonly original: unknown;

  constructor(kind: AuthFailureKind, original: unknown) {
    super(`email auth failed: ${kind}`);
    this.name = 'EmailAuthError';
    this.kind = kind;
    this.original = original;
  }
}

function fail(error: unknown): never {
  throw new EmailAuthError(classifyAuthError(error), error);
}

/** Starts linking: sends the code to `email`. The user stays anonymous until the code is confirmed. */
export async function requestEmailLink(email: string): Promise<void> {
  const { error } = await getSupabase().auth.updateUser({ email: normalizeEmail(email) });
  if (error) fail(error);
}

/** Sends the link code again (for an address already passed to `requestEmailLink`). */
export async function resendEmailLink(email: string): Promise<void> {
  const { error } = await getSupabase().auth.resend({ type: 'email_change', email: normalizeEmail(email) });
  if (error) fail(error);
}

/** Completes linking. The session's user is no longer anonymous afterwards (the auth listener delivers it). */
export async function confirmEmailLink(email: string, token: string): Promise<void> {
  const { error } = await getSupabase().auth.verifyOtp({
    email: normalizeEmail(email),
    token: token.trim(),
    type: 'email_change',
  });
  if (error) fail(error);
}

/**
 * Asks for a sign-in code. An address without an account is NOT an error for
 * the caller: it gets the same outcome as one with an account, so the screen
 * never reveals which addresses exist.
 */
export async function requestSignInCode(email: string): Promise<void> {
  const { error } = await getSupabase().auth.signInWithOtp({
    email: normalizeEmail(email),
    options: { shouldCreateUser: false },
  });
  if (!error) return;
  const kind = classifyAuthError(error);
  if (kind === 'no_account') return;
  throw new EmailAuthError(kind, error);
}

/** Signs in with the code. The new session reaches the app through the auth listener. */
export async function confirmSignIn(email: string, token: string): Promise<void> {
  const { error } = await getSupabase().auth.verifyOtp({
    email: normalizeEmail(email),
    token: token.trim(),
    type: 'email',
  });
  if (error) fail(error);
}
