/**
 * QA (M1-Q1 part 2): optimistic RSVP under concurrency, on a real
 * QueryClient. The developers' `rsvpCache.test.ts` covers one change at a
 * time; these tests interleave changes the way two cards, Realtime and a slow
 * network do on a phone.
 *
 * Fixed defects (Q2-3, Q2-4) are ordinary tests now (docs/QA_REPORT.md Part 2).
 */
import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
  applyRsvpToCache,
  invalidateUnlessRsvpPending,
  reconcileRsvpInCache,
  rollbackRsvpInCache,
  rsvpAffectedKeys,
  setRsvpKey,
  type RsvpChange,
} from '@/features/rsvp/domain/rsvpCache';
import { applyOptimisticRsvp } from '@/features/rsvp/domain/rsvp';
import { rsvpKeys, trainingKeys, type MyRsvps } from '@/features/trainings/api/keys';
import { participationSummary } from '@/features/trainings/domain/status';
import type { TrainingSession } from '@/lib/database.types';

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
    starts_at: '2026-11-20T07:00:00+00:00',
    ends_at: null,
    rsvp_deadline: '2026-11-20T05:00:00+00:00',
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

function seed(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(trainingKeys.list(COMMUNITY), [
    makeSession('a', { going_count: 7 }),
    makeSession('b', { going_count: 3 }),
  ]);
  client.setQueryData(trainingKeys.detail('a'), makeSession('a', { going_count: 7 }));
  client.setQueryData(trainingKeys.detail('b'), makeSession('b', { going_count: 3 }));
  client.setQueryData<MyRsvps>(rsvpKeys.mine(USER), {});
  return client;
}

const listCount = (client: QueryClient, id: string) =>
  client.getQueryData<TrainingSession[]>(trainingKeys.list(COMMUNITY))?.find((s) => s.id === id)
    ?.going_count;
const detailCount = (client: QueryClient, id: string) =>
  client.getQueryData<TrainingSession>(trainingKeys.detail(id))?.going_count;
const mine = (client: QueryClient) => client.getQueryData<MyRsvps>(rsvpKeys.mine(USER));

const change = (sessionId: string, previous: RsvpChange['previous'], next: RsvpChange['next']): RsvpChange => ({
  sessionId,
  userId: USER,
  previous,
  next,
});

describe('two RSVP changes on different sessions are in flight together', () => {
  // useSetRsvp allows one mutation per SESSION, so a member can answer on card A and, before A's
  // answer arrives, on card B. The snapshot taken for A holds the whole list and the whole
  // "my answers" map, so when A fails, rolling it back also throws away B's optimistic change.
  // DEFECT Q2-3: list and detail of B now disagree and B's answer disappears from "my answers"
  // until B's own reconcile / onSettled refetch lands. Transient, but visibly wrong.
  it('rolling back A leaves B optimistic change in place (was DEFECT Q2-3)', () => {
    const client = seed();
    const snapshotA = applyRsvpToCache(client, change('a', 'no_response', 'going'));
    applyRsvpToCache(client, change('b', 'no_response', 'going'));
    expect(listCount(client, 'b')).toBe(4);

    rollbackRsvpInCache(client, snapshotA); // A was rejected

    expect(listCount(client, 'a')).toBe(7); // A is back, correct
    expect(listCount(client, 'b')).toBe(4); // B must still show its pending answer
    expect(mine(client)).toEqual({ b: 'going' });
  });

  it('after that rollback list and detail of B still agree', () => {
    const client = seed();
    const snapshotA = applyRsvpToCache(client, change('a', 'no_response', 'going'));
    applyRsvpToCache(client, change('b', 'no_response', 'going'));
    rollbackRsvpInCache(client, snapshotA);
    expect(listCount(client, 'b')).toBe(4);
    expect(detailCount(client, 'b')).toBe(4);
    expect(detailCount(client, 'a')).toBe(7);
  });

  it('rolling back restores a previously stored answer for that session only', () => {
    const client = seed();
    client.setQueryData<MyRsvps>(rsvpKeys.mine(USER), { a: 'not_going', c: 'going' });
    const snapshot = applyRsvpToCache(client, change('a', 'not_going', 'going'));
    expect(mine(client)).toEqual({ a: 'going', c: 'going' });
    rollbackRsvpInCache(client, snapshot);
    expect(mine(client)).toEqual({ a: 'not_going', c: 'going' });
  });

  it('a stale "no response" does not add a phantom +1 for an answer already stored', () => {
    const client = seed();
    client.setQueryData<MyRsvps>(rsvpKeys.mine(USER), { a: 'going' });
    // The card showed "no answer" while answers were loading and the member tapped "I'm going".
    applyRsvpToCache(client, change('a', 'no_response', 'going'));
    expect(listCount(client, 'a')).toBe(7);
    expect(detailCount(client, 'a')).toBe(7);
  });

  it('the failure heals: B reconciles with the server result afterwards', () => {
    const client = seed();
    const snapshotA = applyRsvpToCache(client, change('a', 'no_response', 'going'));
    applyRsvpToCache(client, change('b', 'no_response', 'going'));
    rollbackRsvpInCache(client, snapshotA);
    reconcileRsvpInCache(client, { sessionId: 'b', userId: USER }, { response: 'going', going_count: 4, status: 'scheduled' });
    expect(listCount(client, 'b')).toBe(4);
    expect(detailCount(client, 'b')).toBe(4);
    expect(mine(client)).toEqual({ b: 'going' });
  });

  it('two successes in either order end on the server counts', () => {
    for (const order of [['a', 'b'], ['b', 'a']] as const) {
      const client = seed();
      applyRsvpToCache(client, change('a', 'no_response', 'going'));
      applyRsvpToCache(client, change('b', 'no_response', 'not_going'));
      const results = {
        a: { response: 'going', going_count: 9, status: 'scheduled' },
        b: { response: 'not_going', going_count: 3, status: 'scheduled' },
      } as const;
      for (const id of order) reconcileRsvpInCache(client, { sessionId: id, userId: USER }, results[id]);
      expect(listCount(client, 'a')).toBe(9);
      expect(listCount(client, 'b')).toBe(3);
      expect(mine(client)).toEqual({ a: 'going', b: 'not_going' });
    }
  });
});

describe('a refetch that starts while the RSVP request is in flight', () => {
  // useSetRsvp cancels in-flight reads in onMutate, but a Realtime event (someone else answering
  // 300 ms later) or a pull-to-refresh starts a NEW read afterwards. The server has not seen our
  // change yet, so that read brings back the old count and answer and overwrites the optimistic
  // state. DEFECT Q2-4: the tapped button flips back for the duration of the request, then flips
  // forward again on success. Low severity: it ends correct, but it looks like the tap was lost.
  it('an invalidation during the mutation does not undo the optimistic answer (was DEFECT Q2-4)', async () => {
    const client = seed();
    client.mount();
    // Server state before our RPC commits.
    const serverList = [makeSession('a', { going_count: 7 }), makeSession('b', { going_count: 3 })];
    const observer = new QueryObserver(client, {
      queryKey: trainingKeys.list(COMMUNITY),
      queryFn: async () => serverList,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);

    // A change is being saved: the mutation is pending, the RPC has not answered.
    let release: () => void = () => undefined;
    const mutation = new MutationObserver(client, {
      mutationKey: setRsvpKey('a'),
      mutationFn: () => new Promise<void>((resolve) => (release = resolve)),
    });
    const done = mutation.mutate().catch(() => undefined);

    const c = change('a', 'no_response', 'going');
    await Promise.all(rsvpAffectedKeys(c).map((queryKey) => client.cancelQueries({ queryKey })));
    applyRsvpToCache(client, c);
    expect(listCount(client, 'a')).toBe(8);

    // Realtime: another member answered, the coalescer invalidates the lists.
    invalidateUnlessRsvpPending(client, { queryKey: trainingKeys.lists() });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(listCount(client, 'a')).toBe(8); // still our optimistic value

    release();
    await done;
    unsubscribe();
    client.unmount();
  });

  it('invalidations go through when no RSVP change is pending', async () => {
    const client = seed();
    let reads = 0;
    const observer = new QueryObserver(client, {
      queryKey: trainingKeys.list(COMMUNITY),
      queryFn: async () => {
        reads += 1;
        return [makeSession('a'), makeSession('b')];
      },
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const before = reads;
    invalidateUnlessRsvpPending(client, { queryKey: trainingKeys.lists() });
    await new Promise((resolve) => setTimeout(resolve, 25));
    unsubscribe();
    expect(reads).toBeGreaterThan(before);
  });
});

describe('counts never show as negative', () => {
  it('the cache may go below zero when the cached count is behind my answer...', () => {
    // List cached with 0 going, "my answers" already says going (loaded a moment later): the
    // optimistic step down is not clamped, by design (it must be exactly reversible).
    const stale = applyOptimisticRsvp({ going_count: 0 }, 'going', 'not_going');
    expect(stale.going_count).toBe(-1);
  });

  it('...but the number a member sees is clamped at zero', () => {
    const summary = participationSummary({ going_count: -1, min_participants: 10, max_participants: 20 });
    expect(summary.going).toBe(0);
    expect(summary.text).toBe('0 / 10 confirmed');
    expect(summary.remainingToMin).toBe(10);
    expect(summary.needText).toBe('10 more participants needed');
  });
});
