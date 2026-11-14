import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, type ColorToken, type IconName } from '../theme';
import { Icon } from './Icon';

export interface IconButtonProps {
  icon: IconName;
  /** Required: an icon-only control must be described for screen readers. */
  accessibilityLabel: string;
  onPress?: () => void;
  variant?: 'plain' | 'filled';
  color?: ColorToken;
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  variant = 'plain',
  color,
  disabled = false,
  testID,
  style,
}: IconButtonProps) {
  const { colors, minTouchTarget } = useTheme();
  const filled = variant === 'filled';
  const fg: ColorToken = color ?? (filled ? 'onPrimary' : 'text');
  return (
    <Pressable
      testID={testID}
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      hitSlop={4}
      style={({ pressed }) => [
        styles.base,
        {
          width: minTouchTarget,
          height: minTouchTarget,
          borderRadius: minTouchTarget / 2,
          backgroundColor: filled ? colors.primary : pressed ? colors.primarySoft : 'transparent',
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      <Icon name={icon} size={22} color={fg} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
});
