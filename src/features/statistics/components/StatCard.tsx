import { View, type StyleProp, type ViewStyle } from 'react-native';

import { Card, Text, useTheme } from '@/ui';

export type StatCardProps = {
  label: string;
  /** The headline number, already formatted (never raw null / NaN). */
  value: string;
  /** One line under the value, e.g. "7 of 9 events". */
  detail?: string | null;
  /** A second, quieter line, e.g. "based on 2 events". */
  note?: string | null;
  /** Explanation that reads as part of the card for screen readers. */
  help?: string | null;
  style?: StyleProp<ViewStyle>;
};

/** One headline number. The whole card is read as a single sentence. */
export function StatCard({ label, value, detail, note, help, style }: StatCardProps) {
  const { spacing } = useTheme();
  const spoken = [`${label}: ${value}`, detail, note, help].filter(Boolean).join('. ');
  return (
    <Card style={[{ gap: spacing.xs, flexGrow: 1, flexBasis: 150 }, style]}>
      <View accessible accessibilityLabel={spoken} style={{ gap: spacing.xs }}>
        <Text variant="caption" color="textMuted">
          {label}
        </Text>
        <Text variant="title">{value}</Text>
        {detail ? <Text variant="label">{detail}</Text> : null}
        {note ? (
          <Text variant="caption" color="textMuted">
            {note}
          </Text>
        ) : null}
        {help ? (
          <Text variant="caption" color="textMuted">
            {help}
          </Text>
        ) : null}
      </View>
    </Card>
  );
}

/** Cards side by side when they fit, stacked when they do not. */
export function StatGrid({ children }: { children: React.ReactNode }) {
  const { spacing } = useTheme();
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md }}>{children}</View>;
}
