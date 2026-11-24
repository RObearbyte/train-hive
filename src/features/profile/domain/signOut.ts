/**
 * Signing out of an anonymous account. Pure: the effects are passed in, so the
 * order and the failure rules are unit tested (`signOut.test.ts`).
 *
 * Order and rules:
 * 1. Best effort: remove this device's push token from the account (a leftover
 *    token would keep notifying this device for an account nobody can reach).
 *    A failure is reported and never blocks.
 * 2. Sign out. If this fails (offline, server error) NOTHING else is cleared:
 *    the person is still signed in and can try again.
 * 3. Only then: clear the stored session and per-device records, the query
 *    cache and in-memory onboarding state. Each cleanup failure is collected as
 *    a warning and the remaining steps still run.
 */
import { aboutYouPromptStorageKey } from '@/features/aboutYou/domain/prompt';
import { securePromptStorageKey } from '@/features/account/domain/securePrompt';
import { activeCommunityStorageKey } from '@/features/community/domain/activeCommunity';
import { ACCEPTANCE_STORAGE_KEY } from '@/features/legal/domain/acceptance';
import { PUSH_PROMPT_DISMISSED_KEY } from '@/features/notifications/domain/pushState';

export const SIGN_OUT_TITLE = 'Sign out of TrainHive?';

export const SIGN_OUT_MESSAGE =
  'You will lose access to this account on this device. TrainHive accounts are anonymous: without a login there is no way to get it back. Your About-you details and your place in the community stay on the server, and nobody can reach them after you sign out. To remove the details first, cancel and use Profile, About you, Clear my About-you data.';

export const SIGN_OUT_MESSAGE_LINKED =
  'You will be signed out of this account on this device. You can sign in again on this or another device with your email: on the welcome screen choose I already have an account and enter the code we email you. Your community and your details stay on the server.';

export const SIGN_OUT_CAPTION = 'Signing out removes this account from this device for good.';
export const SIGN_OUT_CAPTION_LINKED = 'You can sign in again with your email.';

/** The confirmation text: a linked account can come back, an anonymous one cannot. */
export function signOutCopy(linked: boolean): { message: string; caption: string } {
  return linked
    ? { message: SIGN_OUT_MESSAGE_LINKED, caption: SIGN_OUT_CAPTION_LINKED }
    : { message: SIGN_OUT_MESSAGE, caption: SIGN_OUT_CAPTION };
}

/** Every record kept on this device that belongs to the account or its choices (including the "Secure your account" and "About you" page-seen notes). */
export function storedKeysToClear(input: { userId: string | null; authStorageKey: string }): string[] {
  const keys = [input.authStorageKey, ACCEPTANCE_STORAGE_KEY, PUSH_PROMPT_DISMISSED_KEY];
  if (input.userId !== null) {
    keys.push(
      activeCommunityStorageKey(input.userId),
      aboutYouPromptStorageKey(input.userId),
      securePromptStorageKey(input.userId),
    );
  }
  return keys;
}

export type SignOutEffects = {
  /** Best effort; may reject. */
  unregisterDevice: () => Promise<void>;
  /** Ends the session on the server and locally; rejects on failure. */
  signOut: () => Promise<void>;
  removeStored: (key: string) => Promise<void>;
  /** Best effort: deletes the downloaded data file(s) from this device's cache (native; nothing on web). */
  removeExportedFiles: () => Promise<void>;
  clearQueryCache: () => void;
  resetInMemoryState: () => void;
  /** Where cleanup problems are reported (never shown with personal data). */
  report: (context: string, error: unknown) => void;
};

export type SignOutResult =
  | { ok: true; warnings: number }
  | { ok: false; error: unknown };

export async function runSignOut(
  effects: SignOutEffects,
  input: { userId: string | null; authStorageKey: string },
): Promise<SignOutResult> {
  try {
    await effects.unregisterDevice();
  } catch (error) {
    effects.report('signOut.unregisterDevice', error);
  }

  try {
    await effects.signOut();
  } catch (error) {
    return { ok: false, error };
  }

  return { ok: true, warnings: await runLocalCleanup(effects, input) };
}

/**
 * The local half of leaving an account (after sign-out, or after the server
 * deleted it): stored session and per-device records, downloaded data files, query cache, in-memory
 * onboarding state. A failing step is counted, reported and never stops the
 * rest. Returns the number of failed steps.
 */
export async function runLocalCleanup(
  effects: Pick<SignOutEffects, 'removeStored' | 'removeExportedFiles' | 'clearQueryCache' | 'resetInMemoryState' | 'report'>,
  input: { userId: string | null; authStorageKey: string },
): Promise<number> {
  let warnings = 0;
  for (const key of storedKeysToClear(input)) {
    try {
      await effects.removeStored(key);
    } catch (error) {
      warnings += 1;
      effects.report('signOut.removeStored', error);
    }
  }
  // The export holds the person's whole history: it must not outlive their session on a shared device.
  try {
    await effects.removeExportedFiles();
  } catch (error) {
    warnings += 1;
    effects.report('signOut.removeExportedFiles', error);
  }
  for (const step of [effects.clearQueryCache, effects.resetInMemoryState]) {
    try {
      step();
    } catch (error) {
      warnings += 1;
      effects.report('signOut.cleanup', error);
    }
  }
  return warnings;
}
