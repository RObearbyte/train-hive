import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';
import { Text } from './Text';

export interface ProgressBarProps {
  /** Current count, e.g. confirmed participants. */
  value: number;
  /** Bar capacity (maximum participants, or the minimum when there is no maximum). */
  target: number;
  /** Threshold marked on the bar, e.g. the minimum participants needed. */
  minimum?: number;
  /** Word for the counted thing, used in the text and the screen reader label. */
  unit?: string;
  showText?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function ProgressBar({ value, target, minimum, unit = 'confirmed', showText = true, style }: ProgressBarProps) {
  const { colors, radii } = useTheme();
  const safeTarget = Math.max(target, 1);
  const pct = Math.min(Math.max(value / safeTarget, 0), 1) * 100;
  const markerPct = minimum === undefined ? undefined : Math.min(Math.max(minimum / safeTarget, 0), 1) * 100;
  const reachedMinimum = minimum !== undefined && value >= minimum;

  const summary = `${value} of ${target} ${unit}`;
  const label = minimum === undefined ? summary : `${summary}. Minimum ${minimum}${reachedMinimum ? ', reached' : ', not reached'}`;

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: target, now: Math.min(value, target) }}
      style={style}
    >
      {showText ? (
        <View style={styles.textRow}>
          <Text variant="label">
            {value} / {target} {unit}
          </Text>
          {minimum !== undefined ? (
            <Text variant="caption" color="textMuted">
              Min {minimum}
            </Text>
          ) : null}
        </View>
      ) : null}
      <View style={styles.trackWrap}>
        <View style={[styles.track, { backgroundColor: colors.border, borderRadius: radii.pill }]}>
          <View
            style={[
              styles.fill,
              {
                width: `${pct}%`,
                backgroundColor: reachedMinimum || minimum === undefined ? colors.primary : colors.info,
                borderRadius: radii.pill,
              },
            ]}
          />
        </View>
        {markerPct !== undefined ? (
          <View
            style={[
              styles.marker,
              { left: `${markerPct}%`, backgroundColor: colors.text, borderColor: colors.surface },
            ]}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  textRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 },
  trackWrap: { height: 16, justifyContent: 'center' },
  track: { height: 10, overflow: 'hidden' },
  fill: { height: '100%' },
  marker: { position: 'absolute', width: 4, height: 16, marginLeft: -2, borderRadius: 2, borderWidth: 1 },
});
