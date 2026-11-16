import type { ReactNode } from 'react';
import { View } from 'react-native';

import { useTheme } from '@/ui';

/**
 * Centres its child in a column of at most `maxWidth` (full width when null).
 * The scrollbar of a scrolling screen sits at the edge of the column.
 */
export function ContentColumn({
  maxWidth,
  children,
}: {
  maxWidth: number | null;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  if (maxWidth === null) return <>{children}</>;
  return (
    <View style={{ flex: 1, alignItems: 'center', backgroundColor: colors.background }}>
      <View style={{ flex: 1, width: '100%', maxWidth }}>{children}</View>
    </View>
  );
}
