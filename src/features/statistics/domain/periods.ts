/**
 * Labels for the chart buckets. The server already assigned every bucket in
 * the community's time zone and names it by its local month ('YYYY-MM') or
 * local Monday ('YYYY-MM-DD'), so the label comes from that name alone: the
 * device's time zone can never move a bucket into another month.
 */
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export type ParsedPeriod = { year: number; month: number; day: number | null };

/** Parses 'YYYY-MM' or 'YYYY-MM-DD'; null when it is neither (or the month / day is out of range). */
export function parsePeriod(period: string): ParsedPeriod | null {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(period);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = match[3] === undefined ? null : Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day !== null && (day < 1 || day > 31)) return null;
  return { year, month, day };
}

/** "Oct" ("Oct '26" when `withYear`). Unknown input is returned unchanged. */
export function monthShort(period: string, withYear = false): string {
  const parsed = parsePeriod(period);
  if (!parsed) return period;
  const name = MONTHS_SHORT[parsed.month - 1];
  return withYear ? `${name} '${String(parsed.year).slice(-2)}` : name;
}

/** "October 2026". */
export function monthLong(period: string): string {
  const parsed = parsePeriod(period);
  if (!parsed) return period;
  return `${MONTHS_LONG[parsed.month - 1]} ${parsed.year}`;
}

/** "Oct 12" for the week starting that Monday ("Oct 12 '26" when `withYear`). */
export function weekShort(period: string, withYear = false): string {
  const parsed = parsePeriod(period);
  if (!parsed || parsed.day === null) return period;
  const base = `${MONTHS_SHORT[parsed.month - 1]} ${parsed.day}`;
  return withYear ? `${base} '${String(parsed.year).slice(-2)}` : base;
}

/** "week of 12 October 2026". */
export function weekLong(period: string): string {
  const parsed = parsePeriod(period);
  if (!parsed || parsed.day === null) return period;
  return `week of ${parsed.day} ${MONTHS_LONG[parsed.month - 1]} ${parsed.year}`;
}

export type PeriodUnit = 'week' | 'month';

/**
 * Axis labels for a whole series. The year is added where it helps: on the
 * first label and whenever the year changes.
 */
export function axisLabels(periods: readonly string[], unit: PeriodUnit): string[] {
  let previousYear: number | null = null;
  return periods.map((period) => {
    const parsed = parsePeriod(period);
    const showYear = parsed !== null && (previousYear === null || parsed.year !== previousYear);
    if (parsed) previousYear = parsed.year;
    return unit === 'month' ? monthShort(period, showYear) : weekShort(period, showYear);
  });
}

/** Spoken label of one bucket. */
export function periodSpoken(period: string, unit: PeriodUnit): string {
  return unit === 'month' ? monthLong(period) : weekLong(period);
}
