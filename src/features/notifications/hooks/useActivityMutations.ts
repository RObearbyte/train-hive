import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import type { Announcement, AppNotification } from '@/lib/database.types';
import type { AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { readClock } from '@/lib/useNow';

import {
  cancelAnnouncement,
  createAnnouncement,
  markAnnouncementRead,
  updateAnnouncement,
  type AnnouncementPayload,
} from '../api/announcements';
import { activityKeys } from '../api/keys';
import { markAllNotificationsRead, markNotificationRead } from '../api/notifications';
import {
  applyOptimisticAnnouncementRead,
  applyOptimisticMarkAllRead,
  applyOptimisticNotificationRead,
  rollbackRead,
  type ReadSnapshot,
} from '../domain/activityCache';

/** Reads and the lists they affect; refetched after every read change, successful or not. */
function refetchReadState(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: activityKeys.feeds() });
  void queryClient.invalidateQueries({ queryKey: activityKeys.notificationLists() });
}

async function cancelReadQueries(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries({ queryKey: activityKeys.feeds() });
  await queryClient.cancelQueries({ queryKey: activityKeys.notificationLists() });
}

/** Optimistically marks an announcement (and its notification) read; rolls back on error. */
export function useMarkAnnouncementRead() {
  const queryClient = useQueryClient();
  return useMutation<void, AppError, string, ReadSnapshot>({
    mutationFn: markAnnouncementRead,
    onMutate: async (id) => {
      await cancelReadQueries(queryClient);
      return applyOptimisticAnnouncementRead(queryClient, id, readClock().toISOString());
    },
    onError: (error, _id, snapshot) => {
      reportError('announcement.markRead', error);
      if (snapshot) rollbackRead(queryClient, snapshot);
    },
    onSettled: () => refetchReadState(queryClient),
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation<
    void,
    AppError,
    Pick<AppNotification, 'id' | 'related_announcement_id'>,
    ReadSnapshot
  >({
    mutationFn: (notification) => markNotificationRead(notification.id),
    onMutate: async (notification) => {
      await cancelReadQueries(queryClient);
      return applyOptimisticNotificationRead(queryClient, notification, readClock().toISOString());
    },
    onError: (error, _notification, snapshot) => {
      reportError('notification.markRead', error);
      if (snapshot) rollbackRead(queryClient, snapshot);
    },
    onSettled: () => refetchReadState(queryClient),
  });
}

export function useMarkAllNotificationsRead(communityId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<number, AppError, void, ReadSnapshot>({
    mutationFn: () => markAllNotificationsRead(communityId as string),
    onMutate: async () => {
      await cancelReadQueries(queryClient);
      return applyOptimisticMarkAllRead(queryClient, readClock().toISOString());
    },
    onError: (error, _vars, snapshot) => {
      reportError('notification.markAllRead', error);
      if (snapshot) rollbackRead(queryClient, snapshot);
    },
    onSettled: () => refetchReadState(queryClient),
  });
}

/** Shows the row the server returned, then refetches so every screen ends on server truth. */
function applySaved(queryClient: QueryClient, saved: Announcement): void {
  queryClient.setQueryData(activityKeys.announcement(saved.id), saved);
  void queryClient.invalidateQueries({ queryKey: activityKeys.manageds() });
  void queryClient.invalidateQueries({ queryKey: activityKeys.feeds() });
  void queryClient.invalidateQueries({ queryKey: activityKeys.announcements() });
}

/** A failed change may mean the announcement was published or cancelled meanwhile. */
function refetchAnnouncements(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: activityKeys.manageds() });
  void queryClient.invalidateQueries({ queryKey: activityKeys.announcements() });
}

export function useCreateAnnouncement(communityId: string) {
  const queryClient = useQueryClient();
  return useMutation<Announcement, AppError, AnnouncementPayload>({
    mutationFn: (input) => createAnnouncement(communityId, input),
    onSuccess: (saved) => applySaved(queryClient, saved),
    onError: (error) => reportError('announcement.create', error),
  });
}

export function useUpdateAnnouncement(id: string) {
  const queryClient = useQueryClient();
  return useMutation<Announcement, AppError, AnnouncementPayload>({
    mutationFn: (input) => updateAnnouncement(id, input),
    onSuccess: (saved) => applySaved(queryClient, saved),
    onError: (error) => {
      reportError('announcement.update', error);
      refetchAnnouncements(queryClient);
    },
  });
}

export function useCancelAnnouncement(id: string) {
  const queryClient = useQueryClient();
  return useMutation<Announcement, AppError, void>({
    mutationFn: () => cancelAnnouncement(id),
    onSuccess: (saved) => applySaved(queryClient, saved),
    onError: (error) => {
      reportError('announcement.cancel', error);
      refetchAnnouncements(queryClient);
    },
  });
}
