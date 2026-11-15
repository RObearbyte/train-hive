/**
 * Optimistic notification preferences on the query cache. A snapshot holds
 * only the fields THIS change touched, and rollback restores only those, and
 * only while the cache still shows our optimistic value, so two toggles saved
 * at once (or a refetch in between) cannot undo each other.
 */
import type { QueryClient } from '@tanstack/react-query';

import { activityKeys } from '../api/keys';

export type NotificationPrefs = {
  push_enabled: boolean;
  training_reminders: boolean;
  announcements: boolean;
  training_updates: boolean;
};

export type PrefsPatch = Partial<NotificationPrefs>;

/** What a user who never saved preferences has (the server says: all true). */
export const DEFAULT_PREFS: NotificationPrefs = {
  push_enabled: true,
  training_reminders: true,
  announcements: true,
  training_updates: true,
};

export type PrefsSnapshot = {
  userId: string | null;
  /** Previous values of the patched fields; null when there was no cached row. */
  previous: PrefsPatch | null;
  applied: PrefsPatch;
};

/** Shows `patch` immediately. Call after cancelling in-flight preference reads. */
export function applyOptimisticPrefs(
  queryClient: QueryClient,
  userId: string | null,
  patch: PrefsPatch,
): PrefsSnapshot {
  const key = activityKeys.preferences(userId);
  const current = queryClient.getQueryData<NotificationPrefs>(key);
  if (!current) return { userId, previous: null, applied: patch };

  const previous: PrefsPatch = {};
  for (const field of Object.keys(patch) as (keyof NotificationPrefs)[]) {
    previous[field] = current[field];
  }
  queryClient.setQueryData<NotificationPrefs>(key, { ...current, ...patch });
  return { userId, previous, applied: patch };
}

export function rollbackPrefs(queryClient: QueryClient, snapshot: PrefsSnapshot): void {
  if (snapshot.previous === null) return;
  const key = activityKeys.preferences(snapshot.userId);
  const current = queryClient.getQueryData<NotificationPrefs>(key);
  if (!current) return;
  const restored: PrefsPatch = {};
  for (const field of Object.keys(snapshot.applied) as (keyof NotificationPrefs)[]) {
    if (current[field] === snapshot.applied[field]) restored[field] = snapshot.previous[field];
  }
  queryClient.setQueryData<NotificationPrefs>(key, { ...current, ...restored });
}
