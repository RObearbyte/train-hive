import { zodResolver } from '@hookform/resolvers/zod';
import type { UseMutationResult } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Controller,
  useForm,
  useWatch,
  type Control,
  type Resolver,
} from 'react-hook-form';
import { BackHandler, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';

import { ConfirmDialog } from '@/features/community/components/ConfirmDialog';
import type { EventKind, TrainingInput, TrainingSession } from '@/lib/database.types';
import { zoneCityName } from '@/lib/datetime';
import { userMessage, type AppError } from '@/lib/errors';
import { useNow } from '@/lib/useNow';
import {
  Banner,
  Button,
  Divider,
  Screen,
  Text,
  TextField,
  useTheme,
  type TextFieldProps,
} from '@/ui';

import { isTraining, kindInfo } from '../domain/events';
import {
  defaultDeadline,
  frozenFormFields,
  serverFieldError,
  visibleFormFields,
} from '../domain/formState';
import {
  emptyTrainingForm,
  fromSession,
  toTrainingInput,
  trainingFormSchema,
  type TrainingFormField,
  type TrainingFormValues,
} from '../domain/schema';
import { useSubtypeOptions } from '../hooks/useTrainings';
import { useCreateTraining, useUpdateTraining } from '../hooks/useTrainingMutations';
import { DateTimeField } from './DateTimeField';
import { KindChip } from './KindChip';
import { SubtypePicker } from './SubtypePicker';

const MORE_FIELDS: readonly TrainingFormField[] = [
  'description',
  'eventNotes',
  'meetingInstructions',
  'maxParticipants',
  'latitude',
  'longitude',
];

const FIELD_LABELS: Record<TrainingFormField, string> = {
  title: 'Title',
  description: 'Description',
  eventKind: 'Kind',
  eventSubtype: 'Type',
  date: 'Date',
  startTime: 'Start time',
  endTime: 'End time',
  deadlineDate: 'Deadline',
  deadlineTime: 'Deadline time',
  locationName: 'Location',
  address: 'Address',
  latitude: 'Latitude',
  longitude: 'Longitude',
  mapUrl: 'Map link',
  meetingInstructions: 'Meeting instructions',
  minParticipants: 'Minimum participants',
  maxParticipants: 'Maximum participants',
  distanceKm: 'Distance (km)',
  elevationGainM: 'Elevation gain, D+ (m)',
  obstacleCount: 'Number of obstacles',
  eventNotes: 'Event notes',
};

type SaveMutation = UseMutationResult<TrainingSession, AppError, TrainingInput>;

type FormTextFieldProps = Omit<TextFieldProps, 'label' | 'value' | 'onChangeText' | 'error' | 'ref'> & {
  control: Control<TrainingFormValues>;
  name: TrainingFormField;
  /** Set when the server will not accept a change to this field. */
  lockedReason?: string | null;
};

function FormTextField({ control, name, lockedReason, helper, editable, ...rest }: FormTextFieldProps) {
  const locked = lockedReason !== undefined && lockedReason !== null;
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <TextField
          {...rest}
          ref={field.ref}
          label={FIELD_LABELS[name]}
          value={field.value}
          onChangeText={field.onChange}
          onBlur={field.onBlur}
          error={fieldState.error?.message}
          helper={locked ? lockedReason : helper}
          editable={!locked && editable !== false}
        />
      )}
    />
  );
}

type TrainingFormViewProps = {
  heading: string;
  submitLabel: string;
  /** IANA zone the wall-clock fields are in. Must be valid. */
  timezone: string;
  defaultValues: TrainingFormValues;
  /** The session being edited; absent when creating. */
  session?: TrainingSession;
  mutation: SaveMutation;
  onSaved: (session: TrainingSession) => void;
  onClose: () => void;
};

function TrainingFormView({
  heading,
  submitLabel,
  timezone,
  defaultValues,
  session,
  mutation,
  onSaved,
  onClose,
}: TrainingFormViewProps) {
  const { colors, spacing } = useTheme();
  const now = useNow();

  // Client validation is advisory (early feedback); the server re-validates
  // everything with its own clock. The schema is rebuilt per run so "in the
  // future" is checked against the moment of validation.
  const resolver: Resolver<TrainingFormValues> = (values, context, options) =>
    zodResolver(
      trainingFormSchema(
        session
          ? { mode: 'edit', timezone, now: new Date(), session }
          : { mode: 'create', timezone, now: new Date() },
      ),
    )(values, context, options);

  const { control, handleSubmit, setError, setValue, formState } = useForm<TrainingFormValues>({
    defaultValues,
    resolver,
    mode: 'onBlur',
  });
  const { errors, isDirty, submitCount } = formState;

  const [date, startTime, eventKindValue, eventSubtype, deadlineDate, deadlineTime] = useWatch({
    control,
    name: ['date', 'startTime', 'eventKind', 'eventSubtype', 'deadlineDate', 'deadlineTime'],
  });
  // The kind is fixed when the form opens (picked in the create flow, locked on edit).
  const kind = eventKindValue as EventKind;
  const training = isTraining(kind);
  const subtypeChoices = useSubtypeOptions(kind, eventSubtype);
  const visible = visibleFormFields(kind, eventSubtype);
  const deadlineName = training ? 'RSVP deadline' : 'Registration closes';

  const [moreOpen, setMoreOpen] = useState(() =>
    MORE_FIELDS.some((field) => defaultValues[field] !== ''),
  );
  const [confirmLeave, setConfirmLeave] = useState(false);

  const frozen = session ? frozenFormFields(session, now) : null;
  const lockedReason = (field: TrainingFormField): string | null => {
    if (!frozen || !frozen.fields.has(field)) return null;
    if (frozen.timeReason !== null && (field === 'date' || field === 'startTime' || field === 'endTime')) {
      return frozen.timeReason;
    }
    return frozen.reason;
  };
  const dateLocked = lockedReason('date') !== null;
  const deadlineLocked = lockedReason('deadlineDate') !== null;

  const customDeadline = deadlineDate !== '' || deadlineTime !== '';
  const fallbackDeadline = defaultDeadline({ date, startTime }, timezone);
  const showMore = moreOpen || MORE_FIELDS.some((field) => errors[field] !== undefined);
  const invalidLabels = (Object.keys(errors) as TrainingFormField[]).map((field) =>
    field === 'deadlineDate' || field === 'deadlineTime' ? deadlineName : FIELD_LABELS[field],
  );

  const saving = mutation.isPending;
  const serverError = mutation.error;
  const serverErrorOnField =
    serverError !== null && serverFieldError(serverError, visible) !== null;

  // Android back button: ask before throwing away what was typed.
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

  const submit = handleSubmit((values) => {
    if (saving) return;
    mutation.mutate(toTrainingInput(values, timezone, session), {
      onSuccess: onSaved,
      onError: (error) => {
        const fieldError = serverFieldError(error, visible);
        if (fieldError) setError(fieldError.field, { type: 'server', message: fieldError.message });
      },
    });
  });

  const useCustomDeadline = () => {
    // Start from the default, so the organizer adjusts it instead of retyping it.
    setValue('deadlineDate', fallbackDeadline?.wall.date ?? date, { shouldDirty: true });
    setValue('deadlineTime', fallbackDeadline?.wall.time ?? '', { shouldDirty: true });
  };
  const useDefaultDeadline = () => {
    setValue('deadlineDate', '', { shouldDirty: true, shouldValidate: submitCount > 0 });
    setValue('deadlineTime', '', { shouldDirty: true, shouldValidate: submitCount > 0 });
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'web' ? undefined : 'padding'}
    >
      {/* iOS swipe-back would skip the unsaved-changes question. */}
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

          {session?.status === 'confirmed' && training ? (
            <Banner
              tone="info"
              message="This training is confirmed. You can still change its details and time, but not the RSVP deadline or the participant limits."
            />
          ) : null}
          {session?.status === 'confirmed' && !training && deadlineLocked ? (
            <Banner
              tone="info"
              message="Registration has closed. You can still change the details, the time and the maximum, but not the registration deadline."
            />
          ) : null}

          <View style={{ gap: spacing.xs }}>
            <KindChip kind={kind} />
            {session ? (
              <Text variant="caption" color="textMuted">
                The kind of an event cannot be changed after it is created. You can change its type
                below.
              </Text>
            ) : null}
          </View>

          <FormTextField
            control={control}
            name="title"
            placeholder={training ? 'Saturday long run' : 'Name of the event'}
            autoCapitalize="sentences"
            returnKeyType="next"
          />

          <Controller
            control={control}
            name="eventSubtype"
            render={({ field, fieldState }) => (
              <SubtypePicker
                label={FIELD_LABELS.eventSubtype}
                options={subtypeChoices}
                value={field.value}
                onChange={field.onChange}
                error={fieldState.error?.message}
              />
            )}
          />

          <Divider />
          <View style={{ gap: spacing.xs }}>
            <Text variant="heading">When</Text>
            <Text variant="caption" color="textMuted">
              Times are in {zoneCityName(timezone)} time ({timezone}).
            </Text>
          </View>
          <Controller
            control={control}
            name="date"
            render={({ field, fieldState }) => (
              <DateTimeField
                label={FIELD_LABELS.date}
                mode="date"
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                error={fieldState.error?.message}
                disabled={dateLocked}
                helper={lockedReason('date') ?? undefined}
              />
            )}
          />
          <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <Controller
                control={control}
                name="startTime"
                render={({ field, fieldState }) => (
                  <DateTimeField
                    label={FIELD_LABELS.startTime}
                    mode="time"
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    error={fieldState.error?.message}
                    disabled={dateLocked}
                  />
                )}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Controller
                control={control}
                name="endTime"
                render={({ field, fieldState }) => (
                  <DateTimeField
                    label={FIELD_LABELS.endTime}
                    mode="time"
                    optional
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    error={fieldState.error?.message}
                    helper={lockedReason('endTime') ?? 'Optional'}
                    disabled={lockedReason('endTime') !== null}
                    suggestion={startTime}
                  />
                )}
              />
            </View>
          </View>

          <Divider />
          <Text variant="heading">Where</Text>
          <FormTextField
            control={control}
            name="locationName"
            placeholder="Herastrau Park, north gate"
            helper="The place name members will see"
            autoCapitalize="sentences"
          />
          <FormTextField
            control={control}
            name="address"
            helper="Optional"
            autoCapitalize="words"
            autoComplete="street-address"
          />
          <FormTextField
            control={control}
            name="mapUrl"
            helper="Optional. Paste a share link from your maps app"
            placeholder="https://"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            inputMode="url"
          />

          {visible.has('distanceKm') ? (
            <>
              <Divider />
              <Text variant="heading">Course</Text>
              <FormTextField
                control={control}
                name="distanceKm"
                helper="Optional. Use a dot or a comma, up to 2 decimals"
                placeholder="21.1"
                keyboardType="decimal-pad"
                inputMode="decimal"
                autoCorrect={false}
              />
              <FormTextField
                control={control}
                name="elevationGainM"
                helper="Optional. Total climb in whole metres"
                placeholder="450"
                keyboardType="number-pad"
                inputMode="numeric"
                maxLength={5}
              />
              {visible.has('obstacleCount') ? (
                <FormTextField
                  control={control}
                  name="obstacleCount"
                  helper="Optional"
                  placeholder="12"
                  keyboardType="number-pad"
                  inputMode="numeric"
                  maxLength={3}
                />
              ) : null}
            </>
          ) : null}

          <Divider />
          <Text variant="heading">Participants</Text>
          {training ? (
            <FormTextField
              control={control}
              name="minParticipants"
              helper="The training is confirmed only if at least this many people are going when the RSVP deadline passes. Otherwise it is cancelled automatically."
              lockedReason={lockedReason('minParticipants')}
              placeholder="4"
              keyboardType="number-pad"
              inputMode="numeric"
              maxLength={9}
            />
          ) : (
            <Banner
              tone="info"
              message="No minimum: this event is confirmed as soon as you publish it. Registration closes at the deadline."
            />
          )}

          <View style={{ gap: spacing.sm }}>
            <Text variant="label">{deadlineName}</Text>
            {customDeadline || deadlineLocked ? (
              <>
                <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <Controller
                      control={control}
                      name="deadlineDate"
                      render={({ field, fieldState }) => (
                        <DateTimeField
                          label="Deadline date"
                          mode="date"
                          value={field.value}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          error={fieldState.error?.message}
                          disabled={deadlineLocked}
                          suggestion={date}
                        />
                      )}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Controller
                      control={control}
                      name="deadlineTime"
                      render={({ field, fieldState }) => (
                        <DateTimeField
                          label="Deadline time"
                          mode="time"
                          value={field.value}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          error={fieldState.error?.message}
                          disabled={deadlineLocked}
                        />
                      )}
                    />
                  </View>
                </View>
                {deadlineLocked ? (
                  <Text variant="caption" color="textMuted">
                    {lockedReason('deadlineDate')}
                  </Text>
                ) : (
                  <>
                    <Text variant="caption" color="textMuted">
                      {training
                        ? 'Members can answer until this time. It must be before the start.'
                        : 'Members can register until this time. It must be before the start.'}
                    </Text>
                    <View style={{ alignItems: 'flex-start' }}>
                      <Button
                        label="Use 2 hours before the start"
                        variant="ghost"
                        size="sm"
                        onPress={useDefaultDeadline}
                      />
                    </View>
                  </>
                )}
              </>
            ) : (
              <>
                <Text>
                  2 hours before the start
                  {fallbackDeadline ? `: ${fallbackDeadline.text}` : ''} (default).
                </Text>
                <Text variant="caption" color="textMuted">
                  {training
                    ? 'Members can answer until then. After that the training is confirmed or cancelled.'
                    : 'Members can register until then. After that registration is closed.'}
                </Text>
                {errors.deadlineDate?.message ? (
                  <Banner tone="error" message={errors.deadlineDate.message} />
                ) : null}
                <View style={{ alignItems: 'flex-start' }}>
                  <Button
                    label="Set a different deadline"
                    variant="secondary"
                    size="sm"
                    icon="clock"
                    onPress={useCustomDeadline}
                  />
                </View>
              </>
            )}
          </View>

          <Divider />
          <View style={{ alignItems: 'flex-start' }}>
            <Button
              label={showMore ? 'Hide more options' : 'More options'}
              accessibilityHint="Description, event notes, meeting instructions, maximum participants and coordinates"
              variant="ghost"
              size="sm"
              icon={showMore ? 'close' : 'plus'}
              onPress={() => setMoreOpen(!showMore)}
            />
          </View>
          {showMore ? (
            <>
              <FormTextField
                control={control}
                name="description"
                helper="Optional. What to expect, pace, what to bring"
                multiline
                autoCapitalize="sentences"
                style={{ minHeight: 96, textAlignVertical: 'top' }}
              />
              <FormTextField
                control={control}
                name="eventNotes"
                helper="Optional. Rules, kit list, parking, anything members should know"
                multiline
                autoCapitalize="sentences"
                style={{ minHeight: 72, textAlignVertical: 'top' }}
              />
              <FormTextField
                control={control}
                name="meetingInstructions"
                helper="Optional. Where exactly to meet"
                multiline
                autoCapitalize="sentences"
                style={{ minHeight: 72, textAlignVertical: 'top' }}
              />
              <FormTextField
                control={control}
                name="maxParticipants"
                helper="Optional. Leave empty for no limit"
                lockedReason={lockedReason('maxParticipants')}
                keyboardType="number-pad"
                inputMode="numeric"
                maxLength={9}
              />
              <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}>
                <FormTextField
                  control={control}
                  name="latitude"
                  helper="Optional"
                  placeholder="44.4268"
                  keyboardType="numbers-and-punctuation"
                  autoCorrect={false}
                  containerStyle={{ flex: 1 }}
                />
                <FormTextField
                  control={control}
                  name="longitude"
                  helper="Optional"
                  placeholder="26.1025"
                  keyboardType="numbers-and-punctuation"
                  autoCorrect={false}
                  containerStyle={{ flex: 1 }}
                />
              </View>
            </>
          ) : null}
        </ScrollView>

        <View
          style={{
            padding: spacing.lg,
            gap: spacing.md,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            backgroundColor: colors.background,
          }}
        >
          {serverError && !serverErrorOnField ? (
            <Banner
              tone="error"
              title="Not saved"
              message={userMessage(serverError.code, serverError.field)}
            />
          ) : null}
          {submitCount > 0 && invalidLabels.length > 0 ? (
            <Banner tone="warning" message={`Please check: ${invalidLabels.join(', ')}.`} />
          ) : null}
          <Button
            label={submitLabel}
            size="lg"
            fullWidth
            loading={saving}
            onPress={() => void submit()}
          />
        </View>
      </Screen>

      <ConfirmDialog
        visible={confirmLeave}
        title="Discard your changes?"
        message="What you entered has not been saved."
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

export interface CreateTrainingFormProps {
  communityId: string;
  /** The community's zone: new events are scheduled in it. Must be valid. */
  timezone: string;
  /** Chosen in the create flow before the form opens. */
  kind: EventKind;
  subtype: string;
  onSaved: (session: TrainingSession) => void;
  onClose: () => void;
}

export function CreateTrainingForm({
  communityId,
  timezone,
  kind,
  subtype,
  onSaved,
  onClose,
}: CreateTrainingFormProps) {
  const mutation = useCreateTraining(communityId);
  const [defaultValues] = useState(() => emptyTrainingForm(kind, subtype));
  const name = kindInfo(kind).label.toLowerCase();
  return (
    <TrainingFormView
      heading={`New ${name}`}
      submitLabel={`Create ${name}`}
      timezone={timezone}
      defaultValues={defaultValues}
      mutation={mutation}
      onSaved={onSaved}
      onClose={onClose}
    />
  );
}

export interface EditTrainingFormProps {
  /** The stored session. Its time zone must be valid. */
  session: TrainingSession;
  onSaved: (session: TrainingSession) => void;
  onClose: () => void;
}

export function EditTrainingForm({ session, onSaved, onClose }: EditTrainingFormProps) {
  const mutation = useUpdateTraining(session.id);
  // Prefilled once: a background refetch must not overwrite what is being typed.
  const [defaultValues] = useState(() => fromSession(session));
  return (
    <TrainingFormView
      heading={`Edit ${kindInfo(session.event_kind).label.toLowerCase()}`}
      submitLabel="Save changes"
      timezone={session.timezone}
      defaultValues={defaultValues}
      session={session}
      mutation={mutation}
      onSaved={onSaved}
      onClose={onClose}
    />
  );
}
