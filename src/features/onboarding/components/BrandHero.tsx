import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HexMotif, Text, useTheme } from '@/ui';

/** Navy brand block with the hexagon motif; the same in light and dark themes (the `hero` color tokens). */
export function BrandHero() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        flex: 1,
        minHeight: 260,
        backgroundColor: colors.hero,
        justifyContent: 'flex-end',
        paddingTop: insets.top + spacing.xl,
        paddingBottom: spacing.xxl,
        paddingLeft: insets.left + spacing.xl,
        paddingRight: insets.right + spacing.xl,
        gap: spacing.sm,
        overflow: 'hidden',
      }}
    >
      <HexMotif color="accent" opacity={0.5} cell={26} />
      <Text variant="display" color="onHero">
        TrainHive
      </Text>
      <Text variant="heading" accessibilityRole="text" color="onHeroMuted">
        One Pack. Stronger together.
      </Text>
    </View>
  );
}
