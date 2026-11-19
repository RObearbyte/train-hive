import type { ReactNode } from 'react';

import { LoadingState, Screen } from '@/ui';

import { useMyConsents } from '../hooks/useConsents';
import { TermsUpdateScreen } from './TermsUpdateScreen';

/**
 * Sits between the membership gate and the app. When the server says the
 * member has not accepted the current terms (`needs_terms_acceptance`) the
 * "We updated our terms" screen replaces the app until they do. While the
 * answer is loading a spinner is shown; if it cannot be read (offline, server
 * error) the app opens normally, because the server does not gate reading,
 * RSVP or attendance on consent, only new joins and push registration, and it
 * enforces both.
 */
export function ConsentGate({ children }: { children: ReactNode }) {
  const { consents, isLoading } = useMyConsents();
  if (isLoading) {
    return (
      <Screen>
        <LoadingState style={{ flex: 1 }} />
      </Screen>
    );
  }
  if (consents?.needs_terms_acceptance) return <TermsUpdateScreen />;
  return <>{children}</>;
}
