import { zodResolver } from '@hookform/resolvers/zod';
import type { UseMutationResult } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Controller, useForm, useWatch, type Resolver } from 'react-hook-form';
import { BackHandler, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';

import { ConfirmDialog } from '@/features/community/components/ConfirmDialog';
import { DateTimeField } from '@/features/trainings/components/DateTimeField';
import type { Announcement } from '@/lib/database.types';
import { utcToWallTime } from '@/lib/datetime';
import { userMessage, type AppError } from '@/lib/errors';
import { readClock, useNow } from '@/lib/useNow';
import { Banner, Button, Screen, SegmentedControl, Text, TextField, useTheme } from '@/ui';

import type { AnnouncementPayload } from '../api/announcements';
import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_TITLE_MAX,
  announcementFieldForServerError,
  announcementFormSchema,
  emptyAnnouncementForm,
  fromAnnouncement,
  toAnnouncementInput,
  type AnnouncementFormValues,
  type PublishMode,
} from '../domain/announcementForm';
import { zoneHelper } from '../domain/presentation';
import { useCreateAnnouncement, useUpdateAnnouncement } from '../hooks/useActivityMutations';

type SaveMutation = UseMutationResult<Announcement, AppError, AnnouncementPayload>;

type ViewProps = {
  heading: string;
  /** Community IANA zone the date and time are in. Must be valid. */
  timezone: string;
  defaultValues: AnnouncementFormValues;
  mutation: SaveMutation;
  isEdit: boolean;
  onSaved: (announcement: Announcement) => void;
  onClose: () => void;
};

const MODE_OPTIONS = [
  { value: 'now' as const, label: 'Publish now' },
  { value: 'schedule' as const, label: 'Schedule for…', accessibilityLabel: 'Schedule for a later time' },
];

function AnnouncementFormView({
  heading,
  timezone,
  defaultValues,
  mutation,
  isEdit,
  onSaved,
  onClose,
}: ViewProps) {
  const { spacing } = useTheme();
  const now = useNow();

  // Advisory only: the server re-checks the publish time with its own clock.
  const resolver: Resolver<AnnouncementFormValues> = (values, context, options) =>
    zodResolver(announcementFormSchema({ timezone, now: readClock() }))(values, context, options);

  const { control, handleSubmit, setError, setValue, formState } = useForm<AnnouncementFormValues>({
    defaultValues,
    resolver,
    mode: 'onBlur',
  });
  const { isDirty, submitCount } = formState;
  const [mode, title, body, date] = useWatch({ control, name: ['mode', 'title', 'body', 'date'] });

  const [confirmPublish, setConfirmPublish] = useState<AnnouncementFormValues | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const saving = mutation.isPending;
  const serverError = mutation.error;
  const serverField =
    serverError?.code === 'validation_failed'
      ? announcementFieldForServerError(serverError.field)
      : null;

  useEffect(() => {
    if (!isDirty) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setConfirmLeave(true);
      return true;
    });
    return () => subscription.remove();
  }, [isDirty]);

  const leave = () => {
    if (saving) return;
    if (isDirty) setConfirmLeave(true);
    else onClose();
  };

  const save = (values: AnnouncementFormValues) => {
    if (saving) return;
    mutation.mutate(toAnnouncementInput(values, timezone), {
      onSuccess: (saved) => {
        setConfirmPublish(null);
        onSaved(saved);
      },
      onError: (error) => {
        setConfirmPublish(null);
        const field =
          error.code === 'validation_failed' ? announcementFieldForServerError(error.field) : null;
        if (field) {
          setError(field, { type: 'server', message: userMessage(error.code, error.field) });
        }
      },
    });
  };

  const submit = handleSubmit((values) => {
    // Publishing now notifies the whole community: ask first.
    if (values.mode === 'now') setConfirmPublish(values);
    else save(values);
  });

  const changeMode = (next: PublishMode) => {
    setValue('mode', next, { shouldDirty: true });
    if (next === 'schedule' && date === '') {
      setValue('date', utcToWallTime(now, timezone).date, { shouldDirty: true });
    }
  };

  const submitLabel = mode === 'now' ? 'Publish now' : isEdit ? 'Save schedule' : 'Schedule announcement';
  const invalidSummary = submitCount > 0 && Object.keys(formState.errors).length > 0;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'web' ? undefined : 'padding'}
    >
      <Stack.Screen options={{ gestureEnabled: !isDirty }} />
      <Screen padded={false}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ alignItems: 'flex-start' }}>
            <Button label="Back" variant="ghost" size="sm" icon="chevron-left" onPress={leave} />
          </View>
          <Text variant="title">{heading}</Text>

          <Controller
            control={control}
            name="title"
            render={({ field, fieldState }) => (
              <TextField
                ref={field.ref}
                label="Title"
                value={field.value}
                onChangeText={field.onChange}
                onBlur={field.onBlur}
                error={fieldState.error?.message}
                helper={`${Array.from(title).length} / ${ANNOUNCEMENT_TITLE_MAX}`}
                autoCapitalize="sentences"
                returnKeyType="next"
              />
            )}
          />
          <Controller
            control={control}
            name="body"
            render={({ field, fieldState }) => (
              <TextField
                ref={field.ref}
                label="Message"
                value={field.value}
                onChangeText={field.onChange}
                onBlur={field.onBlur}
                error={fieldState.error?.message}
                helper={`${Array.from(body).length} / ${ANNOUNCEMENT_BODY_MAX}`}
                multiline
                numberOfLines={6}
                textAlignVertical="top"
                autoCapitalize="sentences"
                style={{ minHeight: 140 }}
              />
            )}
          />

          <View style={{ gap: spacing.sm }}>
            <Text variant="label">When to publish</Text>
            <SegmentedControl
              accessibilityLabel="When to publish"
              options={MODE_OPTIONS}
              value={mode}
              onChange={changeMode}
            />
            {mode === 'now' ? (
              <Text variant="caption" color="textMuted">
                Everyone in the community is notified as soon as you publish.
              </Text>
            ) : (
              <>
                <Text variant="caption" color="textMuted">
                  {zoneHelper(timezone)} The server publishes it at that time, even if the app is
                  closed.
                </Text>
                <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <Controller
                      control={control}
                      name="date"
                      render={({ field, fieldState }) => (
                        <DateTimeField
                          label="Date"
                          mode="date"
                          value={field.value}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          error={fieldState.error?.message}
                          suggestion={utcToWallTime(now, timezone).date}
                        />
                      )}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Controller
                      control={control}
                      name="time"
                      render={({ field, fieldState }) => (
                        <DateTimeField
                          label="Time"
                          mode="time"
                          value={field.value}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          error={fieldState.error?.message}
                        />
                      )}
                    />
                  </View>
                </View>
              </>
            )}
          </View>

          {invalidSummary ? (
            <Banner tone="error" message="Some details need your attention. Check the fields above." />
          ) : null}
          {serverError && serverField === null ? (
            <Banner tone="error" message={userMessage(serverError.code, serverError.field)} />
          ) : null}

          <Button label={submitLabel} loading={saving} onPress={submit} fullWidth />
        </ScrollView>
      </Screen>

      <ConfirmDialog
        visible={confirmPublish !== null}
        title="Publish to everyone now?"
        message="Every member of the community gets a notification. You cannot unpublish it afterwards."
        confirmLabel="Publish now"
        cancelLabel="Not yet"
        pending={saving}
        error={serverError ? userMessage(serverError.code, serverError.field) : null}
        onConfirm={() => {
          if (confirmPublish) save(confirmPublish);
        }}
        onCancel={() => setConfirmPublish(null)}
      />
      <ConfirmDialog
        visible={confirmLeave}
        title="Discard your changes?"
        message="What you typed will be lost."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => {
          setConfirmLeave(false);
          onClose();
        }}
        onCancel={() => setConfirmLeave(false)}
      />
    </KeyboardAvoidingView>
  );
}

export function CreateAnnouncementForm(props: {
  communityId: string;
  timezone: string;
  onSaved: (announcement: Announcement) => void;
  onClose: () => void;
}) {
  const mutation = useCreateAnnouncement(props.communityId);
  return (
    <AnnouncementFormView
      heading="New announcement"
      timezone={props.timezone}
      defaultValues={emptyAnnouncementForm()}
      mutation={mutation}
      isEdit={false}
      onSaved={props.onSaved}
      onClose={props.onClose}
    />
  );
}

export function EditAnnouncementForm(props: {
  announcement: Announcement;
  timezone: string;
  onSaved: (announcement: Announcement) => void;
  onClose: () => void;
}) {
  const mutation = useUpdateAnnouncement(props.announcement.id);
  return (
    <AnnouncementFormView
      heading="Edit announcement"
      timezone={props.timezone}
      defaultValues={fromAnnouncement(props.announcement, props.timezone)}
      mutation={mutation}
      isEdit
      onSaved={props.onSaved}
      onClose={props.onClose}
    />
  );
}
