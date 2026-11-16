import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { activityKeys } from '@/features/notifications/api/keys';
import { statisticsKeys } from '@/features/statistics/api/keys';
import { rsvpKeys, trainingKeys } from '@/features/trainings/api/keys';
import type { MyCommunity } from '@/lib/database.types';

import { membershipKeys } from '../api/keys';
import {
  activeCommunityStorageKey,
  combineMembershipState,
  communitiesStateOf,
  communityToSwitchTo,
  detailStateOf,
  parseMyCommunities,
  parseStoredCommunityId,
  resolveActiveCommunityId,
} from './activeCommunity';
import { decideRoute } from './gate';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function community(id: string, extra: Partial<MyCommunity> = {}): MyCommunity {
  return {
    community_id: id,
    membership_id: `m-${id}`,
    name: `Pack ${id.slice(0, 1)}`,
    timezone: 'Europe/Bucharest',
    role: 'member',
    joined_at: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

describe('resolveActiveCommunityId', () => {
  const list = [community(A), community(B)];

  it('uses the stored id while it is still an active membership', () => {
    expect(resolveActiveCommunityId(list, B)).toBe(B);
  });

  it('matches the stored id case-insensitively and returns the list casing', () => {
    expect(resolveActiveCommunityId(list, B.toUpperCase())).toBe(B);
  });

  it('falls back to the earliest membership when the stored id is not in the list (removed or left)', () => {
    expect(resolveActiveCommunityId(list, C)).toBe(A);
  });

  it('falls back to the earliest membership for garbage or missing stored values', () => {
    expect(resolveActiveCommunityId(list, 'not-a-uuid')).toBe(A);
    expect(resolveActiveCommunityId(list, '')).toBe(A);
    expect(resolveActiveCommunityId(list, null)).toBe(A);
  });

  it('returns null for an empty list, whatever is stored', () => {
    expect(resolveActiveCommunityId([], null)).toBeNull();
    expect(resolveActiveCommunityId([], A)).toBeNull();
  });

  it('moves to the remaining community when the active one disappears from the list', () => {
    expect(resolveActiveCommunityId([community(A), community(B)], B)).toBe(B);
    expect(resolveActiveCommunityId([community(A)], B)).toBe(A);
  });
});

describe('parseStoredCommunityId / storage key', () => {
  it('accepts a uuid and lower-cases it, rejects anything else', () => {
    expect(parseStoredCommunityId(` ${A.toUpperCase()} `)).toBe(A);
    expect(parseStoredCommunityId('abc')).toBeNull();
    expect(parseStoredCommunityId(undefined)).toBeNull();
  });

  it('is per user and only uses characters SecureStore allows', () => {
    expect(activeCommunityStorageKey(A)).not.toBe(activeCommunityStorageKey(B));
    expect(activeCommunityStorageKey(A)).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('gate state from the list and the active detail', () => {
  it('maps the list query', () => {
    expect(communitiesStateOf({ data: undefined, isError: false })).toBe('pending');
    expect(communitiesStateOf({ data: undefined, isError: true })).toBe('error');
    expect(communitiesStateOf({ data: [], isError: false })).toBe('none');
    expect(communitiesStateOf({ data: [community(A)], isError: true })).toBe('active');
  });

  it('maps the detail query', () => {
    expect(detailStateOf({ data: undefined, isError: false })).toBe('pending');
    expect(detailStateOf({ data: undefined, isError: true })).toBe('error');
    expect(detailStateOf({ data: { any: 1 }, isError: true })).toBe('active');
  });

  it('is only active when the list, the stored choice and the detail are all known', () => {
    expect(combineMembershipState({ list: 'none', storageLoaded: true, detail: 'pending' })).toBe('none');
    expect(combineMembershipState({ list: 'error', storageLoaded: true, detail: 'pending' })).toBe('error');
    expect(combineMembershipState({ list: 'active', storageLoaded: false, detail: 'active' })).toBe('pending');
    expect(combineMembershipState({ list: 'active', storageLoaded: true, detail: 'pending' })).toBe('pending');
    expect(combineMembershipState({ list: 'active', storageLoaded: true, detail: 'active' })).toBe('active');
  });

  it('a switch (detail pending again) never bounces a user out of the app', () => {
    const state = combineMembershipState({ list: 'active', storageLoaded: true, detail: 'pending' });
    expect(decideRoute({ session: 'present', membership: state }, 'app')).toBe('app');
  });

  it('being removed from the last community moves the user to onboarding', () => {
    const state = combineMembershipState({ list: 'none', storageLoaded: true, detail: 'pending' });
    expect(decideRoute({ session: 'present', membership: state }, 'app')).toBe('onboarding');
  });
});

describe('communityToSwitchTo (notification of another community)', () => {
  const list = [community(A), community(B)];

  it('switches when the notification belongs to another community of mine', () => {
    expect(communityToSwitchTo(B, list, A)).toBe(B);
  });

  it('does nothing for the active community, an unknown one, or no community id', () => {
    expect(communityToSwitchTo(A, list, A)).toBeNull();
    expect(communityToSwitchTo(C, list, A)).toBeNull();
    expect(communityToSwitchTo(null, list, A)).toBeNull();
  });
});

describe('parseMyCommunities', () => {
  it('parses the contract shape', () => {
    expect(parseMyCommunities([community(A, { role: 'organizer' })])).toEqual([
      community(A, { role: 'organizer' }),
    ]);
    expect(parseMyCommunities([])).toEqual([]);
  });

  it('throws on anything else instead of reading as "no communities"', () => {
    expect(() => parseMyCommunities(null)).toThrow();
    expect(() => parseMyCommunities([{ community_id: A }])).toThrow();
  });
});

describe('query keys per community (real QueryClient)', () => {
  const USER = '99999999-9999-4999-8999-999999999999';

  it('keeps every community-scoped cache separate and invalidates one without the other', async () => {
    const client = new QueryClient();
    const keysFor = (id: string) => [
      trainingKeys.list(id),
      activityKeys.feed(id, USER),
      activityKeys.notifications(id, USER),
      activityKeys.managed(id),
      statisticsKeys.mine(id, USER, '30d'),
      statisticsKeys.community(id, '30d'),
      statisticsKeys.summary(id, '30d'),
      membershipKeys.current(USER, id),
      membershipKeys.members(id),
    ];
    for (const id of [A, B]) {
      for (const key of keysFor(id)) client.setQueryData(key, { owner: id });
    }
    for (const id of [A, B]) {
      for (const key of keysFor(id)) expect(client.getQueryData(key)).toEqual({ owner: id });
    }
    await client.invalidateQueries({ queryKey: trainingKeys.list(A) });
    expect(client.getQueryState(trainingKeys.list(A))?.isInvalidated).toBe(true);
    expect(client.getQueryState(trainingKeys.list(B))?.isInvalidated).toBe(false);
    client.clear();
  });

  it('user-wide keys never need a community id (answers are by session id)', () => {
    expect(rsvpKeys.mine(USER)).toEqual(['rsvps', 'mine', USER]);
  });
});
