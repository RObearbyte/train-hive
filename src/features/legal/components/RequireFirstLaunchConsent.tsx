import { Redirect, type Href } from 'expo-router';
import type { ReactNode } from 'react';

import { LoadingState, Screen } from '@/ui';

import { needsConsentStep, type ConsentStartTarget } from '../domain/consentState';
import { useLocalAcceptance } from '../hooks/useConsents';

/**
 * Wraps the first onboarding screens: without this device's acknowledgement of
 * the current texts, the person is sent to "Before you start" first (also when
 * they arrive by a web join link). If the stored value cannot be read the
 * screen is shown anyway: the server refuses a join without consent, and that
 * answer sends the person back here.
 */
export function RequireFirstLaunchConsent({
  next,
  children,
}: {
  next: ConsentStartTarget;
  children: ReactNode;
}) {
  const { acceptance, isLoading, error } = useLocalAcceptance();
  if (isLoading) {
    return (
      <Screen>
        <LoadingState style={{ flex: 1 }} />
      </Screen>
    );
  }
  if (!error && needsConsentStep(acceptance ?? null)) {
    return <Redirect href={`/consent?next=${next}` as Href} />;
  }
  return <>{children}</>;
}
