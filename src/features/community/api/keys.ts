/**
 * TanStack Query keys for the user's memberships. Everything that is
 * specific to one community carries the community id, so switching never
 * shows another community's cached data.
 *
 * - `membershipKeys.communities(userId)`          -> `MyCommunity[]` (every active membership)
 * - `membershipKeys.current(userId, communityId)` -> `CurrentMembership` (membership, community, profile)
 * - `membershipKeys.members(communityId)`         -> `CommunityMember[]`
 * - `membershipKeys.roster(communityId)`          -> `RosterEntry[]` (organizers' Members screen, removed ones included)
 */
export const membershipKeys = {
  all: ['membership'] as const,
  communities: (userId: string | null) => ['membership', 'communities', userId] as const,
  current: (userId: string | null, communityId: string | null) =>
    ['membership', 'current', userId, communityId] as const,
  members: (communityId: string | null) => ['membership', 'members', communityId] as const,
  roster: (communityId: string | null) => ['membership', 'roster', communityId] as const,
};
