import { zodResolver } from '@hookform/resolvers/zod';
import { Redirect, type Href } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { View } from 'react-native';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { KeyboardScreen } from '@/features/onboarding/components/KeyboardScreen';
import { DISPLAY_NAME_MAX } from '@/features/onboarding/domain/displayName';
import type { AddCommunityFlow } from '@/features/onboarding/domain/flowRoutes';
import { useOnboarding } from '@/features/onboarding/hooks/OnboardingProvider';
import { useFlowNavigation } from '@/features/onboarding/hooks/useFlowNavigation';
import { Banner, Button, Text, TextField, useTheme } from '@/ui';

import {
  COMMUNITY_NAME_MAX,
  SHARED_NAME_NOTE,
  createCommunityFormSchema,
  type CreateCommunityFormInput,
  type CreateCommunityFormValues,
} from '../domain/communityForm';
import { mapCreatorError } from '../domain/creatorErrors';
import { defaultTimeZone } from '../domain/timezones';
import { useCreateCommunity } from '../hooks/useCommunityMutations';
import { TimeZoneField } from './TimeZoneField';

/**
 * Creator flow, screen 2: name, time zone and display name, then
 * `create_community_with_code`. One request id per submission, reused when
 * the same form is submitted again after a failure (so a retry after a lost
 * answer cannot create a second community); editing the form gives a new id.
 */
export function CreateCommunityScreen({ flow }: { flow: AddCommunityFlow }) {
  const navigation = useFlowNavigation(flow);
  const { spacing } = useTheme();
  const onboarding = useOnboarding();
  // Snapshot from when the screen opened: clearing the shared code after success must not redirect.
  const [code] = useState(onboarding.creatorCode);
  const create = useCreateCommunity();
  const { profile } = useCurrentMembership();

  const existingName = flow === 'signedIn' ? (profile?.display_name ?? '') : '';
  const [initialZone] = useState(() => defaultTimeZone());

  const { control, handleSubmit, setError } = useForm<
    CreateCommunityFormInput,
    unknown,
    CreateCommunityFormValues
  >({
    resolver: zodResolver(createCommunityFormSchema),
    defaultValues: { name: '', timezone: initialZone, displayName: existingName },
  });

  // Reached without an accepted code (for example a direct link on web).
  if (!code) return <Redirect href={navigation.routes.createCode as Href} />;

  const busy = create.isPending || create.isSuccess;

  const submit = handleSubmit((values) => {
    // Ignore a second tap while creating.
    if (busy) return;
    const requestId = onboarding.requestIds.idFor({ code, ...values });
    create.mutate(
      { code, ...values, requestId },
      {
        onSuccess: () => {
          onboarding.requestIds.reset();
          onboarding.setCreatorCode(null);
          navigation.exitToApp();
        },
        onError: (error) => {
          const view = mapCreatorError(error);
          if (view.target === 'name' || view.target === 'timezone' || view.target === 'displayName') {
            setError(view.target, { message: view.message });
          }
        },
      },
    );
  });

  const chooseAnotherCode = () => {
    onboarding.setCreatorCode(null);
    navigation.back();
  };

  const view = create.error ? mapCreatorError(create.error) : null;
  const banner = view && (view.target === 'banner' || view.target === 'code') ? view : null;
  const isNetwork = create.error?.code === 'network_error';

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
        <Text variant="title">Create your community</Text>
        <Text color="textMuted">You will be its organizer and can invite members afterwards.</Text>
      </View>

      {banner ? (
        <Banner
          tone={banner.tone}
          message={
            isNetwork
              ? `${banner.message} Tap Create community again to retry: it will not create a duplicate.`
              : banner.message
          }
          action={banner.codeProblem ? { label: 'Use another code', onPress: chooseAnotherCode } : undefined}
        />
      ) : null}

      <Controller
        control={control}
        name="name"
        render={({ field, fieldState }) => (
          <TextField
            ref={field.ref}
            label="Community name"
            helper="For example the name of your club or group"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error?.message}
            editable={!busy}
            autoCapitalize="words"
            autoCorrect={false}
            maxLength={COMMUNITY_NAME_MAX * 2}
            autoFocus
            returnKeyType="next"
            testID="community-name-input"
          />
        )}
      />

      <Controller
        control={control}
        name="timezone"
        render={({ field, fieldState }) => (
          <TimeZoneField
            value={field.value}
            onChange={field.onChange}
            error={fieldState.error?.message}
            disabled={busy}
            note="Trainings are shown in this time zone. Pick where your community trains."
          />
        )}
      />

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
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
            testID="display-name-input"
          />
        )}
      />

      <Button
        label="Create community"
        size="lg"
        fullWidth
        loading={busy}
        onPress={() => void submit()}
      />
      {flow === 'signedIn' ? (
        <Button label="Cancel" variant="ghost" fullWidth disabled={busy} onPress={navigation.exitToApp} />
      ) : null}
    </KeyboardScreen>
  );
}
