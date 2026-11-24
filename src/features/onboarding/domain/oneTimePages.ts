/**
 * Which one-time page comes next after the first join or create. The two
 * pages queue: "Secure your account" first, then "About you". Pure TypeScript.
 */
export type OneTimePage = 'secure-account' | 'about-you';

/** `wait`: a device note is still being read, so nothing is shown yet (keeps the order stable). */
export type NextOneTimePage = OneTimePage | 'wait' | 'none';

/**
 * Per page: `false` = due, `true` = seen / not available, `undefined` = still
 * reading the device note, `null` = the read failed (never push the page on the person).
 */
export type OneTimeSeen = boolean | null | undefined;

export function nextOneTimePage(input: {
  isAnonymous: boolean;
  secureSeen: OneTimeSeen;
  aboutYouSeen: OneTimeSeen;
  hasCommunity: boolean;
}): NextOneTimePage {
  if (!input.hasCommunity) return 'none';
  // Linked accounts (and someone who just signed in with their email) never see the secure page.
  if (input.isAnonymous) {
    if (input.secureSeen === undefined) return 'wait';
    if (input.secureSeen === false) return 'secure-account';
  }
  if (input.aboutYouSeen === undefined) return 'wait';
  if (input.aboutYouSeen === false) return 'about-you';
  return 'none';
}

/** Adapts the `promptState` of a page to `OneTimeSeen`. */
export function seenOf(state: 'checking' | 'show' | 'done'): OneTimeSeen {
  if (state === 'checking') return undefined;
  return state === 'done';
}

export function routeOf(page: OneTimePage): string {
  return page === 'secure-account' ? '/secure-account' : '/about-you?welcome=1';
}

/** The pathname a pushed one-time page shows (without the query). */
export function pathOf(page: OneTimePage): string {
  return page === 'secure-account' ? '/secure-account' : '/about-you';
}
