import { Pressable, View } from 'react-native';

import { Icon, Text, useTheme } from '@/ui';

export interface ConsentCheckboxProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  testID?: string;
}

/**
 * A labelled checkbox for consent. The state is shown by a check mark and a
 * heavier border, not by colour alone, and is announced as "checked / not
 * checked". Never pre-ticked by its callers.
 */
export function ConsentCheckbox({ label, checked, onChange, disabled = false, testID }: ConsentCheckboxProps) {
  const { colors, radii, spacing, minTouchTarget } = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      // react-native-web reads the aria-* props; native reads accessibilityState above.
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: minTouchTarget,
        paddingVertical: spacing.xs,
        opacity: pressed || disabled ? 0.8 : 1,
      })}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          width: 28,
          height: 28,
          borderRadius: radii.sm,
          borderWidth: 2,
          borderColor: checked ? colors.primary : colors.borderStrong,
          backgroundColor: checked ? colors.primary : colors.surface,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked ? <Icon name="check" size={20} color="onPrimary" /> : null}
      </View>
      <Text style={{ flex: 1 }}>{label}</Text>
    </Pressable>
  );
}
