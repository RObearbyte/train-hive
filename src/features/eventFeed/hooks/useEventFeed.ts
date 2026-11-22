import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { activityKeys } from '@/features/notifications/api/keys';
import type { EventFeed, EventFeedUnread } from '@/lib/database.types';
import { toAppError, type AppError } from '@/lib/errors';
import { reportError } from '@/lib/logger';

import {
  createEventPost,
  deleteEventPost,
  fetchEventFeed,
  fetchEventFeedUnread,
  markEventFeedRead,
  replyToEventPost,
} from '../api/eventFeed';
import { eventFeedKeys } from '../api/keys';
import { removePostFromFeed } from '../domain/feed';

function refreshFeed(queryClient: QueryClient, sessionId: string): void {
  void queryClient.invalidateQueries({ queryKey: eventFeedKeys.feed(sessionId) });
  void queryClient.invalidateQueries({ queryKey: eventFeedKeys.unreads() });
}

/** The feed of one event: posts newest first, replies under them. */
export function useEventFeed(sessionId: string) {
  return useQuery<EventFeed, AppError>({
    queryKey: eventFeedKeys.feed(sessionId),
    queryFn: () => fetchEventFeed(sessionId).catch((error: unknown) => Promise.reject(toAppError(error))),
  });
}

/** Unread counts of every event of a community that has posts. */
export function useEventFeedUnread(communityId: string | null) {
  return useQuery<EventFeedUnread[], AppError>({
    queryKey: eventFeedKeys.unread(communityId),
    queryFn: () =>
      fetchEventFeedUnread(communityId as string).catch((error: unknown) =>
        Promise.reject(toAppError(error)),
      ),
    enabled: communityId !== null,
  });
}

/** Organizer: a new top-level post. Not optimistic (the server assigns id, time and author). */
export function useCreateEventPost(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation<unknown, AppError, string>({
    mutationFn: (body) => createEventPost(sessionId, body),
    onSettled: () => refreshFeed(queryClient, sessionId),
  });
}

/** A reply to a top-level post. Not optimistic. */
export function useReplyToEventPost(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation<unknown, AppError, { postId: string; body: string }>({
    mutationFn: ({ postId, body }) => replyToEventPost(postId, body),
    onSettled: () => refreshFeed(queryClient, sessionId),
  });
}

/** Removes the post from the screen at once; puts it back when the server refuses. */
export function useDeleteEventPost(sessionId: string) {
  const queryClient = useQueryClient();
  const key = eventFeedKeys.feed(sessionId);
  return useMutation<void, AppError, string, { previous: EventFeed | undefined }>({
    mutationFn: deleteEventPost,
    onMutate: async (postId) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<EventFeed>(key);
      if (previous) queryClient.setQueryData<EventFeed>(key, removePostFromFeed(previous, postId));
      return { previous };
    },
    onError: (error, _postId, context) => {
      reportError('eventFeed.delete', error);
      if (context?.previous) queryClient.setQueryData<EventFeed>(key, context.previous);
    },
    onSettled: () => refreshFeed(queryClient, sessionId),
  });
}

/**
 * Marks the feed read on the server (cursor and the event's notifications),
 * then refreshes the badges. The server clock decides what counts as read.
 */
export function useMarkEventFeedRead(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, AppError, void>({
    mutationFn: () => markEventFeedRead(sessionId),
    onSuccess: () => {
      refreshFeed(queryClient, sessionId);
      void queryClient.invalidateQueries({ queryKey: activityKeys.all });
    },
    onError: (error) => reportError('eventFeed.markRead', error),
  });
}
