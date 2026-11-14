/**
 * Timezone-correct date helpers. Sessions are stored as UTC instants plus an
 * IANA zone; everything shown to the user is rendered in the SESSION's zone,
 * never the device's.
 *
 * Nothing here reads the clock: functions that need "now" take it as a
 * parameter. `now` is for display only; deadlines are enforced by the server.
 */
import { TZDate, tzOffset } from '@date-fns/tz';
import { format } from 'date-fns';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Hours before the start at which RSVPs close by default (matches `create_training`). */
export const DEFAULT_RSVP_DEADLINE_HOURS = 2;

/** A wall-clock date and time: `date` is `yyyy-MM-dd`, `time` is 24-hour `HH:mm`. */
export type WallTime = { date: string; time: string };

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True for an IANA zone name the runtime knows, e.g. `Europe/Bucharest`. */
export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.trim() === '' || zone !== zone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** True for a real calendar date written as `yyyy-MM-dd` (rejects 2026-02-30). */
export function isValidDateString(date: string): boolean {
  const match = DATE_PATTERN.exec(date);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
  );
}

/** True for a 24-hour `HH:mm` time. */
export function isValidTimeString(time: string): boolean {
  return TIME_PATTERN.test(time);
}

function assertZone(zone: string): void {
  if (!isValidTimeZone(zone)) throw new RangeError(`Invalid time zone: ${String(zone)}`);
}

function toDate(instant: string | Date): Date {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid date: ${String(instant)}`);
  return date;
}

function inZone(instant: string | Date, zone: string): TZDate {
  assertZone(zone);
  return new TZDate(toDate(instant).getTime(), zone);
}

/**
 * Converts a wall-clock date and time in `zone` to a UTC ISO string.
 *
 * DST edges:
 * - a time skipped by spring-forward (e.g. 03:30 on the Bucharest change day)
 *   is moved forward by the size of the gap (04:30);
 * - a time repeated by fall-back resolves to the FIRST occurrence.
 *
 * Throws RangeError for a malformed date, time or zone.
 */
export function wallTimeToUtc(date: string, time: string, zone: string): string {
  assertZone(zone);
  const dateMatch = DATE_PATTERN.exec(date);
  const timeMatch = TIME_PATTERN.exec(time);
  if (!dateMatch || !isValidDateString(date)) throw new RangeError(`Invalid date: ${date}`);
  if (!timeMatch) throw new RangeError(`Invalid time: ${time}`);

  // The wall-clock reading interpreted as if it were UTC.
  const wallAsUtc = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
  );

  // Offsets (minutes east of UTC) safely before and after any nearby transition.
  const offsetBefore = tzOffset(zone, new Date(wallAsUtc - DAY_MS));
  const offsetAfter = tzOffset(zone, new Date(wallAsUtc + DAY_MS));
  const withBefore = wallAsUtc - offsetBefore * MINUTE_MS;
  if (offsetBefore === offsetAfter) return new Date(withBefore).toISOString();

  const withAfter = wallAsUtc - offsetAfter * MINUTE_MS;
  const beforeIsReal = tzOffset(zone, new Date(withBefore)) === offsetBefore;
  const afterIsReal = tzOffset(zone, new Date(withAfter)) === offsetAfter;

  let instant: number;
  if (beforeIsReal && afterIsReal) instant = Math.min(withBefore, withAfter); // repeated hour
  else if (beforeIsReal) instant = withBefore;
  else if (afterIsReal) instant = withAfter;
  else instant = withBefore; // skipped hour: lands after the gap
  return new Date(instant).toISOString();
}

/** Converts a UTC instant to the wall-clock date and time shown in `zone`. */
export function utcToWallTime(instant: string | Date, zone: string): WallTime {
  const zoned = inZone(instant, zone);
  return { date: format(zoned, 'yyyy-MM-dd'), time: format(zoned, 'HH:mm') };
}

/** Default RSVP deadline: exactly 2 hours before the start, as a UTC ISO string. */
export function defaultRsvpDeadline(startsAt: string | Date): string {
  return new Date(
    toDate(startsAt).getTime() - DEFAULT_RSVP_DEADLINE_HOURS * HOUR_MS,
  ).toISOString();
}

function dayNumber(date: string): number {
  const match = DATE_PATTERN.exec(date);
  if (!match) throw new RangeError(`Invalid date: ${date}`);
  return Math.round(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS);
}

/**
 * Calendar days from `now` to `instant`, both read in `zone`
 * (0 = same day, 1 = tomorrow, -1 = yesterday).
 */
export function calendarDaysFromNow(instant: string | Date, zone: string, now: Date): number {
  return dayNumber(utcToWallTime(instant, zone).date) - dayNumber(utcToWallTime(now, zone).date);
}

/** "Today", "Tomorrow", "Yesterday" in the session's zone, or null for any other day. */
export function relativeDayLabel(
  instant: string | Date,
  zone: string,
  now: Date,
): 'Today' | 'Tomorrow' | 'Yesterday' | null {
  const days = calendarDaysFromNow(instant, zone, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return null;
}

/** "09:00" */
export function formatTime(instant: string | Date, zone: string): string {
  return format(inZone(instant, zone), 'HH:mm');
}

/** "Saturday, 09:00" */
export function formatWeekdayTime(instant: string | Date, zone: string): string {
  return format(inZone(instant, zone), 'EEEE, HH:mm');
}

/** "Sat 14 Nov" */
export function formatShortDate(instant: string | Date, zone: string): string {
  return format(inZone(instant, zone), 'EEE d MMM');
}

/** "Saturday 14 November 2026" */
export function formatLongDate(instant: string | Date, zone: string): string {
  return format(inZone(instant, zone), 'EEEE d MMMM yyyy');
}

/** "Sat 14 Nov, 09:00" */
export function formatDateTime(instant: string | Date, zone: string): string {
  return format(inZone(instant, zone), 'EEE d MMM, HH:mm');
}

/**
 * "Sat 14 Nov, 09:00–10:30"; without an end "Sat 14 Nov, 09:00"; when the end
 * falls on another day "Sat 14 Nov, 23:00 – Sun 15 Nov, 01:00".
 */
export function formatDateTimeRange(
  startsAt: string | Date,
  endsAt: string | Date | null | undefined,
  zone: string,
): string {
  const start = formatDateTime(startsAt, zone);
  if (endsAt === null || endsAt === undefined) return start;
  const sameDay = utcToWallTime(startsAt, zone).date === utcToWallTime(endsAt, zone).date;
  return sameDay
    ? `${start}–${formatTime(endsAt, zone)}`
    : `${start} – ${formatDateTime(endsAt, zone)}`;
}

/**
 * Compact "when" for cards, relative to `now` in the session's zone:
 * "Today, 09:00", "Tomorrow, 09:00", "Yesterday, 09:00",
 * "Saturday, 09:00" (2 to 6 days ahead), otherwise "Sat 14 Nov, 09:00",
 * with the year added when it differs from the current one.
 */
export function formatSessionWhen(instant: string | Date, zone: string, now: Date): string {
  const relative = relativeDayLabel(instant, zone, now);
  if (relative) return `${relative}, ${formatTime(instant, zone)}`;

  const days = calendarDaysFromNow(instant, zone, now);
  if (days >= 2 && days <= 6) return formatWeekdayTime(instant, zone);

  const sameYear =
    utcToWallTime(instant, zone).date.slice(0, 4) === utcToWallTime(now, zone).date.slice(0, 4);
  return sameYear
    ? formatDateTime(instant, zone)
    : format(inZone(instant, zone), 'EEE d MMM yyyy, HH:mm');
}

/** True when `instant` is at or before `now`. Display only. */
export function hasPassed(instant: string | Date, now: Date): boolean {
  return toDate(instant).getTime() <= now.getTime();
}
