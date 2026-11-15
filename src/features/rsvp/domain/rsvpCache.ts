/**
 * Optimistic RSVP on the query cache: apply, roll back exactly, reconcile
 * with the server's answer. No React and no network here, so it is unit
 * tested against a real QueryClient.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query';

import { rsvpKeys, trainingKeys, type MyRsvps } from '@/features/trainings/api/keys';
import type { RsvpResponse, SetRsvpResult, TrainingSession } from '@/lib/database.types';

import { applyOptimisticRsvp } from './rsvp';

export type RsvpChange = {
  sessionId: string;
  userId: string;
  /** What the cache shows for me right now. */
  previous: RsvpResponse;
  next: RsvpResponse;
};

/** Everything `applyRsvpToCache` touched, exactly as it was before. */
export type RsvpCacheSnapshot = {
  entries: [QueryKey, unknown][];
};

/** The queries an RSVP change can affect; cancel these before applying. */
export function rsvpAffectedKeys(change: Pick<RsvpChange, 'sessionId' | 'userId'>): QueryKey[] {
  return [
    trainingKeys.lists(),
    trainingKeys.detail(change.sessionId),
    rsvpKeys.mine(change.userId),
  ];
}

function patchSession(
  session: TrainingSession,
  sessionId: string,
  patch: (session: TrainingSession) => TrainingSession,
): TrainingSession {
  return session.id === sessionId ? patch(session) : session;
}

/** Applies `patch` to the session wherever it is cached (every list, and its detail). */
function patchSessionEverywhere(
  queryClient: QueryClient,
  sessionId: string,
  patch: (session: TrainingSession) => TrainingSession,
  record?: (key: QueryKey, before: unknown) => void,
): void {
  const lists = queryClient.getQueriesData<TrainingSession[]>({ queryKey: trainingKeys.lists() });
  for (const [key, list] of lists) {
    if (!Array.isArray(list) || !list.some((session) => session.id === sessionId)) continue;
    record?.(key, list);
    queryClient.setQueryData<TrainingSession[]>(
      key,
      list.map((session) => patchSession(session, sessionId, patch)),
    );
  }

  const detailKey = trainingKeys.detail(sessionId);
  const detail = queryClient.getQueryData<TrainingSession | null>(detailKey);
  if (detail) {
    record?.(detailKey, detail);
    queryClient.setQueryData<TrainingSession | null>(detailKey, patch(detail));
  }
}

function setMyResponse(
  queryClient: QueryClient,
  change: Pick<RsvpChange, 'sessionId' | 'userId'>,
  response: RsvpResponse,
  record?: (key: QueryKey, before: unknown) => void,
): void {
  const key = rsvpKeys.mine(change.userId);
  const mine = queryClient.getQueryData<MyRsvps>(key);
  // Not loaded yet: leave it for the fetch rather than inventing a partial map.
  if (mine === undefined) return;
  record?.(key, mine);
  queryClient.setQueryData<MyRsvps>(key, { ...mine, [change.sessionId]: response });
}

/**
 * Shows the change immediately: adjusts `going_count` wherever the session
 * is cached and sets my answer. Returns what to hand to `rollbackRsvpInCache`.
 * Call after cancelling `rsvpAffectedKeys`, so a response already in flight
 * cannot overwrite it.
 */
export function applyRsvpToCache(queryClient: QueryClient, change: RsvpChange): RsvpCacheSnapshot {
  const entries: [QueryKey, unknown][] = [];
  const record = (key: QueryKey, before: unknown) => entries.push([key, before]);

  patchSessionEverywhere(
    queryClient,
    change.sessionId,
    (session) => applyOptimisticRsvp(session, change.previous, change.next),
    record,
  );
  setMyResponse(queryClient, change, change.next, record);

  return { entries };
}

/** Puts back exactly what `applyRsvpToCache` replaced. */
export function rollbackRsvpInCache(queryClient: QueryClient, snapshot: RsvpCacheSnapshot): void {
  for (const [key, before] of snapshot.entries) queryClient.setQueryData(key, before);
}

/**
 * Replaces the optimistic guess with what `set_rsvp` returned: the real
 * count (other people may have answered meanwhile), the real status and my
 * stored answer.
 */
export function reconcileRsvpInCache(
  queryClient: QueryClient,
  change: Pick<RsvpChange, 'sessionId' | 'userId'>,
  result: SetRsvpResult,
): void {
  patchSessionEverywhere(queryClient, change.sessionId, (session) => ({
    ...session,
    going_count: result.going_count,
    status: result.status,
  }));
  setMyResponse(queryClient, change, result.response);
}
