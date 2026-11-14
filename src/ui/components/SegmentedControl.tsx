import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';
import { Text } from './Text';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  accessibilityLabel?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
  style,
}: SegmentedControlProps<T>) {
  const { colors, radii, minTouchTarget } = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      style={[styles.row, { backgroundColor: colors.border, borderRadius: radii.md }, style]}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={[
              styles.segment,
              {
                minHeight: minTouchTarget,
                borderRadius: radii.md - 2,
                backgroundColor: selected ? colors.surfaceRaised : 'transparent',
                borderColor: selected ? colors.borderStrong : 'transparent',
              },
            ]}
          >
            <Text variant="label" color={selected ? 'text' : 'textMuted'} style={selected ? styles.selectedText : null}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', padding: 3, gap: 3 },
  segment: { flex: 1, alignItems: 'center', justifyContent: 'center', borderWidth: 1, paddingHorizontal: 8 },
  selectedText: { fontWeight: '800' },
});
