import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { userMessage } from '@/lib/errors';
import { Banner, Button, Text, TextField, useTheme } from '@/ui';

import {
  formatInvitationCode,
  isInvitationCodeProblem,
  isValidInvitationCodeFormat,
  normalizeInvitationCode,
  toInvitationCodeInput,
} from '../domain/invitationCode';
import type { AddCommunityFlow } from '../domain/flowRoutes';
import { peekPendingJoinCode, takePendingJoinCode } from '../domain/pendingJoin';
import { useFlowNavigation } from '../hooks/useFlowNavigation';
import { useOnboarding } from '../hooks/OnboardingProvider';
import { usePreviewInvitation } from '../hooks/useInvitationMutations';
import { KeyboardScreen } from './KeyboardScreen';

const FORMAT_HINT =
  'Codes have 8 characters, like ABCD-EFGH, and never contain 0, 1, I, L, O or U. Check for typos.';

/** Step 1 of joining a community: the invitation code. Shared by onboarding and "Join another community". */
export function InvitationCodeScreen({ flow }: { flow: AddCommunityFlow }) {
  const navigation = useFlowNavigation(flow);
  const { spacing } = useTheme();
  const { invitation, setInvitation } = useOnboarding();
  const preview = usePreviewInvitation();

  // A code that came in through a web join link (/join#code=...), kept in memory by `pendingJoin`.
  const [linkedCode] = useState(() => (invitation ? null : peekPendingJoinCode()));
  const [code, setCode] = useState(() =>
    invitation ? formatInvitationCode(invitation.code) : linkedCode ? formatInvitationCode(linkedCode) : '',
  );
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  // The accepted invitation still matches what is in the field.
  const accepted =
    invitation !== null && invitation.code === normalizeInvitationCode(code) ? invitation : null;

  const onChangeCode = (text: string) => {
    setCode(toInvitationCodeInput(text));
    setFieldError(undefined);
    if (preview.isError) preview.reset();
  };

  const runPreview = (submitted: string) => {
    preview.mutate(submitted, {
      onSuccess: (result) => setInvitation({ ...result, code: submitted }),
      onError: (error) => {
        if (isInvitationCodeProblem(error.code)) setFieldError(userMessage(error.code));
      },
    });
  };

  const check = () => {
    // Ignore a second tap while the first request is running.
    if (preview.isPending) return;
    if (!isValidInvitationCodeFormat(code)) {
      // Caught here so a typo does not use up one of the limited attempts.
      setFieldError(FORMAT_HINT);
      return;
    }
    runPreview(normalizeInvitationCode(code));
  };

  // A linked code is checked once, right away; the person only has to press Continue.
  const autoChecked = useRef(false);
  useEffect(() => {
    if (linkedCode === null || autoChecked.current) return;
    autoChecked.current = true;
    takePendingJoinCode();
    runPreview(linkedCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on arrival
  }, []);

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
          onPress={navigation.back}
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
          <Button label="Continue" size="lg" fullWidth onPress={() => navigation.goTo('joinName')} />
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
