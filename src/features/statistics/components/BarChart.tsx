import { useState } from 'react';
import { ScrollView, View, type LayoutChangeEvent } from 'react-native';

import { Text, useTheme } from '@/ui';

import {
  barHeight,
  barsFor,
  columnWidth,
  needsScroll,
  visibleLabelIndexes,
  type ChartScale,
  type ChartValue,
} from '../domain/chart';
import { DASH } from '../domain/format';

export type BarChartProps = {
  values: readonly ChartValue[];
  /** Short axis label under each bar ("Oct", "Oct 12"). */
  axisLabels: readonly string[];
  /** Label above each bar ("67%", "4"); use the dash for no data. */
  valueLabels: readonly string[];
  /** Optional second line under the axis label ("2 of 3", "1 session"). */
  captions?: readonly (string | null)[];
  scale: ChartScale;
  /** Formats the left axis ticks. */
  formatTick: (value: number) => string;
  /** What a screen reader says for the whole chart. */
  accessibilitySummary: string;
  plotHeight?: number;
};

const AXIS_WIDTH = 44;
const VALUE_LABEL_SPACE = 22;
const MIN_COLUMN = 52;

/**
 * A plain View-based bar chart: text scales with the system font size, colors
 * come from the theme, and the whole chart is one accessible image with a
 * spoken summary. Empty buckets (no data) show a dash and no bar; real zeros
 * show "0" and no bar height.
 */
export function BarChart({
  values,
  axisLabels,
  valueLabels,
  captions,
  scale,
  formatTick,
  accessibilitySummary,
  plotHeight = 120,
}: BarChartProps) {
  const { colors, spacing, radii } = useTheme();
  const [width, setWidth] = useState(0);
  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);

  const count = values.length;
  const bars = barsFor(values, scale);
  const available = Math.max(0, width - AXIS_WIDTH);
  const colWidth = columnWidth(count, available, MIN_COLUMN);
  const scrolls = needsScroll(count, available, MIN_COLUMN);
  const labelled = visibleLabelIndexes(count, Math.max(1, Math.floor(available / MIN_COLUMN)));
  const barWidth = Math.min(36, Math.max(12, Math.round(colWidth * 0.5)));
  const areaHeight = plotHeight + VALUE_LABEL_SPACE;

  const columns = (
    <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <View style={{ flexDirection: 'row', height: areaHeight, alignItems: 'flex-end' }}>
        {bars.map((bar) => (
          <View
            key={bar.index}
            style={{ width: colWidth, height: areaHeight, justifyContent: 'flex-end', alignItems: 'center' }}
          >
            <Text variant="caption" color={bar.empty ? 'textMuted' : 'text'} style={{ fontWeight: '700' }}>
              {valueLabels[bar.index] ?? DASH}
            </Text>
            <View
              style={{
                width: barWidth,
                height: barHeight(bar.ratio, plotHeight),
                backgroundColor: colors.primary,
                borderTopLeftRadius: radii.sm,
                borderTopRightRadius: radii.sm,
              }}
            />
          </View>
        ))}
        {/* Baseline */}
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: 1,
            backgroundColor: colors.borderStrong,
          }}
        />
      </View>
      <View style={{ flexDirection: 'row', paddingTop: spacing.xs }}>
        {bars.map((bar) => (
          <View key={bar.index} style={{ width: colWidth, alignItems: 'center', minHeight: 36 }}>
            {labelled.has(bar.index) ? (
              <Text variant="caption" color="textMuted" align="center" numberOfLines={2}>
                {axisLabels[bar.index] ?? ''}
              </Text>
            ) : null}
            {captions?.[bar.index] ? (
              <Text variant="caption" color="textMuted" align="center" numberOfLines={2}>
                {captions[bar.index]}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilitySummary}
      onLayout={onLayout}
      style={{ flexDirection: 'row' }}
    >
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ width: AXIS_WIDTH, height: areaHeight }}>
        {scale.ticks.map((tick) => (
          <Text
            key={tick}
            variant="caption"
            color="textMuted"
            style={{
              position: 'absolute',
              right: spacing.xs,
              bottom: Math.round((tick / scale.max) * plotHeight) - 9,
            }}
          >
            {formatTick(tick)}
          </Text>
        ))}
      </View>
      <ScrollView horizontal scrollEnabled={scrolls} showsHorizontalScrollIndicator={scrolls} style={{ flex: 1 }}>
        {columns}
      </ScrollView>
    </View>
  );
}
