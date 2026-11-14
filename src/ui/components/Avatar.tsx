import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, type ColorToken } from '../theme';
import { Text } from './Text';

export interface AvatarProps {
  name: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
}

const tints: readonly ColorToken[] = ['primarySoft', 'infoSoft', 'warningSoft', 'successSoft'];

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

function hash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

export function Avatar({ name, size = 40, style }: AvatarProps) {
  const { colors } = useTheme();
  const tint = tints[hash(name) % tints.length] ?? 'primarySoft';
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={name}
      style={[
        styles.base,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: colors[tint], borderColor: colors.border },
        style,
      ]}
    >
      <Text variant="label" style={{ fontSize: Math.round(size * 0.38), lineHeight: Math.round(size * 0.5) }}>
        {initialsOf(name)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
});
