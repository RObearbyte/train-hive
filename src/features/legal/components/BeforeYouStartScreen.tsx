import { Redirect, useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { KeyboardScreen } from '@/features/onboarding/components/KeyboardScreen';
import { FLOW_ROUTES } from '@/features/onboarding/domain/flowRoutes';
import { userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Banner, Button, ErrorState, LoadingState, Screen, Text, useTheme } from '@/ui';

import { MINIMUM_AGE } from '../constants';
import {
  canContinue,
  needsConsentStep,
  parseStartTarget,
  type ConsentStartTarget,
} from '../domain/consentState';
import { clearPushIntent, writePushIntent } from '../api/pushIntentStorage';
import { useLocalAcceptance } from '../hooks/useConsents';
import { ConsentCheckbox } from './ConsentCheckbox';
import { LegalLinks } from './LegalLinks';

const TARGET_ROUTE: Record<ConsentStartTarget, string> = {
  join: FLOW_ROUTES.onboarding.joinCode,
  create: FLOW_ROUTES.onboarding.createCode,
};

/**
 * First launch: "Before you start". Collects the acknowledgement of the Terms
 * and Privacy Notice and the 16+ confirmation, both unticked, and keeps them on
 * the device. The server records them as soon as the anonymous account exists
 * (right before the first join / create), see `ensureConsentRecorded`.
 */
export function BeforeYouStartScreen({ next }: { next: unknown }) {
  const router = useRouter();
  const { spacing } = useTheme();
  const target = parseStartTarget(next);
  const { acceptance, isLoading, error, accept } = useLocalAcceptance();
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [confirmedAge, setConfirmedAge] = useState(false);
  const [wantsPush, setWantsPush] = useState(false);

  if (isLoading) {
    return (
      <Screen>
        <LoadingState style={{ flex: 1 }} />
      </Screen>
    );
  }
  if (error) {
    return (
      <Screen>
        <ErrorState message={userMessage(error.code, error.field)} style={{ flex: 1 }} />
      </Screen>
    );
  }
  // Already acknowledged (this build's texts): nothing to ask, go on. Also what happens right after Continue.
  if (!needsConsentStep(acceptance ?? null)) return <Redirect href={TARGET_ROUTE[target] as Href} />;

  const ready = canContinue({ acceptedTerms, confirmedAge });
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/welcome' as Href);
  };

  return (
    <KeyboardScreen>
      <View style={{ alignItems: 'flex-start' }}>
        <Button
          label="Back"
          variant="ghost"
          size="sm"
          icon="chevron-left"
          onPress={goBack}
          disabled={accept.isPending}
        />
      </View>

      <View style={{ gap: spacing.sm }}>
        <Text variant="title">Before you start</Text>
        <Text color="textMuted">
          TrainHive keeps your name, your answers to trainings and your attendance so your community
          can plan together. Please read how it works, then confirm two things.
        </Text>
      </View>

      <LegalLinks />

      <View style={{ gap: spacing.xs }}>
        <ConsentCheckbox
          testID="consent-terms"
          label="I have read and accept the Terms of Use and the Privacy Notice"
          checked={acceptedTerms}
          onChange={setAcceptedTerms}
          disabled={accept.isPending}
        />
        <ConsentCheckbox
          testID="consent-age"
          label={`I confirm I am at least ${MINIMUM_AGE} years old`}
          checked={confirmedAge}
          onChange={setConfirmedAge}
          disabled={accept.isPending}
        />
      </View>

      <View style={{ gap: spacing.xs }}>
        <Text variant="heading">Stay in the loop</Text>
        <Text color="textMuted">
          Notifications are how you hear that an event is confirmed or cancelled, or that your
          organizer posted something. Without them you only see changes when you open the app. This
          one is optional and starts unticked.
        </Text>
        <ConsentCheckbox
          testID="consent-push"
          label="Send me push notifications about events and announcements"
          checked={wantsPush}
          onChange={setWantsPush}
          disabled={accept.isPending}
        />
        <Text variant="caption" color="textMuted">
          You can change this any time in Profile, then Privacy.
        </Text>
      </View>

      {accept.error ? (
        <Banner tone="error" message="We could not save your choice on this device. Please try again." />
      ) : null}

      <Button
        label="Continue"
        size="lg"
        fullWidth
        disabled={!ready}
        loading={accept.isPending}
        accessibilityHint={ready ? undefined : 'Tick both boxes to continue'}
        onPress={() => {
          if (!ready || accept.isPending) return;
          // Only a note on this device; the signed-in app records it and asks the system once.
          const save = wantsPush ? writePushIntent() : clearPushIntent();
          save
            .catch((error: unknown) => reportError('consents.savePushIntent', error))
            .finally(() => accept.mutate());
        }}
      />
      {ready ? null : (
        <Text variant="caption" color="textMuted" align="center">
          Tick both boxes to continue.
        </Text>
      )}
    </KeyboardScreen>
  );
}
