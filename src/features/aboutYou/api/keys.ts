/**
 * TanStack Query keys for "About you".
 *
 * Cached shapes:
 * - `aboutYouKeys.mine(userId)`                       -> `AboutYou` (my own details)
 * - `aboutYouKeys.emergencyList(communityId)`         -> `CommunityEmergencyList` (organizers)
 * - `aboutYouKeys.memberEmergency(communityId, user)` -> `MemberEmergencyInfo` (organizers)
 * - `aboutYouKeys.demographics(communityId)`          -> `CommunityDemographics` (organizers)
 */
export const aboutYouKeys = {
  all: ['aboutYou'] as const,
  mine: (userId: string | null) => ['aboutYou', 'mine', userId] as const,
  emergencyList: (communityId: string | null) => ['aboutYou', 'emergencyList', communityId] as const,
  memberEmergency: (communityId: string | null, userId: string | null) =>
    ['aboutYou', 'memberEmergency', communityId, userId] as const,
  demographics: (communityId: string | null) => ['aboutYou', 'demographics', communityId] as const,
};
