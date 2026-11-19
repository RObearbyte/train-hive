/**
 * Presentation helpers for statistics numbers. Pure.
 *
 * Rule: nothing here ever returns "NaN", "Infinity", "null" or "undefined".
 * A missing or unusable number is the em dash.
 */
export const DASH = '—';

/** Below this many eligible events a percentage is labelled with its sample size. */
export const SMALL_SAMPLE_THRESHOLD = 3;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** At most one decimal, trailing ".0" dropped: 75 -> "75", 66.66 -> "66.7". */
export function trimDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const text = String(Number(rounded.toFixed(1)));
  return text === '-0' ? '0' : text;
}

/** "75%", "66.7%", "100%"; the dash for null / undefined / non-finite. */
export function formatPercent(rate: number | null | undefined): string {
  return isFiniteNumber(rate) ? `${trimDecimal(rate)}%` : DASH;
}

/** Spoken form: "66.7 percent". */
export function spokenPercent(rate: number | null | undefined): string {
  return isFiniteNumber(rate) ? `${trimDecimal(rate)} percent` : 'not available';
}

/** An average or other decimal, one decimal at most; the dash when missing. */
export function formatDecimal(value: number | null | undefined): string {
  return isFiniteNumber(value) ? trimDecimal(value) : DASH;
}

/** A whole count; the dash when missing. */
export function formatCount(value: number | null | undefined): string {
  return isFiniteNumber(value) ? String(Math.max(0, Math.trunc(value))) : DASH;
}

export function trainingNoun(count: number): string {
  return count === 1 ? 'event' : 'events';
}

/** "7 of 9 events" ("1 of 1 event"). The dash when either number is unusable. */
export function ofCount(part: number, total: number, noun?: string): string {
  if (!isFiniteNumber(part) || !isFiniteNumber(total)) return DASH;
  const word = noun ?? trainingNoun(total);
  return `${formatCount(part)} of ${formatCount(total)} ${word}`;
}

/**
 * "based on 2 events" when the denominator is 1 or 2, else null. With a
 * denominator of 0 there is no percentage at all (it is the dash), so no label.
 */
export function smallSampleLabel(denominator: number): string | null {
  if (!isFiniteNumber(denominator)) return null;
  const n = Math.trunc(denominator);
  if (n < 1 || n >= SMALL_SAMPLE_THRESHOLD) return null;
  return `based on ${n} ${trainingNoun(n)}`;
}

/** Same as `smallSampleLabel` for a count of RSVPs (people): "based on 1 RSVP" / "based on 2 RSVPs". */
export function smallRsvpSampleLabel(denominator: number): string | null {
  if (!isFiniteNumber(denominator)) return null;
  const n = Math.trunc(denominator);
  if (n < 1 || n >= SMALL_SAMPLE_THRESHOLD) return null;
  return `based on ${n} ${n === 1 ? 'RSVP' : 'RSVPs'}`;
}

/** An axis tick: up to two decimals, trailing zeros dropped (0.75 -> "0.75", 12.5 -> "12.5"). */
export function formatTickValue(value: number): string {
  if (!isFiniteNumber(value)) return DASH;
  const text = String(Number((Math.round(value * 100) / 100).toFixed(2)));
  return text === '-0' ? '0' : text;
}

/** "1 session" / "3 sessions". */
export function sessionsText(count: number): string {
  const n = isFiniteNumber(count) ? Math.max(0, Math.trunc(count)) : 0;
  return `${n} ${n === 1 ? 'session' : 'sessions'}`;
}
