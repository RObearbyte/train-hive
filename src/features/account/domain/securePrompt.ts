/**
 * The one-time "Secure your account" page: offered once, right after a person
 * joins or creates their first community, remembered on this device. Pure TypeScript.
 */
import { FEATURES, type LegalFeatures } from '@/features/legal/constants';

/** Stored next to the session, per user. Cleared on sign-out and account deletion (see `signOut.ts`). */
export function securePromptStorageKey(userId: string): string {
  return `trainhive.secure-account-seen.${userId}`;
}

export const SECURE_SEEN_VALUE = '1';

export function parseSecureSeen(stored: string | null): boolean {
  return stored === SECURE_SEEN_VALUE;
}

/** Only while email linking is a shipped feature (the notice describes it). */
export function secureAccountAvailable(features: LegalFeatures = FEATURES): boolean {
  return features.accountLinking;
}

/** Where the page lives (file: `src/app/(app)/secure-account.tsx`). */
export const SECURE_ACCOUNT_ROUTE = '/secure-account';
