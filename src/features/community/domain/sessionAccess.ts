/**
 * Rights over a record follow the community the record belongs to, not the
 * community that happens to be active: a training of community B can be on
 * screen while A is active (a notification, a screen left in the stack). Pure.
 */
import type { MyCommunity } from '@/lib/database.types';

export type CommunityRole = MyCommunity['role'];

/** My role in `communityId` (ids compared case-insensitively), or null when I am not an active member of it. */
export function roleInCommunity(
  communities: readonly Pick<MyCommunity, 'community_id' | 'role'>[],
  communityId: string | null | undefined,
): CommunityRole | null {
  if (typeof communityId !== 'string') return null;
  const wanted = communityId.toLowerCase();
  return communities.find((item) => item.community_id.toLowerCase() === wanted)?.role ?? null;
}

/** True when I organize `communityId`; false for a member, for a stranger and while the list is empty. */
export function isOrganizerOf(
  communities: readonly Pick<MyCommunity, 'community_id' | 'role'>[],
  communityId: string | null | undefined,
): boolean {
  return roleInCommunity(communities, communityId) === 'organizer';
}
