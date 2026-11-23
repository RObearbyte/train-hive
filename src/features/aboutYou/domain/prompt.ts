/**
 * The one-time "About you" page: shown once after a person joins or creates
 * their first community, remembered on this device. Pure TypeScript.
 */
import { FEATURES, type LegalFeatures } from '@/features/legal/constants';

/** Stored next to the session, per user, so another account on this device is asked on its own. Cleared on sign-out and account deletion. */
export function aboutYouPromptStorageKey(userId: string): string {
  return `trainhive.about-you-seen.${userId}`;
}

export const ABOUT_YOU_SEEN_VALUE = '1';

export function parseSeen(stored: string | null): boolean {
  return stored === ABOUT_YOU_SEEN_VALUE;
}

/** The page collects only what the shipped features describe in the notice. */
export function aboutYouAvailable(features: LegalFeatures = FEATURES): boolean {
  return features.demographics || features.emergencyContact;
}

export type PromptState = 'checking' | 'show' | 'done';

/**
 * `seen`: undefined while the device is being read, null when the read failed
 * (then the page is not pushed on the person), else whether they dealt with it.
 */
export function promptState(input: { available: boolean; seen: boolean | null | undefined }): PromptState {
  if (!input.available) return 'done';
  if (input.seen === undefined) return 'checking';
  if (input.seen === null || input.seen) return 'done';
  return 'show';
}

/** Where the first-time page lives; `welcome=1` switches it to the skippable first-time layout. */
export const ABOUT_YOU_ROUTE = '/about-you';
export const ABOUT_YOU_WELCOME_ROUTE = '/about-you?welcome=1';
