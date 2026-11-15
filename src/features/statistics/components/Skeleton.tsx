import { View } from 'react-native';

import { useTheme } from '@/ui';

function Block({ height, width }: { height: number; width?: number | `${number}%` }) {
  const { colors, radii } = useTheme();
  return (
    <View
      style={{ height, width: width ?? '100%', borderRadius: radii.sm, backgroundColor: colors.border }}
    />
  );
}

/** Placeholder shapes of the stat cards while the numbers load. Announced as one loading state. */
export function StatsSkeleton({ label = 'Loading statistics' }: { label?: string }) {
  const { colors, radii, spacing } = useTheme();
  const card = (key: string) => (
    <View
      key={key}
      style={{
        flexGrow: 1,
        flexBasis: 150,
        gap: spacing.sm,
        padding: spacing.lg,
        borderRadius: radii.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surfaceRaised,
      }}
    >
      <Block height={12} width="50%" />
      <Block height={26} width="40%" />
      <Block height={12} width="70%" />
    </View>
  );
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      style={{ gap: spacing.md }}
    >
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md }}>
        {['a', 'b', 'c', 'd'].map(card)}
      </View>
      <View
        style={{
          height: 160,
          borderRadius: radii.lg,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surfaceRaised,
        }}
      />
    </View>
  );
}
