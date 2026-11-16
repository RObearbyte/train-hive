import { zodResolver } from '@hookform/resolvers/zod';
import { Redirect, useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { View } from 'react-native';

import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';
import { KeyboardScreen } from '@/features/onboarding/components/KeyboardScreen';
import type { Community } from '@/lib/database.types';
import { userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';
import { Banner, Button, ErrorState, LoadingState, Screen, Text, TextField, useTheme } from '@/ui';

import {
  COMMUNITY_NAME_MAX,
  TIMEZONE_CHANGE_NOTE,
  communitySettingsFormSchema,
  type CommunitySettingsFormInput,
  type CommunitySettingsFormValues,
} from '../domain/communityForm';
import { mapCreatorError } from '../domain/creatorErrors';
import { useUpdateCommunity } from '../hooks/useCommunityMutations';
import { TimeZoneField } from './TimeZoneField';

function goBack(router: ReturnType<typeof useRouter>) {
  if (router.canGoBack()) router.back();
  else router.replace('/profile' as Href);
}

/** Organizers edit the community's name and time zone here. The server checks the role again. */
export function CommunitySettingsScreen() {
  const router = useRouter();
  const current = useCurrentMembership();
  const { community, isOrganizer } = current;

  // Organizers only; members never see the entry and the server refuses them anyway.
  if (community && !isOrganizer) return <Redirect href={'/profile' as Href} />;

  if (!community) {
    return (
      <Screen>
        <View style={{ alignItems: 'flex-start' }}>
          <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={() => goBack(router)} />
        </View>
        {current.error ? (
          <ErrorState
            message={userMessage(current.error.code, current.error.field)}
            onRetry={() => {
              current.refetch().catch((error: unknown) => reportError('communitySettings.retry', error));
            }}
            style={{ flex: 1 }}
          />
        ) : (
          <LoadingState message="Loading your community" style={{ flex: 1 }} />
        )}
      </Screen>
    );
  }

  // Keyed by community so a switch never edits one community with another's values.
  return <SettingsForm key={community.id} community={community} />;
}

function SettingsForm({ community }: { community: Community }) {
  const router = useRouter();
  const { spacing } = useTheme();
  const update = useUpdateCommunity(community.id);
  const [saved, setSaved] = useState(false);

  const { control, handleSubmit, setError } = useForm<
    CommunitySettingsFormInput,
    unknown,
    CommunitySettingsFormValues
  >({
    resolver: zodResolver(communitySettingsFormSchema),
    defaultValues: { name: community.name, timezone: community.timezone },
  });

  const busy = update.isPending;

  const submit = handleSubmit((values) => {
    if (busy) return;
    if (values.name === community.name && values.timezone === community.timezone) {
      goBack(router);
      return;
    }
    setSaved(false);
    update.mutate(values, {
      onSuccess: () => setSaved(true),
      onError: (error) => {
        const view = mapCreatorError(error);
        if (view.target === 'name' || view.target === 'timezone') {
          setError(view.target, { message: view.message });
        }
      },
    });
  });

  const view = update.error ? mapCreatorError(update.error) : null;
  const banner = view && view.target === 'banner' ? view : null;

  return (
    <KeyboardScreen>
      <View style={{ alignItems: 'flex-start' }}>
        <Button
          label="Back"
          variant="ghost"
          size="sm"
          icon="chevron-left"
          onPress={() => goBack(router)}
          disabled={busy}
        />
      </View>
      <Text variant="title">Community settings</Text>

      {banner ? <Banner tone={banner.tone} message={banner.message} /> : null}
      {saved && !update.isPending && !update.isError ? (
        <Banner tone="success" message="Saved." />
      ) : null}

      <Controller
        control={control}
        name="name"
        render={({ field, fieldState }) => (
          <TextField
            ref={field.ref}
            label="Community name"
            value={field.value}
            onChangeText={(text) => {
              setSaved(false);
              field.onChange(text);
            }}
            onBlur={field.onBlur}
            error={fieldState.error?.message}
            editable={!busy}
            autoCapitalize="words"
            autoCorrect={false}
            maxLength={COMMUNITY_NAME_MAX * 2}
            returnKeyType="done"
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
            onChange={(zone) => {
              setSaved(false);
              field.onChange(zone);
            }}
            error={fieldState.error?.message}
            disabled={busy}
            note={TIMEZONE_CHANGE_NOTE}
          />
        )}
      />

      <View style={{ gap: spacing.sm }}>
        <Button label="Save" size="lg" fullWidth loading={busy} onPress={() => void submit()} />
        <Button label="Done" variant="ghost" fullWidth disabled={busy} onPress={() => goBack(router)} />
      </View>
    </KeyboardScreen>
  );
}
