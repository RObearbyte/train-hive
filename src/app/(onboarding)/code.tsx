import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { KeyboardScreen } from '@/features/onboarding/components/KeyboardScreen';
import {
  formatInvitationCode,
  isInvitationCodeProblem,
  isValidInvitationCodeFormat,
  normalizeInvitationCode,
  toInvitationCodeInput,
} from '@/features/onboarding/domain/invitationCode';
import { useOnboarding } from '@/features/onboarding/hooks/OnboardingProvider';
import { usePreviewInvitation } from '@/features/onboarding/hooks/useInvitationMutations';
import { userMessage } from '@/lib/errors';
import { Banner, Button, Text, TextField, useTheme } from '@/ui';

const FORMAT_HINT =
  'Codes have 8 characters, like ABCD-EFGH, and never contain 0, 1, I, L, O or U. Check for typos.';

export default function InvitationCodeScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { invitation, setInvitation } = useOnboarding();
  const preview = usePreviewInvitation();

  const [code, setCode] = useState(() => (invitation ? formatInvitationCode(invitation.code) : ''));
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  // The accepted invitation still matches what is in the field.
  const accepted =
    invitation !== null && invitation.code === normalizeInvitationCode(code) ? invitation : null;

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
      onSuccess: (result) => setInvitation({ ...result, code: submitted }),
      onError: (error) => {
        if (isInvitationCodeProblem(error.code)) setFieldError(userMessage(error.code));
      },
    });
  };

  const bannerError =
    preview.error && !isInvitationCodeProblem(preview.error.code) ? preview.error : null;

  return (
    <KeyboardScreen>
      <View style={{ alignItems: 'flex-start' }}>
        <Button
          label="Back"
          variant="ghost"
          size="sm"
          icon="chevron-left"
          onPress={() => router.back()}
          disabled={preview.isPending}
        />
      </View>

      <View style={{ gap: spacing.sm }}>
        <Text variant="title">Enter your invitation code</Text>
        <Text color="textMuted">Your organizer shares a code to let you into the community.</Text>
      </View>

      {bannerError ? (
        <Banner
          tone={bannerError.code === 'rate_limited' ? 'warning' : 'error'}
          message={userMessage(bannerError.code, bannerError.field)}
        />
      ) : null}
      {/* Development builds only: shows the underlying error so setup problems can be diagnosed. */}
      {__DEV__ && bannerError ? (
        <Text variant="caption" color="textMuted" selectable>
          {`Detail: ${bannerError.code}: ${bannerError.message}`}
        </Text>
      ) : null}

      <TextField
        label="Invitation code"
        helper="Ask your organizer"
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
        testID="invitation-code-input"
      />

      {accepted ? (
        <>
          <Banner
            tone="success"
            title={accepted.communityName}
            message={
              accepted.role === 'organizer'
                ? 'This code lets you join as an organizer.'
                : 'This code lets you join this community.'
            }
          />
          <Button label="Continue" size="lg" fullWidth onPress={() => router.push('/name')} />
        </>
      ) : (
        <Button
          label="Check code"
          size="lg"
          fullWidth
          loading={preview.isPending}
          onPress={check}
        />
      )}
    </KeyboardScreen>
  );
}
