import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { ReactNode } from 'react';

import { useTheme } from '../theme';
import { Icon } from './Icon';
import { Text } from './Text';

export interface ListItemProps {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  /** Shows a chevron when pressable. Defaults to true if `onPress` is set and no `trailing` is given. */
  showChevron?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function ListItem({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  showChevron,
  accessibilityLabel,
  testID,
  style,
}: ListItemProps) {
  const { colors, spacing, minTouchTarget } = useTheme();
  const chevron = showChevron ?? (onPress !== undefined && trailing === undefined);

  const content = (
    <>
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.body}>
        <Text variant="body" style={styles.title}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" color="textMuted">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
      {chevron ? <Icon name="chevron-right" size={20} color="textMuted" /> : null}
    </>
  );

  const base: ViewStyle = {
    minHeight: minTouchTarget + 12,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surface,
  };

  if (!onPress) {
    return (
      <View testID={testID} style={[styles.row, base, style]}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}, ${subtitle}` : title)}
      style={({ pressed }) => [styles.row, base, pressed ? { backgroundColor: colors.primarySoft } : null, style]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  leading: { alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, gap: 2 },
  title: { fontWeight: '600' },
});
