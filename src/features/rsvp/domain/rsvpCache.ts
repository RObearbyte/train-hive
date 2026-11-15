/**
 * Optimistic RSVP on the query cache: apply, roll back exactly, reconcile
 * with the server's answer. No React and no network here, so it is unit
 * tested against a real QueryClient.
 */
import type { InvalidateQueryFilters, QueryClient, QueryKey } from '@tanstack/react-query';

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

/**
 * What `applyRsvpToCache` changed for ONE session: its copy in each cached
 * list, its detail copy and my stored answer. Rolling back restores only
 * these, never other sessions' entries, so two pending changes on different
 * sessions cannot undo each other.
 */
export type RsvpCacheSnapshot = {
  sessionId: string;
  userId: string;
  lists: [QueryKey, TrainingSession][];
  detail: TrainingSession | null;
  /** My answer entry before the change: `undefined` = no entry (or answers not loaded). */
  answer: { loaded: boolean; value: RsvpResponse | undefined };
};

/** Mutation key of one session's RSVP change. */
export const setRsvpKey = (sessionId: string) => ['rsvps', 'set', sessionId] as const;

/** True while any RSVP change is being saved (for any session). */
export function isRsvpPending(queryClient: QueryClient): boolean {
  return queryClient.isMutating({ mutationKey: ['rsvps', 'set'] }) > 0;
}

/**
 * Invalidates unless an RSVP change is in flight. A read started now would
 * bring back the state from before the change and flip the optimistic answer
 * back; the change's own `onSettled` refetches everything anyway.
 */
export function invalidateUnlessRsvpPending(
  queryClient: QueryClient,
  filters: InvalidateQueryFilters,
): void {
  if (isRsvpPending(queryClient)) return;
  void queryClient.invalidateQueries(filters);
}

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
): void {
  const lists = queryClient.getQueriesData<TrainingSession[]>({ queryKey: trainingKeys.lists() });
  for (const [key, list] of lists) {
    if (!Array.isArray(list) || !list.some((session) => session.id === sessionId)) continue;
    queryClient.setQueryData<TrainingSession[]>(
      key,
      list.map((session) => patchSession(session, sessionId, patch)),
    );
  }

  const detailKey = trainingKeys.detail(sessionId);
  const detail = queryClient.getQueryData<TrainingSession | null>(detailKey);
  if (detail) {
    queryClient.setQueryData<TrainingSession | null>(detailKey, patch(detail));
  }
}

function setMyResponse(
  queryClient: QueryClient,
  change: Pick<RsvpChange, 'sessionId' | 'userId'>,
  response: RsvpResponse,
): void {
  const key = rsvpKeys.mine(change.userId);
  const mine = queryClient.getQueryData<MyRsvps>(key);
  // Not loaded yet: leave it for the fetch rather than inventing a partial map.
  if (mine === undefined) return;
  queryClient.setQueryData<MyRsvps>(key, { ...mine, [change.sessionId]: response });
}

/**
 * Shows the change immediately: adjusts `going_count` wherever the session
 * is cached and sets my answer. Returns what to hand to `rollbackRsvpInCache`.
 * Call after cancelling `rsvpAffectedKeys`, so a response already in flight
 * cannot overwrite it.
 *
 * When my answers are loaded, the cache is the truth about what I answered
 * before: a stale `change.previous` (for example "no response" shown while the
 * answers were loading) cannot add a phantom +1 for an answer already stored.
 */
export function applyRsvpToCache(queryClient: QueryClient, change: RsvpChange): RsvpCacheSnapshot {
  const mine = queryClient.getQueryData<MyRsvps>(rsvpKeys.mine(change.userId));
  const previous: RsvpResponse =
    mine === undefined ? change.previous : (mine[change.sessionId] ?? 'no_response');

  const lists: [QueryKey, TrainingSession][] = [];
  for (const [key, list] of queryClient.getQueriesData<TrainingSession[]>({
    queryKey: trainingKeys.lists(),
  })) {
    const found = Array.isArray(list) ? list.find((s) => s.id === change.sessionId) : undefined;
    if (found) lists.push([key, found]);
  }
  const detail =
    queryClient.getQueryData<TrainingSession | null>(trainingKeys.detail(change.sessionId)) ?? null;
  const snapshot: RsvpCacheSnapshot = {
    sessionId: change.sessionId,
    userId: change.userId,
    lists,
    detail,
    answer: { loaded: mine !== undefined, value: mine?.[change.sessionId] },
  };

  patchSessionEverywhere(queryClient, change.sessionId, (session) =>
    applyOptimisticRsvp(session, previous, change.next),
  );
  setMyResponse(queryClient, change, change.next);
  return snapshot;
}

/** Puts back what `applyRsvpToCache` replaced for this one session, and nothing else. */
export function rollbackRsvpInCache(queryClient: QueryClient, snapshot: RsvpCacheSnapshot): void {
  for (const [key, before] of snapshot.lists) {
    queryClient.setQueryData<TrainingSession[]>(key, (list) =>
      Array.isArray(list)
        ? list.map((session) => (session.id === snapshot.sessionId ? before : session))
        : list,
    );
  }
  if (snapshot.detail) {
    queryClient.setQueryData<TrainingSession | null>(
      trainingKeys.detail(snapshot.sessionId),
      snapshot.detail,
    );
  }
  if (snapshot.answer.loaded) {
    queryClient.setQueryData<MyRsvps>(rsvpKeys.mine(snapshot.userId), (mine) => {
      if (mine === undefined) return mine;
      const { [snapshot.sessionId]: _current, ...rest } = mine;
      return snapshot.answer.value === undefined ? rest : { ...rest, [snapshot.sessionId]: snapshot.answer.value };
    });
  }
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
