import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
  applyRsvpToCache,
  reconcileRsvpInCache,
  rollbackRsvpInCache,
  rsvpAffectedKeys,
  type RsvpChange,
} from '@/features/rsvp/domain/rsvpCache';
import { rsvpKeys, trainingKeys, type MyRsvps } from '@/features/trainings/api/keys';
import type { RsvpResponse, TrainingSession } from '@/lib/database.types';

const USER = 'user-1';
const COMMUNITY = 'community-1';

function makeSession(id: string, overrides: Partial<TrainingSession> = {}): TrainingSession {
  return {
    id,
    community_id: COMMUNITY,
    organizer_id: 'organizer-1',
    title: `Session ${id}`,
    description: null,
    activity_type: 'running',
    starts_at: '2026-11-14T07:00:00+00:00',
    ends_at: null,
    rsvp_deadline: '2026-11-14T05:00:00+00:00',
    timezone: 'Europe/Bucharest',
    location_name: 'Park',
    address: null,
    latitude: null,
    longitude: null,
    map_url: null,
    meeting_instructions: null,
    min_participants: 10,
    max_participants: 20,
    event_kind: 'training',
    event_subtype: 'running',
    distance_km: null,
    elevation_gain_m: null,
    obstacle_count: null,
    event_notes: null,
    going_count: 7,
    status: 'scheduled',
    cancel_reason: null,
    decided_at: null,
    cancelled_at: null,
    cancelled_by: null,
    attendance_finalized_at: null,
    attendance_finalized_by: null,
    created_at: '2026-11-01T10:00:00+00:00',
    updated_at: '2026-11-01T10:00:00+00:00',
    ...overrides,
  };
}

/** A cache as the app has it: one list, some details, my answers. */
function seed(mine: MyRsvps | undefined = { b: 'not_going' }) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(trainingKeys.list(COMMUNITY), [
    makeSession('a'),
    makeSession('b', { going_count: 3 }),
    makeSession('c', { going_count: 0 }),
  ]);
  queryClient.setQueryData(trainingKeys.detail('a'), makeSession('a'));
  queryClient.setQueryData(trainingKeys.detail('b'), makeSession('b', { going_count: 3 }));
  if (mine !== undefined) queryClient.setQueryData(rsvpKeys.mine(USER), mine);
  return queryClient;
}

/** Everything in the cache, for exact before / after comparison. */
function dump(queryClient: QueryClient) {
  return queryClient
    .getQueryCache()
    .getAll()
    .map((query) => [JSON.stringify(query.queryKey), structuredClone(query.state.data)] as const)
    .sort(([a], [b]) => a.localeCompare(b));
}

function listCount(queryClient: QueryClient, id: string): number | undefined {
  return queryClient
    .getQueryData<TrainingSession[]>(trainingKeys.list(COMMUNITY))
    ?.find((session) => session.id === id)?.going_count;
}

function detailCount(queryClient: QueryClient, id: string): number | undefined {
  return queryClient.getQueryData<TrainingSession>(trainingKeys.detail(id))?.going_count;
}

function change(next: RsvpResponse, previous: RsvpResponse, sessionId = 'a'): RsvpChange {
  return { sessionId, userId: USER, previous, next };
}

describe('applyRsvpToCache', () => {
  it('raises the count in the list and the detail and records my answer', () => {
    const queryClient = seed();

    applyRsvpToCache(queryClient, change('going', 'no_response'));

    expect(listCount(queryClient, 'a')).toBe(8);
    expect(detailCount(queryClient, 'a')).toBe(8);
    expect(queryClient.getQueryData(rsvpKeys.mine(USER))).toEqual({ a: 'going', b: 'not_going' });
  });

  it('leaves other sessions alone', () => {
    const queryClient = seed();
    applyRsvpToCache(queryClient, change('going', 'no_response'));
    expect(listCount(queryClient, 'b')).toBe(3);
    expect(listCount(queryClient, 'c')).toBe(0);
    expect(detailCount(queryClient, 'b')).toBe(3);
  });

  it.each<[RsvpResponse, RsvpResponse, number]>([
    ['no_response', 'going', 8],
    ['not_going', 'going', 8],
    ['going', 'not_going', 6],
    ['going', 'no_response', 6],
    ['no_response', 'not_going', 7],
    ['not_going', 'no_response', 7],
    ['going', 'going', 7],
  ])('%s → %s shows %i going', (previous, next, expected) => {
    const queryClient = seed({ a: previous });
    applyRsvpToCache(queryClient, change(next, previous));
    expect(listCount(queryClient, 'a')).toBe(expected);
    expect(detailCount(queryClient, 'a')).toBe(expected);
    expect(queryClient.getQueryData<MyRsvps>(rsvpKeys.mine(USER))?.a).toBe(next);
  });

  it('updates the session in every cached list', () => {
    const queryClient = seed();
    queryClient.setQueryData(trainingKeys.list('other-view'), [makeSession('a')]);

    applyRsvpToCache(queryClient, change('going', 'no_response'));

    expect(
      queryClient.getQueryData<TrainingSession[]>(trainingKeys.list('other-view'))?.[0]?.going_count,
    ).toBe(8);
    expect(listCount(queryClient, 'a')).toBe(8);
  });

  it('does not invent cache entries that were not loaded', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(trainingKeys.list(COMMUNITY), [makeSession('a')]);

    const snapshot = applyRsvpToCache(queryClient, change('going', 'no_response'));

    expect(queryClient.getQueryData(trainingKeys.detail('a'))).toBeUndefined();
    expect(queryClient.getQueryData(rsvpKeys.mine(USER))).toBeUndefined();
    expect(snapshot.lists).toHaveLength(1);
    expect(snapshot.detail).toBeNull();
    expect(snapshot.answer.loaded).toBe(false);
  });

  it('copes with an empty cache and a not-found detail', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(trainingKeys.detail('a'), null);
    const before = dump(queryClient);

    const snapshot = applyRsvpToCache(queryClient, change('going', 'no_response'));

    expect(snapshot.lists).toEqual([]);
    expect(dump(queryClient)).toEqual(before);
  });

  it('does not mutate the cached objects it replaces', () => {
    const queryClient = seed();
    const listBefore = queryClient.getQueryData<TrainingSession[]>(trainingKeys.list(COMMUNITY));
    const frozen = structuredClone(listBefore);

    applyRsvpToCache(queryClient, change('going', 'no_response'));

    expect(listBefore).toEqual(frozen);
  });
});

describe('rollbackRsvpInCache', () => {
  it('restores the cache exactly after a failed change', () => {
    const queryClient = seed();
    const before = dump(queryClient);

    const snapshot = applyRsvpToCache(queryClient, change('going', 'no_response'));
    expect(dump(queryClient)).not.toEqual(before);
    rollbackRsvpInCache(queryClient, snapshot);

    expect(dump(queryClient)).toEqual(before);
  });

  it('restores exactly for every pair of responses', () => {
    const responses: RsvpResponse[] = ['going', 'not_going', 'no_response'];
    for (const previous of responses) {
      for (const next of responses) {
        const queryClient = seed({ a: previous, b: 'not_going' });
        const before = dump(queryClient);
        rollbackRsvpInCache(queryClient, applyRsvpToCache(queryClient, change(next, previous)));
        expect(dump(queryClient)).toEqual(before);
      }
    }
  });

  it('restores an answer that had no entry (no key left behind)', () => {
    const queryClient = seed({});
    const snapshot = applyRsvpToCache(queryClient, change('going', 'no_response'));
    expect(queryClient.getQueryData(rsvpKeys.mine(USER))).toEqual({ a: 'going' });

    rollbackRsvpInCache(queryClient, snapshot);

    expect(queryClient.getQueryData(rsvpKeys.mine(USER))).toEqual({});
  });

  it('rolls back a full session to full (session_full from the server)', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(trainingKeys.list(COMMUNITY), [
      makeSession('a', { going_count: 19, max_participants: 20 }),
    ]);
    const snapshot = applyRsvpToCache(queryClient, change('going', 'no_response'));
    expect(listCount(queryClient, 'a')).toBe(20);
    rollbackRsvpInCache(queryClient, snapshot);
    expect(listCount(queryClient, 'a')).toBe(19);
  });

  it('restores the original count after a tap sequence where the last one fails', () => {
    const queryClient = seed({});
    const before = dump(queryClient);

    // going (succeeds, server agrees) → not going (fails).
    applyRsvpToCache(queryClient, change('going', 'no_response'));
    reconcileRsvpInCache(
      queryClient,
      { sessionId: 'a', userId: USER },
      { response: 'going', going_count: 8, status: 'scheduled' },
    );
    const afterFirst = dump(queryClient);
    const second = applyRsvpToCache(queryClient, change('not_going', 'going'));
    expect(listCount(queryClient, 'a')).toBe(7);
    rollbackRsvpInCache(queryClient, second);

    expect(dump(queryClient)).toEqual(afterFirst);
    expect(dump(queryClient)).not.toEqual(before);
    expect(listCount(queryClient, 'a')).toBe(8);
  });
});

describe('reconcileRsvpInCache', () => {
  it('replaces the guess with the server count and status everywhere', () => {
    const queryClient = seed();
    applyRsvpToCache(queryClient, change('going', 'no_response'));

    // Two other people answered at the same time, and that reached the deadline decision.
    reconcileRsvpInCache(
      queryClient,
      { sessionId: 'a', userId: USER },
      { response: 'going', going_count: 10, status: 'confirmed' },
    );

    const inList = queryClient
      .getQueryData<TrainingSession[]>(trainingKeys.list(COMMUNITY))
      ?.find((session) => session.id === 'a');
    expect(inList?.going_count).toBe(10);
    expect(inList?.status).toBe('confirmed');
    expect(detailCount(queryClient, 'a')).toBe(10);
    expect(queryClient.getQueryData<MyRsvps>(rsvpKeys.mine(USER))?.a).toBe('going');
    expect(listCount(queryClient, 'b')).toBe(3);
  });

  it('is idempotent', () => {
    const queryClient = seed();
    const result = { response: 'going' as const, going_count: 9, status: 'scheduled' as const };
    reconcileRsvpInCache(queryClient, { sessionId: 'a', userId: USER }, result);
    const once = dump(queryClient);
    reconcileRsvpInCache(queryClient, { sessionId: 'a', userId: USER }, result);
    expect(dump(queryClient)).toEqual(once);
  });
});

describe('rsvpAffectedKeys', () => {
  it('covers every list, the session detail and my answers', () => {
    expect(rsvpAffectedKeys({ sessionId: 'a', userId: USER })).toEqual([
      ['trainings', 'list'],
      ['trainings', 'detail', 'a'],
      ['rsvps', 'mine', USER],
    ]);
  });
});
