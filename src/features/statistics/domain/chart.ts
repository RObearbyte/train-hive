/**
 * Scale and bar geometry for the lightweight bar charts. Pure: the component
 * multiplies the ratios by its pixel height.
 *
 * A bar's value is `number | null`. `null` means "no data for this bucket"
 * (shown as an empty slot with a dash) and is different from 0 (a real zero).
 */
export type ChartValue = number | null;

export type Bar = {
  index: number;
  value: ChartValue;
  /** Height as a share of the plot, 0 to 1. */
  ratio: number;
  /** No data: draw no bar, label it with a dash. */
  empty: boolean;
};

export type ChartScale = {
  /** Value at the top of the plot (always > 0). */
  max: number;
  /** Grid / axis values from the bottom to the top. */
  ticks: number[];
};

function finite(value: ChartValue | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** Smallest "round" number >= value: 3.2 -> 4, 7 -> 8, 11 -> 15. 0, negative or NaN -> 1. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  for (const step of NICE_STEPS) {
    if (step * base >= value - 1e-9) return Number((step * base).toPrecision(12));
  }
  return base * 10;
}

/** Rates are percentages: always 0 to 100, so bars of different periods are comparable. */
export function rateScale(): ChartScale {
  return { max: 100, ticks: [0, 50, 100] };
}

/** Counts and averages: from 0 up to a round number above the largest value. */
export function countScale(values: readonly ChartValue[]): ChartScale {
  let highest = 0;
  for (const value of values) if (finite(value) && value > highest) highest = value;
  const max = niceMax(highest);
  return { max, ticks: [0, max / 2, max] };
}

/** One bar per value; ratios are clamped to 0..1. */
export function barsFor(values: readonly ChartValue[], scale: ChartScale): Bar[] {
  return values.map((value, index) => {
    if (!finite(value)) return { index, value: null, ratio: 0, empty: true };
    const ratio = Math.min(1, Math.max(0, value / scale.max));
    return { index, value, ratio, empty: false };
  });
}

/** Pixel height of a bar: 0 stays 0, anything above 0 stays visible. */
export function barHeight(ratio: number, plotHeight: number, minVisible = 3): number {
  if (!Number.isFinite(ratio) || ratio <= 0 || plotHeight <= 0) return 0;
  return Math.min(plotHeight, Math.max(minVisible, Math.round(ratio * plotHeight)));
}

/**
 * Width of one column. Columns share the available width up to `max`; when
 * `min` per column would not fit, `min` is used and the chart scrolls.
 */
export function columnWidth(count: number, available: number, min = 48, max = 120): number {
  if (count <= 0 || !Number.isFinite(available) || available <= 0) return min;
  return Math.max(min, Math.min(max, Math.floor(available / count)));
}

/** True when the columns do not fit the available width. */
export function needsScroll(count: number, available: number, min = 48): boolean {
  return count * min > available;
}

/** Which of `count` axis labels to show so they do not collide (every Nth, always the first). */
export function visibleLabelIndexes(count: number, maxLabels: number): Set<number> {
  const shown = new Set<number>();
  if (count <= 0 || maxLabels <= 0) return shown;
  const step = Math.ceil(count / maxLabels);
  for (let i = 0; i < count; i += step) shown.add(i);
  return shown;
}
