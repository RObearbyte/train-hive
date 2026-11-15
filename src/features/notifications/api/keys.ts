/**
 * Every TanStack Query key for announcements, notifications and push
 * preferences, in one place.
 *
 * Cached shapes:
 * - `activityKeys.feed(communityId, userId)`          -> `AnnouncementFeed`
 * - `activityKeys.managed(communityId)`               -> `Announcement[]` (organizers: scheduled / cancelled)
 * - `activityKeys.announcement(id)`                   -> `Announcement | null`
 * - `activityKeys.notifications(communityId, userId)` -> `AppNotification[]`
 * - `activityKeys.preferences(userId)`                -> `NotificationPrefs`
 */
import type { Announcement } from '@/lib/database.types';

export const activityKeys = {
  all: ['activity'] as const,
  feeds: () => ['activity', 'feed'] as const,
  feed: (communityId: string | null, userId: string | null) =>
    ['activity', 'feed', communityId, userId] as const,
  manageds: () => ['activity', 'managed'] as const,
  managed: (communityId: string | null) => ['activity', 'managed', communityId] as const,
  announcements: () => ['activity', 'announcement'] as const,
  announcement: (id: string) => ['activity', 'announcement', id] as const,
  notificationLists: () => ['activity', 'notifications'] as const,
  notifications: (communityId: string | null, userId: string | null) =>
    ['activity', 'notifications', communityId, userId] as const,
  preferences: (userId: string | null) => ['activity', 'preferences', userId] as const,
};

/** Published announcements, newest first, with the ids I have already read. */
export type AnnouncementFeed = {
  items: Announcement[];
  readIds: string[];
};
