import { randomUUID } from 'expo-crypto';
import { createContext, use, useState, type ReactNode } from 'react';

import {
  createRequestIdTracker,
  type RequestIdTracker,
} from '@/features/communities/domain/requestId';

import type { InvitationPreview } from '../api/invitations';

/** A code the server has accepted, carried from the code screen to the name screen. */
export type AcceptedInvitation = InvitationPreview & { code: string };

type OnboardingContextValue = {
  invitation: AcceptedInvitation | null;
  setInvitation: (invitation: AcceptedInvitation | null) => void;
  /** A creator code the server has accepted (normalized), carried to the community details screen. */
  creatorCode: string | null;
  setCreatorCode: (code: string | null) => void;
  /** The idempotency key of the community being created; lives as long as the flow. */
  requestIds: RequestIdTracker;
};

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

/**
 * Holds the accepted codes in memory for the length of a join / create flow
 * (onboarding, or "add a community" from the app). They are kept out of route
 * params so a code never appears in a URL.
 */
export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [invitation, setInvitation] = useState<AcceptedInvitation | null>(null);
  const [creatorCode, setCreatorCode] = useState<string | null>(null);
  const [requestIds] = useState(() => createRequestIdTracker(randomUUID));
  return (
    <OnboardingContext value={{ invitation, setInvitation, creatorCode, setCreatorCode, requestIds }}>
      {children}
    </OnboardingContext>
  );
}

export function useOnboarding(): OnboardingContextValue {
  const context = use(OnboardingContext);
  if (!context) throw new Error('useOnboarding must be used inside OnboardingProvider.');
  return context;
}
