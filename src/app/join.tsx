import { Redirect, type Href } from 'expo-router';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { FLOW_ROUTES } from '@/features/onboarding/domain/flowRoutes';
import { capturePendingJoinFromLocation } from '@/features/onboarding/domain/pendingJoin';

/**
 * Web join link: `/join#code=ABCD-EFGH`. The code is read from the fragment
 * (already done when the app loaded; repeated here for in-app navigation),
 * kept in memory, and the fragment is removed from the address bar. Then the
 * normal join flow continues with the code filled in: the onboarding code
 * screen, or "Join another community" for someone who already has one.
 * A missing or malformed code simply opens the ordinary code screen.
 */
export default function JoinLinkRoute() {
  const { communities } = useCurrentMembership();
  capturePendingJoinFromLocation();
  const flow = communities.length > 0 ? 'signedIn' : 'onboarding';
  return <Redirect href={FLOW_ROUTES[flow].joinCode as Href} />;
}
