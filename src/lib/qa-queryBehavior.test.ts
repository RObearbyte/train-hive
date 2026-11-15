/**
 * QA (M1-Q1 part 2): how the app's TanStack Query configuration behaves when
 * the network is not there or a refetch fails. Real `@tanstack/query-core`
 * objects, no mocks of the library.
 *
 * `src/lib/queryClient.ts` cannot be imported here (it pulls in NetInfo and
 * react-native), so the options below copy its `defaultOptions` verbatim:
 * staleTime 30 s, retry only network errors, mutations never retried, and NO
 * `networkMode` (the library default, "online"). The app flips
 * `onlineManager` from NetInfo, so `setOnline(false)` is exactly what airplane
 * mode does on a phone.
 *
 * The defects found here (Q2-n) have been fixed and the tests assert the fixed behaviour; see docs/QA_REPORT.md Part 2.
 */
import {
  MutationObserver,
  QueryClient,
  QueryObserver,
  onlineManager,
} from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';

import { membershipStateOf } from '@/features/community/domain/gate';

import { queryDefaultOptions } from './queryDefaults';

// The app's real defaults (queryDefaults.ts) with retries off so the tests are quick.
const APP_DEFAULTS = {
  queries: { ...queryDefaultOptions.queries, retry: false },
  mutations: { ...queryDefaultOptions.mutations },
};
// The TanStack library default, which the app does NOT use ('online': pauses while offline).
const LIBRARY_DEFAULTS = {
  queries: { retry: false },
  mutations: { retry: false },
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

afterEach(() => {
  onlineManager.setOnline(true);
});

describe('offline cold start (the gate query)', () => {
  // DEFECT Q2-1: with NetInfo reporting "offline" (airplane mode) and a still-valid stored
  // session, the membership query never runs: it is `pending` + `paused`. useCurrentMembership
  // maps that to state 'pending', the gate keeps route 'loading', and the native splash screen
  // is never hidden. The "Can't reach TrainHive" screen (route 'error') is unreachable offline.
  it('an offline first load ends in an error state instead of waiting forever (was DEFECT Q2-1)', async () => {
    onlineManager.setOnline(false);
    const client = new QueryClient({ defaultOptions: APP_DEFAULTS });
    let calls = 0;
    const observer = new QueryObserver(client, {
      queryKey: ['membership', 'current', 'user'],
      queryFn: async () => {
        calls += 1;
        throw new Error('Network request failed');
      },
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await settle();
    const result = observer.getCurrentResult();
    unsubscribe();

    expect(calls).toBeGreaterThan(0); // the request was attempted
    expect(result.isError).toBe(true); //  and the user is told it failed
  });

  it('characterization: with the library default networkMode, offline queries are paused', async () => {
    onlineManager.setOnline(false);
    const client = new QueryClient({ defaultOptions: LIBRARY_DEFAULTS });
    const observer = new QueryObserver(client, {
      queryKey: ['membership', 'current', 'user'],
      queryFn: async () => ({ ok: true }),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await settle();
    const result = observer.getCurrentResult();
    unsubscribe();

    expect(result.status).toBe('pending');
    expect(result.fetchStatus).toBe('paused');
    expect(result.data).toBeUndefined();
    expect(result.error).toBeNull();
  });

  it('a paused query resumes by itself when the connection returns', async () => {
    onlineManager.setOnline(false);
    const client = new QueryClient({ defaultOptions: LIBRARY_DEFAULTS });
    client.mount(); // QueryClientProvider does this in the app
    const observer = new QueryObserver(client, {
      queryKey: ['membership', 'current', 'user'],
      queryFn: async () => 'member',
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await settle();
    onlineManager.setOnline(true);
    await settle();
    const result = observer.getCurrentResult();
    unsubscribe();
    client.unmount();
    expect(result.data).toBe('member');
  });
});

describe('a refetch that fails after the first success (joining a community)', () => {
  // Premise of DEFECT Q2-2 (name.tsx:59, useCurrentMembership.ts:40-42): after redeeming, the
  // membership query already holds `null` (fetched during onboarding). If the refetch that
  // follows the redemption fails, TanStack keeps `data === null` and only sets isError. The hook
  // computes `state` from `data !== undefined` first, so it reports 'none', never 'error'; the
  // "You have joined ... Try again" banner (`membership.state === 'error'`) cannot appear and the
  // Join button stays in its loading state because `joined = redeem.isSuccess`.
  it('keeps the old data (null) and reports isError; the state mapping says "error"', async () => {
    const client = new QueryClient({ defaultOptions: APP_DEFAULTS });
    let fail = false;
    const observer = new QueryObserver(client, {
      queryKey: ['membership', 'current', 'user'],
      queryFn: async (): Promise<null | { id: string }> => {
        if (fail) throw new Error('Network request failed');
        return null; // signed in, no membership yet
      },
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await settle();
    expect(observer.getCurrentResult().data).toBeNull();

    fail = true; // the redemption happened; the refetch now fails
    await client.invalidateQueries({ queryKey: ['membership'] }); // what onSuccess awaits
    const result = observer.getCurrentResult();
    unsubscribe();

    expect(result.isError).toBe(true);
    expect(result.data).toBeNull(); // still defined

    // The hook's mapping (gate.ts): the failed refetch wins over the stale null (was DEFECT Q2-2).
    expect(membershipStateOf(result)).toBe('error');
    // ...but a failed background refetch of an active membership keeps the app.
    expect(membershipStateOf({ data: { id: 'm' }, isError: true })).toBe('active');
    expect(membershipStateOf({ data: null, isError: false })).toBe('none');
    expect(membershipStateOf({ data: undefined, isError: false })).toBe('pending');
  });

  it('invalidateQueries (the redeem onSuccess) resolves even though the refetch failed', async () => {
    const client = new QueryClient({ defaultOptions: APP_DEFAULTS });
    let fail = false;
    const observer = new QueryObserver(client, {
      queryKey: ['membership', 'current', 'user'],
      queryFn: async () => {
        if (fail) throw new Error('boom');
        return null;
      },
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await settle();
    fail = true;
    await expect(client.invalidateQueries({ queryKey: ['membership'] })).resolves.toBeUndefined();
    unsubscribe();
  });
});

describe('RSVP mutation while offline', () => {
  // DEFECT Q2-5: useSetRsvp relies on the default networkMode. Offline, onMutate still runs
  // (the optimistic answer is shown) but the RPC is held back and the mutation stays pending with
  // no error. The member sees a spinner and an answer that looks saved; taps are ignored
  // (`isMutating > 0`); when the connection returns the stale request is sent, possibly after the
  // deadline, and only then does a rollback or an error appear.
  it('an RSVP attempted offline fails fast and is rolled back (was DEFECT Q2-5)', async () => {
    onlineManager.setOnline(false);
    const client = new QueryClient({ defaultOptions: APP_DEFAULTS });
    const events: string[] = [];
    const mutation = new MutationObserver(client, {
      mutationKey: ['rsvps', 'set', 's1'],
      onMutate: () => {
        events.push('optimistic');
      },
      onError: () => {
        events.push('rollback');
      },
      mutationFn: async () => {
        throw new Error('Network request failed');
      },
    });
    void mutation.mutate().catch(() => undefined);
    await settle();
    expect(mutation.getCurrentResult().isPaused).toBe(false);
    expect(mutation.getCurrentResult().isError).toBe(true);
    expect(events).toEqual(['optimistic', 'rollback']);
  });

  it('characterization: with the library default, offline onMutate runs but the request is held back', async () => {
    onlineManager.setOnline(false);
    const client = new QueryClient({ defaultOptions: LIBRARY_DEFAULTS });
    client.mount();
    const events: string[] = [];
    const mutation = new MutationObserver(client, {
      mutationKey: ['rsvps', 'set', 's1'],
      onMutate: () => {
        events.push('optimistic update applied');
      },
      mutationFn: async () => {
        events.push('request sent');
        return { response: 'going' };
      },
    });
    void mutation.mutate().catch(() => undefined);
    await settle();
    expect(events).toEqual(['optimistic update applied']);
    expect(mutation.getCurrentResult().isPaused).toBe(true);
    expect(client.isMutating({ mutationKey: ['rsvps', 'set', 's1'] })).toBe(1);

    onlineManager.setOnline(true);
    await settle();
    expect(events).toEqual(['optimistic update applied', 'request sent']); // sent late
    client.unmount();
  });
});
