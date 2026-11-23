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
import { baselineFrom, hasSettingsChanges, resolveConflict } from '../domain/settingsBaseline';
import { useFetchLatestCommunity, useUpdateCommunity } from '../hooks/useCommunityMutations';
import { TimeZoneField } from './TimeZoneField';

function goBack(router: ReturnType<typeof useRouter>) {
  if (router.canGoBack()) router.back();
  else router.replace('/community' as Href);
}

/** Organizers edit the community's name and time zone here. The server checks the role again. */
export function CommunitySettingsScreen() {
  const router = useRouter();
  const current = useCurrentMembership();
  const { community, isOrganizer } = current;

  // Organizers only; members never see the entry and the server refuses them anyway.
  if (community && !isOrganizer) return <Redirect href={'/community' as Href} />;

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
  const fetchLatest = useFetchLatestCommunity(community.id);
  const [saved, setSaved] = useState(false);
  // The row the form was loaded from; its updated_at is sent with every save.
  const [baseline, setBaseline] = useState(() => baselineFrom(community));
  // Set after a stale_data answer: the latest saved values, shown next to what the user typed.
  const [latest, setLatest] = useState<Community | null>(null);

  const { control, handleSubmit, setError, reset, getValues } = useForm<
    CommunitySettingsFormInput,
    unknown,
    CommunitySettingsFormValues
  >({
    resolver: zodResolver(communitySettingsFormSchema),
    defaultValues: { name: baseline.name, timezone: baseline.timezone },
  });

  const busy = update.isPending;

  const submit = handleSubmit((values) => {
    if (busy) return;
    if (!hasSettingsChanges(values, baseline)) {
      goBack(router);
      return;
    }
    setSaved(false);
    setLatest(null);
    update.mutate(
      { ...values, expectedUpdatedAt: baseline.updatedAt },
      {
        onSuccess: (row) => {
          // The returned row is the new baseline.
          setBaseline(baselineFrom(row));
          setSaved(true);
        },
        onError: (error) => {
          if (error.code === 'stale_data') {
            // Keep the typed values; move the baseline to the latest row so the next save is deliberate.
            fetchLatest.mutate(undefined, {
              onSuccess: (row) => {
                setLatest(row);
                setBaseline(resolveConflict(row, getValues()).baseline);
              },
            });
            return;
          }
          const view = mapCreatorError(error);
          if (view.target === 'name' || view.target === 'timezone') {
            setError(view.target, { message: view.message });
          }
        },
      },
    );
  });

  const loadLatest = () => {
    if (!latest) return;
    reset({ name: latest.name, timezone: latest.timezone });
    setBaseline(baselineFrom(latest));
    setLatest(null);
    update.reset();
  };

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
      {latest ? (
        <View style={{ gap: spacing.sm }}>
          <Text variant="body">
            {`Latest saved: "${latest.name}", ${latest.timezone}. You typed: "${getValues('name')}", ${getValues('timezone')}.`}
          </Text>
          <Button label="Load latest" variant="secondary" onPress={loadLatest} disabled={busy} />
        </View>
      ) : null}
      {update.error?.code === 'stale_data' && !latest && fetchLatest.isPending ? (
        <Banner tone="warning" message="Loading the latest values." />
      ) : null}
      {update.error?.code === 'stale_data' && fetchLatest.isError ? (
        <Banner tone="error" message={userMessage(fetchLatest.error.code, fetchLatest.error.field)} />
      ) : null}
      {saved && !update.isPending && !update.isError ? <Banner tone="success" message="Saved." /> : null}

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
