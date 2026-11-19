import { CreatorCodeScreen } from '@/features/communities/components/CreatorCodeScreen';
import { RequireFirstLaunchConsent } from '@/features/legal/components/RequireFirstLaunchConsent';

export default function CreatorCodeRoute() {
  return (
    <RequireFirstLaunchConsent next="create">
      <CreatorCodeScreen flow="onboarding" />
    </RequireFirstLaunchConsent>
  );
}
