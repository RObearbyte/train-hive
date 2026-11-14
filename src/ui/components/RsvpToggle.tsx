import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, type ColorToken, type IconName } from '../theme';
import { Icon } from './Icon';
import { Text } from './Text';

export type RsvpValue = 'going' | 'not_going' | 'no_response';
type RsvpChoice = Exclude<RsvpValue, 'no_response'>;

export interface RsvpToggleProps {
  value: RsvpValue;
  /** Tapping the selected option again reports `'no_response'`. */
  onChange: (value: RsvpValue) => void;
  disabled?: boolean;
  /** A change is being saved; taps are ignored and a spinner shows on the tapped option. */
  pending?: boolean;
  style?: StyleProp<ViewStyle>;
}

const options: readonly { value: RsvpChoice; label: string; icon: IconName }[] = [
  { value: 'going', label: "I'm going", icon: 'check' },
  { value: 'not_going', label: 'Not going', icon: 'close' },
];

export function RsvpToggle({ value, onChange, disabled = false, pending = false, style }: RsvpToggleProps) {
  const { colors, radii, spacing } = useTheme();
  const [lastTapped, setLastTapped] = useState<RsvpChoice | null>(null);
  const locked = disabled || pending;

  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel="Your attendance"
      style={[styles.row, { gap: spacing.md }, style]}
    >
      {options.map((option) => {
        const selected = value === option.value;
        const goingSelected = selected && option.value === 'going';
        const bg = goingSelected ? colors.primary : selected ? colors.textMuted : colors.surface;
        const fg: ColorToken = goingSelected ? 'onPrimary' : selected ? 'surface' : 'text';
        const showSpinner = pending && lastTapped === option.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityHint={selected ? 'Tap again to clear your answer' : undefined}
            accessibilityState={{ checked: selected, disabled: locked, busy: showSpinner }}
            onPress={
              locked
                ? undefined
                : () => {
                    setLastTapped(option.value);
                    onChange(selected ? 'no_response' : option.value);
                  }
            }
            style={({ pressed }) => [
              styles.option,
              {
                borderRadius: radii.lg,
                backgroundColor: bg,
                borderColor: selected ? bg : colors.borderStrong,
                opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
              },
            ]}
          >
            {showSpinner ? (
              <ActivityIndicator size="small" color={colors[fg]} />
            ) : (
              <Icon name={selected ? 'check-circle' : option.icon} size={22} color={fg} />
            )}
            <Text variant="heading" color={fg} style={styles.label}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignSelf: 'stretch' },
  option: {
    flex: 1,
    minHeight: 60,
    borderWidth: 2,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  label: { fontSize: 17 },
});
