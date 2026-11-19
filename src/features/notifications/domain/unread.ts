/**
 * Unread state for the bell and the announcement dots. Pure; the server stays the authority
 * (`announcement_reads`, `notifications.read_at`), this only counts what the
 * client has loaded.
 */
import type { Announcement, AppNotification } from '@/lib/database.types';

/** Published announcements I have not read and did not write myself. */
export function unreadAnnouncements(
  items: readonly Announcement[],
  readIds: readonly string[],
  userId: string | null,
): Announcement[] {
  const read = new Set(readIds);
  return items.filter(
    (item) => item.status === 'published' && !read.has(item.id) && item.author_id !== userId,
  );
}

export function isAnnouncementUnread(
  item: Announcement,
  readIds: readonly string[],
  userId: string | null,
): boolean {
  return unreadAnnouncements([item], readIds, userId).length === 1;
}

export function unreadNotifications(list: readonly AppNotification[]): AppNotification[] {
  return list.filter((item) => item.read_at === null);
}

/**
 * The number on the bell. A new announcement creates BOTH an unread
 * announcement and an unread `announcement_published` notification (and
 * reading either one marks the other read), so it must count once.
 */
export function combinedUnreadCount(input: {
  items: readonly Announcement[];
  readIds: readonly string[];
  notifications: readonly AppNotification[];
  userId: string | null;
  /** Only items of this community count (display only; the server decides). */
  communityId?: string | null;
}): number {
  const { communityId } = input;
  const inCommunity = (item: { community_id: string }) =>
    communityId === undefined || communityId === null || item.community_id === communityId;
  const unreadNotes = unreadNotifications(input.notifications.filter(inCommunity));
  const covered = new Set<string>();
  for (const note of unreadNotes) {
    if (note.related_announcement_id !== null) covered.add(note.related_announcement_id);
  }
  const extra = unreadAnnouncements(input.items.filter(inCommunity), input.readIds, input.userId).filter(
    (item) => !covered.has(item.id),
  );
  return unreadNotes.length + extra.length;
}

/** "9", "99+"; null hides it. */
export function badgeText(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? '99+' : String(Math.floor(count));
}
