import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HexMotif, Text, brand, useTheme } from '@/ui';

/**
 * Navy brand block with the hexagon motif. The same in light and dark themes,
 * so its colors come from the brand palette rather than the theme tokens
 * (Arctic White on Midnight Navy is 14.2:1).
 */
export function BrandHero() {
  const { spacing } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        flex: 1,
        minHeight: 260,
        backgroundColor: brand.midnightNavy,
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
      <Text variant="display" style={{ color: brand.arcticWhite }}>
        TrainHive
      </Text>
      <Text variant="heading" accessibilityRole="text" style={{ color: brand.warmSand }}>
        One Pack. Stronger together.
      </Text>
    </View>
  );
}
