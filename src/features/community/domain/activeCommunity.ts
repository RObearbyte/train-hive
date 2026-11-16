/**
 * Which community the app is showing. A user can belong to several; one is
 * the "active" one. Pure, so the rules are unit tested:
 * - the stored choice wins while it is still an active membership;
 * - otherwise the earliest membership (the list is oldest first);
 * - nothing when the list is empty.
 */
import type { MyCommunity } from '@/lib/database.types';

import type { MembershipState } from './gate';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stored value that looks like a community id, lower-cased; anything else is ignored. */
export function parseStoredCommunityId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return UUID.test(text) ? text.toLowerCase() : null;
}

/**
 * The active community id for `communities` (oldest first) and the stored id.
 * A stored id that is no longer in the list (left, removed) is ignored.
 */
export function resolveActiveCommunityId(
  communities: readonly Pick<MyCommunity, 'community_id'>[],
  storedId: string | null,
): string | null {
  if (communities.length === 0) return null;
  const stored = parseStoredCommunityId(storedId);
  if (stored !== null) {
    const match = communities.find((item) => item.community_id.toLowerCase() === stored);
    if (match) return match.community_id;
  }
  return communities[0].community_id;
}

/** Key under which the choice is stored; per user, so accounts on one device do not share it. */
export function activeCommunityStorageKey(userId: string): string {
  return `trainhive.active-community.${userId}`;
}

/** State of the list-of-communities query for the route gate. */
export function communitiesStateOf(query: {
  data: readonly unknown[] | undefined;
  isError: boolean;
}): MembershipState {
  if (query.data === undefined) return query.isError ? 'error' : 'pending';
  return query.data.length === 0 ? 'none' : 'active';
}

/** State of the active community's detail query (membership, community, profile). */
export function detailStateOf(query: { data: unknown; isError: boolean }): MembershipState {
  if (query.data !== undefined && query.data !== null) return 'active';
  return query.isError ? 'error' : 'pending';
}

/**
 * The gate's membership state from the list query, the stored choice having
 * been read, and the active community's detail query. Switching communities
 * makes the detail `pending` again; the gate keeps the user in the app then
 * (see `decideRoute`: an unknown state never moves a settled user).
 */
export function combineMembershipState(input: {
  list: MembershipState;
  storageLoaded: boolean;
  detail: MembershipState;
}): MembershipState {
  if (input.list !== 'active') return input.list;
  if (!input.storageLoaded) return 'pending';
  return input.detail;
}

/**
 * A notification belongs to `targetCommunityId`. Returns the community to
 * switch to first, or null when no switch is needed or allowed (already
 * active, or the user is not an active member of it).
 */
export function communityToSwitchTo(
  targetCommunityId: string | null,
  communities: readonly Pick<MyCommunity, 'community_id'>[],
  activeId: string | null,
): string | null {
  if (targetCommunityId === null) return null;
  const target = targetCommunityId.toLowerCase();
  if (activeId !== null && activeId.toLowerCase() === target) return null;
  const match = communities.find((item) => item.community_id.toLowerCase() === target);
  return match ? match.community_id : null;
}

/** Defensive parse of the `list_my_communities` JSON; a malformed entry is an error (never silently dropped, which could read as "no communities"). */
export function parseMyCommunities(json: unknown): MyCommunity[] {
  if (!Array.isArray(json)) throw new Error('list_my_communities did not return an array.');
  const out: MyCommunity[] = [];
  for (const item of json as unknown[]) {
    const row = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    if (
      typeof row.community_id === 'string' &&
      typeof row.membership_id === 'string' &&
      typeof row.name === 'string' &&
      typeof row.timezone === 'string' &&
      (row.role === 'organizer' || row.role === 'member') &&
      typeof row.joined_at === 'string'
    ) {
      out.push({
        community_id: row.community_id,
        membership_id: row.membership_id,
        name: row.name,
        timezone: row.timezone,
        role: row.role,
        joined_at: row.joined_at,
      });
    } else {
      throw new Error('list_my_communities returned an unexpected row.');
    }
  }
  return out;
}
