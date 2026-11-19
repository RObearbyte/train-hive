import { useState } from 'react';
import { View } from 'react-native';

import { userMessage } from '@/lib/errors';
import { Banner, Button, Screen, Text, useTheme } from '@/ui';

import { MINIMUM_AGE } from '../constants';
import { canContinue } from '../domain/consentState';
import { useAcceptUpdatedTerms } from '../hooks/useConsents';
import { ConsentCheckbox } from './ConsentCheckbox';
import { LegalLinks } from './LegalLinks';

/**
 * "We updated our terms and privacy notice": shown to a signed-in member whose
 * server record is missing or out of date (every member from before the consent
 * ledger, and everyone after a new version). The only way on is to accept; the
 * only alternative is leaving the app. Deleting the account is planned for a
 * later release, so it is described as "coming soon", not offered as a button.
 */
export function TermsUpdateScreen() {
  const { spacing } = useTheme();
  const accept = useAcceptUpdatedTerms();
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [confirmedAge, setConfirmedAge] = useState(false);
  const ready = canContinue({ acceptedTerms, confirmedAge });

  return (
    <Screen scroll>
      <View style={{ gap: spacing.sm }}>
        <Text variant="title">We updated our terms and privacy notice</Text>
        <Text color="textMuted">
          To keep using TrainHive we need you to read the current Terms of Use and Privacy Notice and
          confirm your age. Nothing else changes: your communities and history stay as they are.
        </Text>
      </View>

      <LegalLinks />

      <View style={{ gap: spacing.xs }}>
        <ConsentCheckbox
          testID="update-consent-terms"
          label="I have read and accept the Terms of Use and the Privacy Notice"
          checked={acceptedTerms}
          onChange={setAcceptedTerms}
          disabled={accept.isPending}
        />
        <ConsentCheckbox
          testID="update-consent-age"
          label={`I confirm I am at least ${MINIMUM_AGE} years old`}
          checked={confirmedAge}
          onChange={setConfirmedAge}
          disabled={accept.isPending}
        />
      </View>

      {accept.error ? (
        <Banner tone="error" message={userMessage(accept.error.code, accept.error.field)} />
      ) : null}

      <Button
        label="Accept and continue"
        size="lg"
        fullWidth
        disabled={!ready}
        loading={accept.isPending}
        accessibilityHint={ready ? undefined : 'Tick both boxes to continue'}
        onPress={() => {
          if (ready && !accept.isPending) accept.mutate();
        }}
      />
      {ready ? null : (
        <Text variant="caption" color="textMuted" align="center">
          Tick both boxes to continue.
        </Text>
      )}

      <Text variant="caption" color="textMuted">
        If you do not agree, you can close the app. Deleting your account from within the app (Profile,
        Privacy, Delete my account) is coming soon; until then, ask us through the privacy contact in
        the Privacy Notice.
      </Text>
    </Screen>
  );
}
