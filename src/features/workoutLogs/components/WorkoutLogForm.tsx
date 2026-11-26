import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm, useWatch, type Control, type Resolver } from 'react-hook-form';
import { View } from 'react-native';

import { ConsentCheckbox } from '@/features/legal/components/ConsentCheckbox';
import type { WorkoutLog, WorkoutLogScreen, WorkoutLogType } from '@/lib/database.types';
import { Banner, Button, Card, Text, TextField, useTheme } from '@/ui';

import {
  NOTES_MAX,
  WORKOUT_CONSENT_LABEL,
  WORKOUT_CONSENT_TEXT,
  buildInput,
  createWorkoutSchema,
  formFieldFor,
  formValuesFrom,
  livePace,
  logSignature,
  serverFieldMessage,
  timePreview,
  workoutLogErrorMessage,
  type WorkoutFormValues,
} from '../domain/workoutLog';
import { useSaveWorkoutLog } from '../hooks/useWorkoutLogs';
import { StrengthEditor } from './StrengthEditor';

function NotesField({ control }: { control: Control<WorkoutFormValues> }) {
  return (
    <Controller
      control={control}
      name="notes"
      render={({ field, fieldState }) => (
        <TextField
          ref={field.ref}
          label="Notes (optional)"
          helper={`At most ${NOTES_MAX} characters.`}
          value={field.value}
          onChangeText={field.onChange}
          onBlur={field.onBlur}
          error={fieldState.error?.message}
          multiline
          numberOfLines={4}
          style={{ minHeight: 96, textAlignVertical: 'top' }}
          testID="workout-notes"
        />
      )}
    />
  );
}

function EnduranceFields({
  control,
  logType,
}: {
  control: Control<WorkoutFormValues>;
  logType: WorkoutLogType;
}) {
  const { spacing } = useTheme();
  const distanceKm = useWatch({ control, name: 'distanceKm' });
  const time = useWatch({ control, name: 'time' });
  const pace = livePace({ distanceKm, time });
  const timeText = timePreview(time);
  return (
    <View style={{ gap: spacing.md }}>
      <Controller
        control={control}
        name="distanceKm"
        render={({ field, fieldState }) => (
          <TextField
            ref={field.ref}
            label="Distance (km)"
            helper={logType === 'race' ? 'Filled in from the event; change it if you ran a different distance.' : 'For example 10 or 10.5'}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error?.message}
            keyboardType="decimal-pad"
            testID="workout-distance"
          />
        )}
      />
      <Controller
        control={control}
        name="time"
        render={({ field, fieldState }) => (
          <TextField
            ref={field.ref}
            label={logType === 'race' ? 'Finish time (h:mm:ss or m:ss)' : 'Time (h:mm:ss or m:ss)'}
            helper={timeText ? `Read as ${timeText}. 1:05:30 is 1 h 5 min, 25:10 is 25 min.` : '1:05:30 is 1 h 5 min, 25:10 is 25 min 10 s.'}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error?.message}
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
            testID="workout-time"
          />
        )}
      />
      <View accessible accessibilityLabel={pace ? `Pace: ${pace}` : 'Pace: enter distance and time'} accessibilityLiveRegion="polite">
        <Text variant="caption" color="textMuted">
          Pace
        </Text>
        <Text variant="heading">{pace ?? '—'}</Text>
      </View>
    </View>
  );
}

/**
 * The log form for the log type the server chose. Saving records the `workout_logs` agreement
 * first when it is not on record (the person ticks the box), then saves the whole log.
 */
export function WorkoutLogForm({
  screen,
  logType,
  onSaved,
}: {
  screen: WorkoutLogScreen;
  logType: WorkoutLogType;
  onSaved: (saved: WorkoutLog) => void;
}) {
  const { spacing } = useTheme();
  const save = useSaveWorkoutLog(screen.session_id);
  const schema = useMemo(() => createWorkoutSchema(logType), [logType]);
  const signature = logSignature(screen);
  const { control, handleSubmit, reset, setError } = useForm<WorkoutFormValues>({
    resolver: zodResolver(schema) as Resolver<WorkoutFormValues>,
    defaultValues: formValuesFrom(logType, screen.log, screen.event?.distance_km ?? null),
  });
  const [agree, setAgree] = useState(false);
  const [agreeError, setAgreeError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // Start again from the server's copy when it changes (after a save or a delete).
  useEffect(() => {
    reset(formValuesFrom(logType, screen.log, screen.event?.distance_km ?? null));
    // `screen` is covered by its signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, reset]);

  const needsConsent = !screen.has_consent;

  const submit = handleSubmit(onValid, (errors) => {
    // A problem with the list as a whole (nothing to save) has no field to sit under.
    const message = errors.exercises?.message ?? errors.exercises?.root?.message;
    if (message) setProblem(message);
  });

  function onValid(values: WorkoutFormValues) {
    if (save.isPending) return;
    setProblem(null);
    if (needsConsent && !agree) {
      setAgreeError('Tick the box to agree before saving.');
      return;
    }
    setAgreeError(null);
    save.mutate(
      { input: buildInput(logType, values), recordConsent: needsConsent },
      {
        onSuccess: (saved) => onSaved(saved),
        onError: (error) => {
          const field = error.code === 'validation_failed' ? formFieldFor(error.field, logType) : null;
          if (field === 'notes' || field === 'distanceKm' || field === 'time') {
            setError(field, { message: serverFieldMessage(error.field, workoutLogErrorMessage(error)) });
          } else {
            setProblem(workoutLogErrorMessage(error));
          }
        },
      },
    );
  }

  return (
    <View style={{ gap: spacing.lg }}>
      {problem ? <Banner tone="error" message={problem} /> : null}

      {logType === 'strength' ? <StrengthEditor control={control} /> : <EnduranceFields control={control} logType={logType} />}
      <NotesField control={control} />

      <Card style={{ gap: spacing.sm }}>
        <Text variant="heading">Your privacy</Text>
        <Text color="textMuted">{WORKOUT_CONSENT_TEXT}</Text>
        {needsConsent ? (
          <>
            <ConsentCheckbox
              testID="workout-consent"
              label={WORKOUT_CONSENT_LABEL}
              checked={agree}
              onChange={(checked) => {
                setAgree(checked);
                if (checked) setAgreeError(null);
              }}
            />
            {agreeError ? (
              <Text variant="caption" color="danger" accessibilityLiveRegion="polite">
                {agreeError}
              </Text>
            ) : null}
          </>
        ) : (
          <Text variant="caption" color="success">
            You agreed to this. You can turn it off in Profile, then Privacy.
          </Text>
        )}
      </Card>

      <Button
        label={screen.log ? 'Save changes' : 'Save workout log'}
        loading={save.isPending}
        fullWidth
        onPress={() => {
          void submit();
        }}
        testID="workout-save"
      />
    </View>
  );
}
