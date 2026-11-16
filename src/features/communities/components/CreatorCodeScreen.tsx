import { useState } from 'react';
import { View } from 'react-native';

import { KeyboardScreen } from '@/features/onboarding/components/KeyboardScreen';
import type { AddCommunityFlow } from '@/features/onboarding/domain/flowRoutes';
import {
  formatInvitationCode,
  isValidInvitationCodeFormat,
  normalizeInvitationCode,
  toInvitationCodeInput,
} from '@/features/onboarding/domain/invitationCode';
import { useOnboarding } from '@/features/onboarding/hooks/OnboardingProvider';
import { useFlowNavigation } from '@/features/onboarding/hooks/useFlowNavigation';
import { Banner, Button, Text, TextField, useTheme } from '@/ui';

import { mapCreatorError } from '../domain/creatorErrors';
import { usePreviewCreatorCode } from '../hooks/useCommunityMutations';

// Creator codes use the same 8-character alphabet and format as invitation codes.
const FORMAT_HINT =
  'Codes have 8 characters, like ABCD-EFGH, and never contain 0, 1, I, L, O or U. Check for typos.';

/** Creator flow, screen 1: the creator code. */
export function CreatorCodeScreen({ flow }: { flow: AddCommunityFlow }) {
  const navigation = useFlowNavigation(flow);
  const { spacing } = useTheme();
  const { creatorCode, setCreatorCode } = useOnboarding();
  const preview = usePreviewCreatorCode();

  const [code, setCode] = useState(() => (creatorCode ? formatInvitationCode(creatorCode) : ''));
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  // The accepted code still matches what is in the field.
  const accepted = creatorCode !== null && creatorCode === normalizeInvitationCode(code);

  const onChangeCode = (text: string) => {
    setCode(toInvitationCodeInput(text));
    setFieldError(undefined);
    if (preview.isError) preview.reset();
  };

  const check = () => {
    // Ignore a second tap while the first request is running.
    if (preview.isPending) return;
    if (!isValidInvitationCodeFormat(code)) {
      // Caught here so a typo does not use up one of the limited attempts.
      setFieldError(FORMAT_HINT);
      return;
    }
    const submitted = normalizeInvitationCode(code);
    preview.mutate(submitted, {
      onSuccess: () => setCreatorCode(submitted),
      onError: (error) => {
        const view = mapCreatorError(error);
        if (view.target === 'code') setFieldError(view.message);
      },
    });
  };

  const banner = preview.error ? mapCreatorError(preview.error) : null;
  const bannerError = banner && banner.target !== 'code' ? banner : null;

  return (
    <KeyboardScreen>
      <View style={{ alignItems: 'flex-start' }}>
        <Button
          label="Back"
          variant="ghost"
          size="sm"
          icon="chevron-left"
          onPress={navigation.back}
          disabled={preview.isPending}
        />
      </View>

      <View style={{ gap: spacing.sm }}>
        <Text variant="title">Enter your creator code</Text>
        <Text color="textMuted">
          A creator code lets you start a new community and become its organizer. Codes are issued
          by the TrainHive team.
        </Text>
      </View>

      {bannerError ? <Banner tone={bannerError.tone} message={bannerError.message} /> : null}

      <TextField
        label="Creator code"
        helper="Not the invitation code your organizer shares"
        placeholder="ABCD-EFGH"
        value={code}
        onChangeText={onChangeCode}
        error={fieldError}
        editable={!preview.isPending}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        autoFocus
        returnKeyType="go"
        onSubmitEditing={check}
        testID="creator-code-input"
      />

      {accepted ? (
        <>
          <Banner tone="success" message="This creator code is valid." />
          <Button
            label="Continue"
            size="lg"
            fullWidth
            onPress={() => navigation.goTo('createDetails')}
          />
        </>
      ) : (
        <Button label="Check code" size="lg" fullWidth loading={preview.isPending} onPress={check} />
      )}
    </KeyboardScreen>
  );
}
