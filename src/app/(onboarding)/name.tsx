import { zodResolver } from '@hookform/resolvers/zod';
import { Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { View } from 'react-native';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { KeyboardScreen } from '@/features/onboarding/components/KeyboardScreen';
import {
  DISPLAY_NAME_MAX,
  displayNameFormSchema,
  type DisplayNameFormValues,
} from '@/features/onboarding/domain/displayName';
import { isInvitationCodeProblem } from '@/features/onboarding/domain/invitationCode';
import { useOnboarding } from '@/features/onboarding/hooks/OnboardingProvider';
import { useRedeemInvitation } from '@/features/onboarding/hooks/useInvitationMutations';
import { userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Banner, Button, Text, TextField, useTheme } from '@/ui';

export default function DisplayNameScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const onboarding = useOnboarding();
  // Snapshot from when the screen opened: clearing the shared invitation on the
  // way back to the code screen must not trigger the redirect below.
  const [invitation] = useState(onboarding.invitation);
  const redeem = useRedeemInvitation();
  const membership = useCurrentMembership();

  const { control, handleSubmit, setError } = useForm<DisplayNameFormValues>({
    resolver: zodResolver(displayNameFormSchema),
    defaultValues: { displayName: '' },
  });

  // Reached without an accepted code (for example a direct link on web).
  if (!invitation) return <Redirect href="/code" />;

  // Joined: the root gate moves into the app as soon as the membership loads.
  const joined = redeem.isSuccess;
  const busy = redeem.isPending || joined;

  const submit = handleSubmit(({ displayName }) => {
    // Ignore a second tap while joining.
    if (busy) return;
    redeem.mutate(
      { code: invitation.code, displayName },
      {
        onError: (error) => {
          if (error.code === 'invalid_display_name') {
            setError('displayName', { message: userMessage(error.code) });
          }
        },
      },
    );
  });

  const useAnotherCode = () => {
    onboarding.setInvitation(null);
    router.back();
  };

  const error = redeem.error && redeem.error.code !== 'invalid_display_name' ? redeem.error : null;

  return (
    <KeyboardScreen>
      <View style={{ alignItems: 'flex-start' }}>
        <Button
          label="Back"
          variant="ghost"
          size="sm"
          icon="chevron-left"
          onPress={() => router.back()}
          disabled={busy}
        />
      </View>

      <View style={{ gap: spacing.sm }}>
        <Text variant="title">Join {invitation.communityName}</Text>
        <Text color="textMuted">Pick the name your training partners will see.</Text>
      </View>

      {error ? (
        <Banner
          tone={error.code === 'rate_limited' ? 'warning' : 'error'}
          message={userMessage(error.code, error.field)}
          action={
            isInvitationCodeProblem(error.code)
              ? { label: 'Use another code', onPress: useAnotherCode }
              : undefined
          }
        />
      ) : null}

      {joined && membership.state === 'error' ? (
        <Banner
          tone="warning"
          title="You have joined"
          message="We could not load your community yet. Check your connection and try again."
          action={{
            label: 'Try again',
            onPress: () => {
              membership
                .refetch()
                .catch((refetchError: unknown) => reportError('onboarding.enter', refetchError));
            },
          }}
        />
      ) : null}

      <Controller
        control={control}
        name="displayName"
        render={({ field, fieldState }) => (
          <TextField
            ref={field.ref}
            label="What should your pack call you?"
            helper="Shown to your community"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error?.message}
            editable={!busy}
            autoCapitalize="words"
            autoCorrect={false}
            autoComplete="name"
            textContentType="name"
            maxLength={DISPLAY_NAME_MAX * 2}
            autoFocus
            returnKeyType="join"
            onSubmitEditing={() => void submit()}
            testID="display-name-input"
          />
        )}
      />

      <Button label="Join" size="lg" fullWidth loading={busy} onPress={() => void submit()} />

      <Banner
        tone="info"
        title="Your account lives on this device"
        message="There is no password or email yet. If you delete the app, clear its data or lose this phone, you will need a new invitation and your history will not follow you."
      />
    </KeyboardScreen>
  );
}
