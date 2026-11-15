/**
 * Wording and grouping for a member's own attendance. Pure.
 *
 * `unrecorded` is shown as "Not recorded", never as missed or absent:
 * nobody marked the member, which says nothing about whether they came.
 */
import { format } from 'date-fns';

import type { AttendanceStatus } from '@/lib/database.types';
import { utcToWallTime } from '@/lib/datetime';

/** "You were present" etc. A missing row counts as not recorded. */
export function myOutcomeText(status: AttendanceStatus | null | undefined): string {
  if (status === 'present') return 'You were present';
  if (status === 'absent') return 'You were marked absent';
  return 'Attendance not recorded';
}

export type HistoryLike = {
  status: AttendanceStatus;
  session: { id: string; startsAt: string; timezone: string };
};

export type MonthGroup<T> = {
  /** `yyyy-MM`, in the session's own zone. */
  key: string;
  /** "November 2026". */
  label: string;
  items: T[];
};

/** Month of a session in ITS zone (a late Saturday session stays in its month for everyone). */
function monthKey(item: HistoryLike): string {
  let zone = item.session.timezone;
  let wall: string;
  try {
    wall = utcToWallTime(item.session.startsAt, zone).date;
  } catch {
    // Unknown zone on this device: fall back to UTC rather than dropping the row.
    zone = 'UTC';
    wall = utcToWallTime(item.session.startsAt, zone).date;
  }
  return wall.slice(0, 7);
}

function monthLabel(key: string): string {
  const [year, month] = key.split('-').map(Number) as [number, number];
  return format(new Date(year, month - 1, 1), 'LLLL yyyy');
}

/**
 * Groups items by the month of their session, newest month first, keeping the
 * input order inside a month (callers pass newest first). Does not mutate.
 */
export function groupByMonth<T extends HistoryLike>(items: readonly T[]): MonthGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = monthKey(item);
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.keys()]
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map((key) => ({ key, label: monthLabel(key), items: groups.get(key) as T[] }));
}

export type StatusCounts = { present: number; absent: number; unrecorded: number };

export function countByStatus(items: readonly { status: AttendanceStatus }[]): StatusCounts {
  const counts: StatusCounts = { present: 0, absent: 0, unrecorded: 0 };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

/** The single per-status line allowed before Milestone 4 statistics. */
export function countsLine(counts: StatusCounts): string {
  return `Present ${counts.present} · Absent ${counts.absent} · Not recorded ${counts.unrecorded}`;
}
