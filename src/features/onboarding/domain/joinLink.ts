/**
 * Web join links: `https://<web-app>/join#code=ABCD-EFGH`.
 *
 * The code travels in the URL FRAGMENT, never in the path or query string:
 * browsers do not send a fragment to servers or in the `Referer` header, so
 * the code never reaches hosting logs. The app reads it once, keeps it in
 * memory and removes it from the address bar (see `pendingJoin.ts`).
 *
 * Pure: strings in, strings out.
 */
import { formatInvitationCode, isValidInvitationCodeFormat, normalizeInvitationCode } from './invitationCode';

/** A real fragment is `#code=` plus 8 characters (a few more with dashes or spaces); anything longer is not a code. */
const MAX_FRAGMENT_LENGTH = 128;

/**
 * The normalized code (`ABCDEFGH`) in a URL fragment such as `#code=abcd-efgh`,
 * or null when it is missing, malformed, ambiguous (`code` given twice), not
 * valid percent-encoding, or too long. Other parameters are ignored.
 */
export function parseJoinFragment(fragment: string | null | undefined): string | null {
  if (typeof fragment !== 'string') return null;
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (raw === '' || raw.length > MAX_FRAGMENT_LENGTH) return null;

  let found: string | null = null;
  for (const pair of raw.split('&')) {
    const equals = pair.indexOf('=');
    if (equals < 0) continue;
    if (pair.slice(0, equals) !== 'code') continue;
    if (found !== null) return null; // two codes: do not guess which one was meant
    try {
      // `+` is a space in form encoding; spaces are dropped by normalizing anyway.
      found = decodeURIComponent(pair.slice(equals + 1).replace(/\+/g, ' '));
    } catch {
      return null;
    }
  }
  if (found === null || !isValidInvitationCodeFormat(found)) return null;
  return normalizeInvitationCode(found);
}

/** The route the web join link opens. */
export const JOIN_PATH = '/join';

/** True for a pathname that ends in `/join` (the app may be hosted under a sub-path). */
export function isJoinPath(pathname: string): boolean {
  return /(^|\/)join\/?$/.test(pathname);
}

/**
 * `<web-app>/join#code=ABCD-EFGH`, or null without a configured web app URL or
 * with a code that is not valid. `webAppUrl` must already be normalized (no
 * trailing slash; see `parseWebAppUrl`).
 */
export function buildWebJoinLink(webAppUrl: string | null, code: string): string | null {
  if (!webAppUrl || !isValidInvitationCodeFormat(code)) return null;
  return `${webAppUrl.replace(/\/+$/, '')}${JOIN_PATH}#code=${formatInvitationCode(code)}`;
}
