import { useState } from 'react';
import { View } from 'react-native';

import { DeleteAccountFlow } from '@/features/dataRights/components/DeleteAccountFlow';
import { DownloadMyData } from '@/features/dataRights/components/DownloadMyData';
import { userMessage } from '@/lib/errors';
import { Banner, Button, Card, Screen, Text, useTheme } from '@/ui';

import { MINIMUM_AGE } from '../constants';
import { canContinue } from '../domain/consentState';
import {
  DELETE_WITHOUT_ACCEPTING_LABEL,
  LEAVE_WITHOUT_ACCEPTING_TEXT,
  LEAVE_WITHOUT_ACCEPTING_TITLE,
} from '../domain/termsUpdate';
import { useAcceptUpdatedTerms } from '../hooks/useConsents';
import { ConsentCheckbox } from './ConsentCheckbox';
import { LegalLinks } from './LegalLinks';

/**
 * "We updated our terms and privacy notice": shown to a signed-in member whose
 * server record is missing or out of date (every member from before the consent
 * ledger, and everyone after a new version). The way on is to accept; the
 * alternative is to download the data or delete the account right here, which
 * the server allows without current consent. Rights never depend on accepting.
 */
export function TermsUpdateScreen() {
  const { spacing } = useTheme();
  const accept = useAcceptUpdatedTerms();
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [confirmedAge, setConfirmedAge] = useState(false);
  const [deleting, setDeleting] = useState(false);
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

      <Card style={{ gap: spacing.sm }}>
        <Text variant="heading">{LEAVE_WITHOUT_ACCEPTING_TITLE}</Text>
        <Text color="textMuted">{LEAVE_WITHOUT_ACCEPTING_TEXT}</Text>
        <DownloadMyData />
        <Button
          label={DELETE_WITHOUT_ACCEPTING_LABEL}
          variant="danger"
          icon="trash"
          fullWidth
          accessibilityHint="Opens the steps to delete your account. Nothing is deleted yet."
          onPress={() => setDeleting(true)}
          testID="terms-update-delete-open"
        />
      </Card>

      <DeleteAccountFlow visible={deleting} onClose={() => setDeleting(false)} />
    </Screen>
  );
}
