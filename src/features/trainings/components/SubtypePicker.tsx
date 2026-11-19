import { Pressable, View } from 'react-native';

import { Icon, Text, useTheme } from '@/ui';

import type { SubtypeOption } from '../domain/events';

export interface SubtypePickerProps {
  label: string;
  options: readonly SubtypeOption[];
  value: string;
  onChange: (key: string) => void;
  error?: string;
  disabled?: boolean;
}

/** Single choice from a short list, as wrapping chips. The selected chip has a check, not only a tint. */
export function SubtypePicker({
  label,
  options,
  value,
  onChange,
  error,
  disabled = false,
}: SubtypePickerProps) {
  const { colors, radii, spacing, minTouchTarget } = useTheme();

  return (
    <View style={{ alignSelf: 'stretch', gap: spacing.xs }}>
      <Text variant="label">{label}</Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={label}
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}
      >
        {options.map((option) => {
          const selected = option.key === value;
          return (
            <Pressable
              key={option.key}
              onPress={disabled ? undefined : () => onChange(option.key)}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityState={{ selected, disabled }}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.xs,
                minHeight: minTouchTarget,
                paddingHorizontal: spacing.md,
                borderRadius: radii.pill,
                borderWidth: selected ? 2 : 1,
                borderColor: selected ? colors.primary : colors.borderStrong,
                backgroundColor: selected || pressed ? colors.primarySoft : colors.surface,
                opacity: disabled ? 0.45 : 1,
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
      {error ? (
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}
          accessibilityLiveRegion="polite"
        >
          <Icon name="alert" size={16} color="danger" />
          <Text variant="caption" color="danger" style={{ flex: 1 }}>
            {error}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
