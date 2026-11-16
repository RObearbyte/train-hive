import { zodResolver } from '@hookform/resolvers/zod';
import { Redirect, type Href } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { View } from 'react-native';

import { SHARED_NAME_NOTE } from '@/features/communities/domain/communityForm';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Banner, Button, Text, TextField, useTheme } from '@/ui';

import {
  DISPLAY_NAME_MAX,
  displayNameFormSchema,
  displayNameSchema,
  type DisplayNameFormValues,
} from '../domain/displayName';
import type { AddCommunityFlow } from '../domain/flowRoutes';
import { isInvitationCodeProblem } from '../domain/invitationCode';
import { useOnboarding } from '../hooks/OnboardingProvider';
import { useFlowNavigation } from '../hooks/useFlowNavigation';
import { useRedeemInvitation } from '../hooks/useInvitationMutations';
import { KeyboardScreen } from './KeyboardScreen';

/**
 * Step 2 of joining: the display name. Someone adding a community from the
 * app already has a name (it is global, shared by all their communities), so
 * they only confirm it and may change it.
 */
export function JoinNameScreen({ flow }: { flow: AddCommunityFlow }) {
  const navigation = useFlowNavigation(flow);
  const { spacing } = useTheme();
  const onboarding = useOnboarding();
  // Snapshot from when the screen opened: clearing the shared invitation on the
  // way back to the code screen must not trigger the redirect below.
  const [invitation] = useState(onboarding.invitation);
  const redeem = useRedeemInvitation();
  const membership = useCurrentMembership();

  const existingName = flow === 'signedIn' ? (membership.profile?.display_name ?? '') : '';
  const hasName = displayNameSchema.safeParse(existingName).success;
  const [changing, setChanging] = useState(false);
  const confirmOnly = hasName && !changing;

  const { control, handleSubmit, setError } = useForm<DisplayNameFormValues>({
    resolver: zodResolver(displayNameFormSchema),
    defaultValues: { displayName: existingName },
  });

  // Reached without an accepted code (for example a direct link on web).
  if (!invitation) return <Redirect href={navigation.routes.joinCode as Href} />;

  // Joined: in onboarding the root gate moves into the app as soon as the membership loads.
  const joined = redeem.isSuccess;
  const busy = redeem.isPending || joined;

  const join = (displayName: string) => {
    // Ignore a second tap while joining.
    if (busy) return;
    redeem.mutate(
      { code: invitation.code, displayName },
      {
        onSuccess: () => {
          onboarding.setInvitation(null);
          navigation.exitToApp();
        },
        onError: (error) => {
          if (error.code === 'invalid_display_name') {
            setChanging(true);
            setError('displayName', { message: userMessage(error.code) });
          }
        },
      },
    );
  };

  const submit = handleSubmit(({ displayName }) => join(displayName));

  const chooseAnotherCode = () => {
    onboarding.setInvitation(null);
    navigation.back();
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
          onPress={navigation.back}
          disabled={busy}
        />
      </View>

      <View style={{ gap: spacing.sm }}>
        <Text variant="title">Join {invitation.communityName}</Text>
        <Text color="textMuted">
          {confirmOnly
            ? 'You will join with the name you already use.'
            : 'Pick the name your training partners will see.'}
        </Text>
      </View>

      {error ? (
        <Banner
          tone={error.code === 'rate_limited' ? 'warning' : 'error'}
          message={userMessage(error.code, error.field)}
          action={
            isInvitationCodeProblem(error.code)
              ? { label: 'Use another code', onPress: chooseAnotherCode }
              : undefined
          }
        />
      ) : null}

      {flow === 'onboarding' && joined && membership.state === 'error' ? (
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

      {confirmOnly ? (
        <>
          <Banner tone="info" title={existingName} message={SHARED_NAME_NOTE} />
          <Button
            label={`Join as ${existingName}`}
            size="lg"
            fullWidth
            loading={busy}
            onPress={() => join(existingName)}
          />
          <Button
            label="Use a different name"
            variant="ghost"
            fullWidth
            disabled={busy}
            onPress={() => setChanging(true)}
          />
        </>
      ) : (
        <>
          <Controller
            control={control}
            name="displayName"
            render={({ field, fieldState }) => (
              <TextField
                ref={field.ref}
                label="What should your pack call you?"
                helper={flow === 'signedIn' ? SHARED_NAME_NOTE : 'Shown to your community'}
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
        </>
      )}

      {flow === 'signedIn' ? (
        <Button
          label="Cancel"
          variant="ghost"
          fullWidth
          disabled={busy}
          onPress={navigation.exitToApp}
        />
      ) : (
        <Banner
          tone="info"
          title="Your account lives on this device"
          message="There is no password or email yet. If you delete the app, clear its data or lose this phone, you will need a new invitation and your history will not follow you."
        />
      )}
    </KeyboardScreen>
  );
}
