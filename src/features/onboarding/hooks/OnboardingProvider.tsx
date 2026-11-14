import { createContext, use, useState, type ReactNode } from 'react';

import type { InvitationPreview } from '../api/invitations';

/** A code the server has accepted, carried from the code screen to the name screen. */
export type AcceptedInvitation = InvitationPreview & { code: string };

type OnboardingContextValue = {
  invitation: AcceptedInvitation | null;
  setInvitation: (invitation: AcceptedInvitation | null) => void;
};

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

/**
 * Holds the accepted code in memory for the length of the onboarding flow.
 * It is kept out of route params so the code never appears in a URL.
 */
export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [invitation, setInvitation] = useState<AcceptedInvitation | null>(null);
  return <OnboardingContext value={{ invitation, setInvitation }}>{children}</OnboardingContext>;
}

export function useOnboarding(): OnboardingContextValue {
  const context = use(OnboardingContext);
  if (!context) throw new Error('useOnboarding must be used inside OnboardingProvider.');
  return context;
}
