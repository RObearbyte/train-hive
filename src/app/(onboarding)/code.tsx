import { RequireFirstLaunchConsent } from '@/features/legal/components/RequireFirstLaunchConsent';
import { InvitationCodeScreen } from '@/features/onboarding/components/InvitationCodeScreen';

export default function InvitationCodeRoute() {
  return (
    <RequireFirstLaunchConsent next="join">
      <InvitationCodeScreen flow="onboarding" />
    </RequireFirstLaunchConsent>
  );
}
