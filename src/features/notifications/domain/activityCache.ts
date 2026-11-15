/**
 * Optimistic "read" state on the query cache: apply, roll back exactly.
 * No React and no network here, so it is unit tested against a real
 * QueryClient.
 *
 * A snapshot records only what THIS change flipped (which feeds gained the id,
 * which notifications went from unread to read), and rollback undoes only
 * those, so two overlapping changes or a refetch in between cannot undo each
 * other. After the server answers (either way) the caller invalidates, so the
 * screen always ends on server truth. `readAt` is supplied by the caller: the
 * optimistic value is display only, the server sets the real `read_at`.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query';

import type { AppNotification } from '@/lib/database.types';

import { activityKeys, type AnnouncementFeed } from '../api/keys';

export type ReadSnapshot = {
  /** Feeds (by query key) where the announcement id was added to `readIds`. */
  feedKeys: QueryKey[];
  announcementId: string | null;
  /** Notifications flipped from unread to read, with the optimistic value written. */
  flipped: { key: QueryKey; id: string; readAt: string }[];
};

const EMPTY: ReadSnapshot = { feedKeys: [], announcementId: null, flipped: [] };

function markNotificationsRead(
  queryClient: QueryClient,
  matches: (note: AppNotification) => boolean,
  readAt: string,
): ReadSnapshot['flipped'] {
  const flipped: ReadSnapshot['flipped'] = [];
  for (const [key, list] of queryClient.getQueriesData<AppNotification[]>({
    queryKey: activityKeys.notificationLists(),
  })) {
    if (!list) continue;
    const ids = list.filter((note) => note.read_at === null && matches(note)).map((note) => note.id);
    if (ids.length === 0) continue;
    queryClient.setQueryData<AppNotification[]>(
      key,
      list.map((note) => (ids.includes(note.id) ? { ...note, read_at: readAt } : note)),
    );
    for (const id of ids) flipped.push({ key, id, readAt });
  }
  return flipped;
}

function addToFeedReads(queryClient: QueryClient, announcementId: string): QueryKey[] {
  const changed: QueryKey[] = [];
  for (const [key, feed] of queryClient.getQueriesData<AnnouncementFeed>({
    queryKey: activityKeys.feeds(),
  })) {
    if (!feed || feed.readIds.includes(announcementId)) continue;
    queryClient.setQueryData<AnnouncementFeed>(key, {
      ...feed,
      readIds: [...feed.readIds, announcementId],
    });
    changed.push(key);
  }
  return changed;
}

/**
 * Marks an announcement read (as `mark_announcement_read` does, which also
 * marks its notification read). Call after cancelling in-flight reads.
 */
export function applyOptimisticAnnouncementRead(
  queryClient: QueryClient,
  announcementId: string,
  readAt: string,
): ReadSnapshot {
  return {
    announcementId,
    feedKeys: addToFeedReads(queryClient, announcementId),
    flipped: markNotificationsRead(
      queryClient,
      (note) => note.related_announcement_id === announcementId,
      readAt,
    ),
  };
}

/**
 * Marks one notification read; when it belongs to an announcement the
 * announcement counts as read too (the server does the same).
 */
export function applyOptimisticNotificationRead(
  queryClient: QueryClient,
  notification: Pick<AppNotification, 'id' | 'related_announcement_id'>,
  readAt: string,
): ReadSnapshot {
  const flipped = markNotificationsRead(queryClient, (note) => note.id === notification.id, readAt);
  const announcementId = notification.related_announcement_id;
  return {
    announcementId,
    feedKeys: announcementId === null ? [] : addToFeedReads(queryClient, announcementId),
    flipped,
  };
}

/** `mark_all_notifications_read`: every unread notification of the lists in the cache. */
export function applyOptimisticMarkAllRead(queryClient: QueryClient, readAt: string): ReadSnapshot {
  return { ...EMPTY, flipped: markNotificationsRead(queryClient, () => true, readAt) };
}

/** Undoes exactly what `snapshot` changed. */
export function rollbackRead(queryClient: QueryClient, snapshot: ReadSnapshot): void {
  const { announcementId } = snapshot;
  if (announcementId !== null) {
    for (const key of snapshot.feedKeys) {
      const feed = queryClient.getQueryData<AnnouncementFeed>(key);
      if (!feed) continue;
      queryClient.setQueryData<AnnouncementFeed>(key, {
        ...feed,
        readIds: feed.readIds.filter((id) => id !== announcementId),
      });
    }
  }
  for (const { key, id, readAt } of snapshot.flipped) {
    const list = queryClient.getQueryData<AppNotification[]>(key);
    if (!list) continue;
    queryClient.setQueryData<AppNotification[]>(
      key,
      // Only if it still holds our optimistic value; a fresher server value stays.
      list.map((note) => (note.id === id && note.read_at === readAt ? { ...note, read_at: null } : note)),
    );
  }
}
