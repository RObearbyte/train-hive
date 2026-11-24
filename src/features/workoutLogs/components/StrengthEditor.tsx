import { useState } from 'react';
import { Controller, useFieldArray, useFormState, useWatch, type Control } from 'react-hook-form';
import { Pressable, View } from 'react-native';

import { ConfirmDialog } from '@/features/community/components/ConfirmDialog';
import { Button, Card, Icon, IconButton, Text, TextField, useTheme } from '@/ui';

import {
  DEFAULT_SET_COUNT,
  exerciseHasEntries,
  exerciseTitle,
  newExercise,
  parseSetCount,
  setCountText,
  setFieldLabel,
  toggleOpen,
  validateNewExercise,
  type NewExerciseProblems,
} from '../domain/strengthEditor';
import { EXERCISE_NAME_MAX, MAX_EXERCISES, MAX_SETS, type WorkoutFormValues } from '../domain/workoutLog';

/**
 * Strength part of the log form: add an exercise with a name and a number of sets, then edit every set
 * inside a collapsible row. The state is the form's own `exercises` array (validation and the request
 * are unchanged); only the open / closed state of the rows lives here.
 */
export function StrengthEditor({ control }: { control: Control<WorkoutFormValues> }) {
  const { spacing } = useTheme();
  const { fields, append, remove } = useFieldArray({ control, name: 'exercises' });
  const { errors } = useFormState({ control, name: 'exercises' });
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [name, setName] = useState('');
  const [setsText, setSetsText] = useState(String(DEFAULT_SET_COUNT));
  const [problems, setProblems] = useState<NewExerciseProblems>({});
  const [removing, setRemoving] = useState<number | null>(null);
  const [expectCount, setExpectCount] = useState<number | null>(null);

  // A new exercise starts expanded (adjusted while rendering, once the list has grown).
  if (expectCount !== null && fields.length >= expectCount) {
    setExpectCount(null);
    const id = fields[fields.length - 1].id;
    setOpen((current) => new Set(current).add(id));
  }

  // Rows with a problem after a failed save stay open so the field can be seen.
  const errorRows = errors.exercises;
  const hasProblem = (index: number) => Array.isArray(errorRows) && errorRows[index] !== undefined;

  function add() {
    const found = validateNewExercise(name, setsText, fields.length);
    setProblems(found);
    const count = parseSetCount(setsText);
    if (Object.keys(found).length > 0 || count === null) return;
    setExpectCount(fields.length + 1);
    append(newExercise(name, count));
    setName('');
  }

  const removeIndex = removing;
  return (
    <View style={{ gap: spacing.md }}>
      <Card style={{ gap: spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
          <TextField
            label="Exercise name"
            value={name}
            onChangeText={(text) => {
              setName(text);
              if (problems.name || problems.limit) setProblems({ ...problems, name: undefined, limit: undefined });
            }}
            error={problems.name}
            maxLength={EXERCISE_NAME_MAX * 2}
            returnKeyType="done"
            onSubmitEditing={add}
            containerStyle={{ flex: 3 }}
            testID="workout-new-name"
          />
          <TextField
            label="Sets"
            value={setsText}
            onChangeText={(text) => {
              setSetsText(text);
              if (problems.sets) setProblems({ ...problems, sets: undefined });
            }}
            error={problems.sets}
            keyboardType="number-pad"
            maxLength={2}
            containerStyle={{ flex: 1 }}
            testID="workout-new-sets"
          />
        </View>
        {problems.limit ? (
          <Text variant="caption" color="danger" accessibilityLiveRegion="polite">
            {problems.limit}
          </Text>
        ) : (
          <Text variant="caption" color="textMuted">
            {`1 to ${MAX_SETS} sets, up to ${MAX_EXERCISES} exercises. You fill in each set after adding.`}
          </Text>
        )}
        <Button
          label="Add"
          icon="plus"
          variant="secondary"
          disabled={fields.length >= MAX_EXERCISES}
          onPress={add}
          testID="workout-add-exercise"
        />
      </Card>

      {fields.map((field, index) => (
        <ExerciseRow
          key={field.id}
          control={control}
          index={index}
          expanded={open.has(field.id) || hasProblem(index)}
          onToggle={() => setOpen((current) => toggleOpen(current, field.id))}
          onRemove={(hasEntries) => {
            if (hasEntries) setRemoving(index);
            else remove(index);
          }}
        />
      ))}

      <ConfirmDialog
        visible={removeIndex !== null}
        title="Remove this exercise?"
        message="The exercise and all its sets are removed from this log. Nothing is saved until you save the log."
        confirmLabel="Remove exercise"
        cancelLabel="Keep it"
        destructive
        onConfirm={() => {
          if (removeIndex !== null) remove(removeIndex);
          setRemoving(null);
        }}
        onCancel={() => setRemoving(null)}
      />
    </View>
  );
}

function ExerciseRow({
  control,
  index,
  expanded,
  onToggle,
  onRemove,
}: {
  control: Control<WorkoutFormValues>;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onRemove: (hasEntries: boolean) => void;
}) {
  const { spacing, colors, minTouchTarget } = useTheme();
  const name = useWatch({ control, name: `exercises.${index}.name` });
  const sets = useWatch({ control, name: `exercises.${index}.sets` });
  const title = exerciseTitle(name);
  const count = sets?.length ?? 0;
  return (
    <Card style={{ gap: spacing.md }}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${title}, ${setCountText(count)}, ${expanded ? 'expanded' : 'collapsed'}`}
        accessibilityHint={expanded ? 'Collapses the exercise' : 'Expands the exercise'}
        style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: minTouchTarget }}
        testID={`workout-exercise-${index}`}
      >
        <View style={{ flex: 1 }}>
          <Text variant="heading" numberOfLines={1}>
            {title}
          </Text>
          <Text variant="caption" color="textMuted">
            {setCountText(count)}
          </Text>
        </View>
        <View style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }], backgroundColor: colors.surface }}>
          <Icon name="chevron-right" size={22} color="textMuted" />
        </View>
      </Pressable>
      {expanded ? <ExerciseBody control={control} index={index} name={name} onRemove={onRemove} /> : null}
    </Card>
  );
}

function ExerciseBody({
  control,
  index,
  name,
  onRemove,
}: {
  control: Control<WorkoutFormValues>;
  index: number;
  name: string | undefined;
  onRemove: (hasEntries: boolean) => void;
}) {
  const { spacing } = useTheme();
  const { fields, append, remove } = useFieldArray({ control, name: `exercises.${index}.sets` });
  const sets = useWatch({ control, name: `exercises.${index}.sets` });
  return (
    <View style={{ gap: spacing.md }}>
      <Controller
        control={control}
        name={`exercises.${index}.name`}
        render={({ field, fieldState }) => (
          <TextField
            ref={field.ref}
            label={`Exercise ${index + 1} name`}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error?.message}
            maxLength={EXERCISE_NAME_MAX * 2}
          />
        )}
      />
      {fields.map((set, setIndex) => {
        const prefix = setFieldLabel(index, name, setIndex);
        return (
          <View key={set.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
            <View style={{ width: 52, paddingTop: spacing.xl }}>
              <Text color="textMuted" accessibilityElementsHidden importantForAccessibility="no">
                {`Set ${setIndex + 1}`}
              </Text>
            </View>
            <Controller
              control={control}
              name={`exercises.${index}.sets.${setIndex}.reps`}
              render={({ field, fieldState }) => (
                <TextField
                  ref={field.ref}
                  label="Reps"
                  accessibilityLabel={`${prefix} reps`}
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={fieldState.error?.message}
                  keyboardType="number-pad"
                  containerStyle={{ flex: 1 }}
                />
              )}
            />
            <Controller
              control={control}
              name={`exercises.${index}.sets.${setIndex}.weight`}
              render={({ field, fieldState }) => (
                <TextField
                  ref={field.ref}
                  label="Weight (kg)"
                  accessibilityLabel={`${prefix} weight (kg)`}
                  helper="Empty = bodyweight"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={fieldState.error?.message}
                  keyboardType="decimal-pad"
                  containerStyle={{ flex: 1 }}
                />
              )}
            />
            <View style={{ paddingTop: spacing.xl }}>
              <IconButton
                icon="close"
                accessibilityLabel={`Remove set ${setIndex + 1} of exercise ${index + 1}`}
                disabled={fields.length <= 1}
                onPress={() => remove(setIndex)}
              />
            </View>
          </View>
        );
      })}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        <Button
          label="Add set"
          variant="ghost"
          size="sm"
          icon="plus"
          disabled={fields.length >= MAX_SETS}
          onPress={() => append({ reps: '', weight: '' })}
        />
        <Button
          label="Remove exercise"
          variant="ghost"
          size="sm"
          icon="trash"
          accessibilityLabel={`Remove exercise ${index + 1}`}
          onPress={() => onRemove(sets ? exerciseHasEntries({ name: name ?? '', sets }) : false)}
        />
      </View>
    </View>
  );
}

