/**
 * Routes that moved. `/activity` was the Activity tab; it stays reachable
 * (it is on the push / deep-link allowlist and in a database constraint) and
 * now lands on the notification centre.
 */
export const NOTIFICATIONS_ROUTE = '/notifications';

const REDIRECTS: Readonly<Record<string, string>> = {
  '/activity': NOTIFICATIONS_ROUTE,
};

/** Where an old route now lives; null when the route did not move. */
export function redirectFor(path: string): string | null {
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return Object.hasOwn(REDIRECTS, clean) ? REDIRECTS[clean] : null;
}
