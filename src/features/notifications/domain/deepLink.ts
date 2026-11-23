/**
 * Deep links from push data and from `notifications.deep_link`.
 *
 * Push payloads are data, not instructions: only an allowlist of internal
 * routes is ever navigated to, so a crafted or corrupted payload cannot open
 * an arbitrary URL or screen. Allowed:
 *   /trainings/<uuid>   /announcements/<uuid>   /events/<uuid>/feed   /events/<uuid>/log   /activity
 * Nothing else: no scheme, host, query, fragment, extra segment or relative path.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AppLink =
  | { kind: 'training'; id: string }
  | { kind: 'announcement'; id: string }
  | { kind: 'eventFeed'; id: string }
  | { kind: 'workoutLog'; id: string }
  | { kind: 'activity' };

/** The link for a route string, or null when it is not on the allowlist. */
export function parseAppLink(raw: unknown): AppLink | null {
  if (typeof raw !== 'string') return null;
  if (raw === '/activity') return { kind: 'activity' };
  const parts = raw.split('/');
  // '/events/<id>/feed' splits into ['', 'events', '<id>', 'feed'].
  if (parts.length === 4 && parts[0] === '' && parts[1] === 'events' && (parts[3] === 'feed' || parts[3] === 'log')) {
    if (!UUID.test(parts[2])) return null;
    return { kind: parts[3] === 'feed' ? 'eventFeed' : 'workoutLog', id: parts[2].toLowerCase() };
  }
  // '/trainings/<id>' splits into ['', 'trainings', '<id>'].
  if (parts.length !== 3 || parts[0] !== '') return null;
  const [, section, id] = parts;
  if (!UUID.test(id)) return null;
  if (section === 'trainings') return { kind: 'training', id: id.toLowerCase() };
  if (section === 'announcements') return { kind: 'announcement', id: id.toLowerCase() };
  return null;
}

/** The route to navigate to. Built from validated parts only. */
export function hrefForLink(link: AppLink): string {
  switch (link.kind) {
    case 'training':
      return `/trainings/${link.id}`;
    case 'announcement':
      return `/announcements/${link.id}`;
    case 'eventFeed':
      return `/events/${link.id}/feed`;
    case 'workoutLog':
      return `/events/${link.id}/log`;
    case 'activity':
      return '/activity';
  }
}

export type PushTarget = {
  /** Validated internal route, or null when the payload carries none we accept. */
  href: string | null;
  /** The `notifications.id` carried by the push, when present (used to ignore repeats). */
  notificationId: string | null;
};

function readKey(data: unknown, key: string): unknown {
  return typeof data === 'object' && data !== null
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Reads the navigation target out of a push payload's `data`. The backend
 * sends `{ url, notification_id, kind }` (contract); `deepLink` is accepted
 * too. The first key that holds a valid link wins.
 */
export function targetFromPushData(data: unknown): PushTarget {
  let href: string | null = null;
  for (const key of ['deepLink', 'url']) {
    const link = parseAppLink(readKey(data, key));
    if (link) {
      href = hrefForLink(link);
      break;
    }
  }
  const rawId = readKey(data, 'notification_id') ?? readKey(data, 'notificationId');
  const notificationId = typeof rawId === 'string' && UUID.test(rawId) ? rawId.toLowerCase() : null;
  return { href, notificationId };
}
