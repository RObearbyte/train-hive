import { useMemo, useState, type ComponentRef, type Ref } from 'react';
import { Pressable, SectionList, TextInput, View } from 'react-native';

import { ResponsiveModal } from '@/features/shell/components/ResponsiveModal';
import { Button, Icon, ListItem, Screen, Text, TextField, useTheme } from '@/ui';

import {
  RECORDS_HINT,
  RECORDS_HINT_SPOKEN,
  choiceLabel,
  exerciseChoice,
  searchCatalog,
  validateOtherName,
  type CatalogEntry,
} from '../domain/exerciseCatalog';
import { EXERCISE_NAME_MAX, cleanLine } from '../domain/workoutLog';

/** The small "Records" mark next to the six record lifts (the spoken label says it in words). */
export function RecordsHint() {
  const { colors, radii, spacing } = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        backgroundColor: colors.primarySoft,
        borderRadius: radii.pill,
        paddingHorizontal: spacing.sm,
        paddingVertical: 2,
      }}
    >
      <Icon name="trophy" size={14} color="onPrimarySoft" />
      <Text variant="caption" color="onPrimarySoft">
        {RECORDS_HINT}
      </Text>
    </View>
  );
}

export type ExerciseNameFieldProps = {
  label: string;
  value: string;
  onChange: (name: string) => void;
  onBlur?: () => void;
  error?: string;
  /** The text input of "Other" (React Hook Form focuses it on an error). */
  inputRef?: Ref<ComponentRef<typeof TextInput>>;
  /** Done on the keyboard of the "Other" input. */
  onSubmitEditing?: () => void;
  testID?: string;
};

/**
 * Exercise name chosen from the predefined list (searchable, grouped), or "Other" with a name of
 * one's own typed below. The value is the name itself: list names are stored exactly as listed,
 * so the six record lifts reach the server with the spelling it expects.
 */
export function ExerciseNameField({
  label,
  value,
  onChange,
  onBlur,
  error,
  inputRef,
  onSubmitEditing,
  testID,
}: ExerciseNameFieldProps) {
  const { colors, radii, spacing, minTouchTarget } = useTheme();
  // A stored name that is not in the list starts as "Other".
  const [otherChosen, setOtherChosen] = useState(() => exerciseChoice(value).kind === 'other');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const choice = exerciseChoice(value, otherChosen);
  const sections = useMemo(
    () => searchCatalog(query).map((section) => ({ title: section.group, data: section.entries })),
    [query],
  );
  const typed = cleanLine(query);
  const typedUsable = typed !== '' && validateOtherName(typed) === null;
  const selected = choice.kind === 'catalog' ? choice.entry.name : null;

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const pick = (entry: CatalogEntry) => {
    setOtherChosen(false);
    onChange(entry.name);
    onBlur?.();
    close();
  };
  const pickOther = () => {
    setOtherChosen(true);
    if (typedUsable) onChange(typed);
    else if (choice.kind !== 'other') onChange('');
    close();
  };

  const shown = choiceLabel(choice);
  const record = choice.kind === 'catalog' && choice.entry.record;
  const spoken = `${label}: ${choice.kind === 'none' ? 'not chosen' : shown}${record ? `, ${RECORDS_HINT_SPOKEN}` : ''}`;

  return (
    <View style={{ gap: spacing.xs }}>
      <Text variant="label">{label}</Text>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={spoken}
        accessibilityHint="Opens the list of exercises"
        testID={testID}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          minHeight: minTouchTarget + 6,
          borderRadius: radii.md,
          borderWidth: error && choice.kind !== 'other' ? 2 : 1,
          borderColor: error && choice.kind !== 'other' ? colors.danger : colors.borderStrong,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          backgroundColor: pressed ? colors.primarySoft : colors.surface,
        })}
      >
        <Text color={choice.kind === 'none' ? 'textMuted' : 'text'} numberOfLines={1} style={{ flexShrink: 1 }}>
          {shown}
        </Text>
        {record ? <RecordsHint /> : null}
        <View style={{ flex: 1 }} />
        <Icon name="chevron-right" size={20} color="textMuted" />
      </Pressable>
      {error && choice.kind !== 'other' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }} accessibilityLiveRegion="polite">
          <Icon name="alert" size={16} color="danger" />
          <Text variant="caption" color="danger" style={{ flex: 1 }}>
            {error}
          </Text>
        </View>
      ) : null}

      {choice.kind === 'other' ? (
        <TextField
          ref={inputRef}
          label="Your exercise name"
          accessibilityLabel={`${label}, your own name`}
          value={value}
          onChangeText={onChange}
          onBlur={onBlur}
          error={error}
          maxLength={EXERCISE_NAME_MAX * 2}
          returnKeyType="done"
          onSubmitEditing={onSubmitEditing}
          testID={testID ? `${testID}-other` : undefined}
        />
      ) : null}

      <ResponsiveModal visible={open} onClose={close} variant="page" safeArea={false}>
        <Screen>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text variant="title">Exercise</Text>
            <Button label="Close" variant="ghost" size="sm" onPress={close} />
          </View>
          <TextField
            label="Search"
            placeholder="For example squat or press"
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            returnKeyType="search"
            testID="exercise-search"
          />
          <Text variant="caption" color="textMuted">
            Lifts marked Records can count for your personal bests.
          </Text>
          <SectionList
            sections={sections}
            keyExtractor={(entry) => entry.name}
            keyboardShouldPersistTaps="handled"
            stickySectionHeadersEnabled={false}
            initialNumToRender={20}
            style={{ flex: 1 }}
            renderSectionHeader={({ section }) => (
              <Text
                variant="label"
                color="textMuted"
                accessibilityRole="header"
                style={{ paddingTop: spacing.md, paddingBottom: spacing.xs }}
              >
                {section.title}
              </Text>
            )}
            renderItem={({ item }) => {
              const isSelected = item.name === selected;
              return (
                <ListItem
                  title={item.name}
                  trailing={
                    item.record || isSelected ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                        {item.record ? <RecordsHint /> : null}
                        {isSelected ? <Icon name="check" size={20} color="primary" /> : null}
                      </View>
                    ) : undefined
                  }
                  showChevron={false}
                  accessibilityLabel={`${item.name}${item.record ? `, ${RECORDS_HINT_SPOKEN}` : ''}${isSelected ? ', selected' : ''}`}
                  onPress={() => pick(item)}
                />
              );
            }}
            ListEmptyComponent={
              <Text color="textMuted" style={{ paddingVertical: spacing.md }}>
                No exercise in the list matches. Use Other below to type your own name.
              </Text>
            }
            ListFooterComponent={
              <View style={{ paddingTop: spacing.md }}>
                <Text variant="label" color="textMuted" accessibilityRole="header" style={{ paddingBottom: spacing.xs }}>
                  Not in the list
                </Text>
                <ListItem
                  title={typedUsable ? `Other: ${typed}` : 'Other'}
                  subtitle={typedUsable ? 'Use this as your own exercise name' : 'Type your own exercise name'}
                  trailing={choice.kind === 'other' ? <Icon name="check" size={20} color="primary" /> : undefined}
                  showChevron={false}
                  accessibilityLabel={`${typedUsable ? `Other: ${typed}` : 'Other, type your own exercise name'}${choice.kind === 'other' ? ', selected' : ''}`}
                  onPress={pickOther}
                  testID="exercise-other"
                />
              </View>
            }
          />
        </Screen>
      </ResponsiveModal>
    </View>
  );
}
