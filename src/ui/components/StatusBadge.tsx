import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { statusMeta, useTheme, type TrainingDisplayStatus } from '../theme';
import { Icon } from './Icon';
import { Text } from './Text';

export interface StatusBadgeProps {
  status: TrainingDisplayStatus;
  size?: 'sm' | 'md';
  /** Optional replacement for the default label, e.g. "3 more needed". */
  label?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Status is conveyed by glyph + text + fill style, never by color alone.
 * Provisional states are outlined (dashed for "minimum reached"); settled states are filled or tinted.
 */
export function StatusBadge({ status, size = 'md', label, style }: StatusBadgeProps) {
  const { status: statusColors, radii, spacing } = useTheme();
  const meta = statusMeta[status];
  const c = statusColors[status];
  const text = label ?? meta.label;

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Status: ${text}`}
      style={[
        styles.base,
        {
          backgroundColor: c.bg,
          borderColor: c.border,
          borderStyle: meta.dashed ? 'dashed' : 'solid',
          borderWidth: meta.visual === 'filled' ? 0 : 1.5,
          borderRadius: radii.pill,
          paddingHorizontal: size === 'sm' ? spacing.sm : spacing.md,
          paddingVertical: size === 'sm' ? spacing.xxs + 1 : spacing.xs + 1,
        },
        style,
      ]}
    >
      <Icon name={meta.icon} size={size === 'sm' ? 14 : 16} color={c.fg} />
      <Text variant={size === 'sm' ? 'caption' : 'label'} style={{ color: c.fg, fontWeight: '700' }}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6 },
});
