import { useQuery } from '@tanstack/react-query';

import { useSession } from '@/features/community/hooks/SessionProvider';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import type { Announcement, AppNotification } from '@/lib/database.types';
import { toAppError, type AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';

import {
  fetchAnnouncement,
  fetchAnnouncementFeed,
  fetchManagedAnnouncements,
} from '../api/announcements';
import { activityKeys } from '../api/keys';
import { fetchNotifications } from '../api/notifications';
import { sortManaged } from '../domain/presentation';
import { combinedUnreadCount, unreadAnnouncements } from '../domain/unread';

const NO_ANNOUNCEMENTS: Announcement[] = [];
const NO_NOTIFICATIONS: AppNotification[] = [];
const NO_IDS: string[] = [];

export type ActivityData = {
  announcements: Announcement[];
  readIds: string[];
  notifications: AppNotification[];
  /** Number on the tab icon (an announcement and its notification count once). */
  unreadCount: number;
  unreadAnnouncementCount: number;
  unreadNotificationCount: number;
  /** First load, nothing to show yet. */
  isLoading: boolean;
  isRefetching: boolean;
  /** Announcements and notifications fail independently. */
  announcementsError: AppError | null;
  notificationsError: AppError | null;
  refetch: () => void;
};

/**
 * Published announcements and my notifications, plus the unread numbers.
 * Cheap to call from several screens: the queries are shared by key.
 */
export function useActivity(): ActivityData {
  const { userId } = useSession();
  const { community } = useCurrentMembership();
  const communityId = community?.id ?? null;

  const feed = useQuery({
    queryKey: activityKeys.feed(communityId, userId),
    queryFn: () => fetchAnnouncementFeed(communityId as string),
    enabled: communityId !== null && userId !== null,
  });
  const notes = useQuery({
    queryKey: activityKeys.notifications(communityId, userId),
    queryFn: () => fetchNotifications(communityId as string, userId as string),
    enabled: communityId !== null && userId !== null,
  });

  const announcements = feed.data?.items ?? NO_ANNOUNCEMENTS;
  const readIds = feed.data?.readIds ?? NO_IDS;
  const notifications = notes.data ?? NO_NOTIFICATIONS;

  return {
    announcements,
    readIds,
    notifications,
    unreadCount: combinedUnreadCount({
      items: announcements,
      readIds,
      notifications,
      userId,
      communityId,
    }),
    unreadAnnouncementCount: unreadAnnouncements(announcements, readIds, userId).length,
    unreadNotificationCount: notifications.filter((note) => note.read_at === null).length,
    isLoading: feed.isPending || notes.isPending,
    isRefetching: feed.isRefetching || notes.isRefetching,
    announcementsError: feed.error ? toAppError(feed.error) : null,
    notificationsError: notes.error ? toAppError(notes.error) : null,
    refetch: () => {
      Promise.all([feed.refetch(), notes.refetch()]).catch((error: unknown) =>
        reportError('activity.refetch', error),
      );
    },
  };
}

/** The organizer's scheduled and cancelled announcements. Disabled for members. */
export function useManagedAnnouncements(enabled: boolean) {
  const { community } = useCurrentMembership();
  const communityId = community?.id ?? null;
  const query = useQuery({
    queryKey: activityKeys.managed(communityId),
    queryFn: () => fetchManagedAnnouncements(communityId as string),
    enabled: enabled && communityId !== null,
    select: sortManaged,
  });
  return {
    items: query.data ?? NO_ANNOUNCEMENTS,
    isLoading: query.isPending && query.fetchStatus !== 'idle',
    error: query.error ? toAppError(query.error) : null,
    refetch: () => {
      query.refetch().catch((error: unknown) => reportError('activity.managed', error));
    },
  };
}

/** One announcement by id (a deep link may arrive before the feed is loaded). */
export function useAnnouncement(id: string) {
  return useQuery({
    queryKey: activityKeys.announcement(id),
    queryFn: () => fetchAnnouncement(id),
  });
}
