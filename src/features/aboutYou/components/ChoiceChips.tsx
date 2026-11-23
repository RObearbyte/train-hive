import { Pressable, View } from 'react-native';

import { Icon, Text, useTheme } from '@/ui';

export type ChoiceOption<T extends string> = { value: T; label: string };

/**
 * A small single-choice group (radio buttons shown as chips) for a field that
 * may also stay empty: tapping the chosen one again clears the choice. The
 * chosen chip carries a check mark as well as a colour.
 */
export function ChoiceChips<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  testID,
}: {
  label: string;
  options: readonly ChoiceOption<T>[];
  value: T | '';
  onChange: (value: T | '') => void;
  disabled?: boolean;
  testID?: string;
}) {
  const { colors, radii, spacing, minTouchTarget } = useTheme();
  return (
    <View style={{ gap: spacing.xs }} accessibilityRole="radiogroup" accessibilityLabel={label} testID={testID}>
      <Text variant="label">{label}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityHint={selected ? 'Selected. Tap again to clear' : undefined}
              accessibilityState={{ selected, checked: selected, disabled }}
              aria-checked={selected}
              disabled={disabled}
              onPress={() => onChange(selected ? '' : option.value)}
              style={({ pressed }) => ({
                minHeight: minTouchTarget,
                minWidth: minTouchTarget,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: spacing.xs,
                paddingHorizontal: spacing.md,
                borderRadius: radii.pill,
                borderWidth: selected ? 2 : 1,
                borderColor: selected ? colors.primary : colors.borderStrong,
                backgroundColor: selected ? colors.primarySoft : colors.surface,
                opacity: pressed || disabled ? 0.8 : 1,
              })}
            >
              {selected ? <Icon name="check" size={16} color="onPrimarySoft" /> : null}
              <Text variant="label" color={selected ? 'onPrimarySoft' : 'text'}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
