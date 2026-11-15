/**
 * Text alternatives for the charts, and small view-model helpers for the
 * lists. Pure.
 */
import type {
  AttendanceHistoryItem,
  AttendanceHistoryPage,
  AttendanceStatus,
  AttendanceTrendBucket,
  MemberStatisticsSummaryRow,
  MonthlyParticipation,
  RsvpResponse,
  TopSession,
} from '@/lib/database.types';

import { formatCount, formatDecimal, ofCount, sessionsText, spokenPercent } from './format';
import { periodSpoken, type PeriodUnit } from './periods';

/** The text alternative never lists more than this many buckets; the rest is summarized. */
export const MAX_SPOKEN_BUCKETS = 24;

function capped<T>(items: readonly T[]): { shown: readonly T[]; hidden: number } {
  if (items.length <= MAX_SPOKEN_BUCKETS) return { shown: items, hidden: 0 };
  const hidden = items.length - MAX_SPOKEN_BUCKETS;
  return { shown: items.slice(items.length - MAX_SPOKEN_BUCKETS), hidden };
}

/** "Monthly attendance rate. October 2026: 66.7 percent, 2 of 3 trainings. November 2026: no trainings." */
export function monthlySummary(monthly: readonly MonthlyParticipation[]): string {
  if (monthly.length === 0) return 'Monthly attendance rate. No months to show yet.';
  const { shown, hidden } = capped(monthly);
  const parts = shown.map((month) => {
    const label = periodSpoken(month.period, 'month');
    if (month.eligible === 0 || month.attendance_rate === null) {
      return `${label}: no finalized trainings`;
    }
    return `${label}: ${spokenPercent(month.attendance_rate)}, ${ofCount(month.attended, month.eligible)}`;
  });
  const lead = hidden > 0 ? `Monthly attendance rate, latest ${shown.length} of ${monthly.length} months.` : 'Monthly attendance rate.';
  return `${lead} ${parts.join('. ')}.`;
}

/** "Average attendees per week. Week of 12 October 2026: 4 attendees from 1 session. ..." */
export function trendSummary(trend: readonly AttendanceTrendBucket[], unit: PeriodUnit): string {
  const noun = unit === 'month' ? 'month' : 'week';
  if (trend.length === 0) return `Average attendees per ${noun}. No ${noun}s to show yet.`;
  const { shown, hidden } = capped(trend);
  const parts = shown.map((bucket) => {
    const label = periodSpoken(bucket.period, unit);
    const label0 = label.charAt(0).toUpperCase() + label.slice(1);
    if (bucket.sessions === 0) return `${label0}: no sessions`;
    if (bucket.average_attendees === null) {
      return `${label0}: ${sessionsText(bucket.sessions)}, attendance not marked`;
    }
    const people = bucket.average_attendees === 1 ? 'attendee' : 'attendees';
    return `${label0}: ${formatDecimal(bucket.average_attendees)} average ${people}, ${sessionsText(bucket.sessions)}`;
  });
  const lead =
    hidden > 0
      ? `Average attendees per ${noun}, latest ${shown.length} of ${trend.length} ${noun}s.`
      : `Average attendees per ${noun}.`;
  return `${lead} ${parts.join('. ')}.`;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export function outcomeLabel(outcome: AttendanceStatus): string {
  switch (outcome) {
    case 'present':
      return 'Present';
    case 'absent':
      return 'Absent';
    default:
      // Includes 'unrecorded' and anything unexpected: never styled as missed.
      return 'Not recorded';
  }
}

/** "Said going" / "Said not going"; null when the member never answered. */
export function rsvpLabel(response: RsvpResponse): string | null {
  if (response === 'going') return 'Said going';
  if (response === 'not_going') return 'Said not going';
  return null;
}

/** All loaded pages as one list, first occurrence of a session wins (pages can overlap after a refetch). */
export function flattenHistory(
  pages: readonly AttendanceHistoryPage[] | undefined,
): AttendanceHistoryItem[] {
  const seen = new Set<string>();
  const items: AttendanceHistoryItem[] = [];
  for (const page of pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.session_id)) continue;
      seen.add(item.session_id);
      items.push(item);
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Organizer lists
// ---------------------------------------------------------------------------

/** Sessions with nobody present say nothing about popularity: hide them. */
export function visibleTopSessions(sessions: readonly TopSession[]): TopSession[] {
  return sessions.filter((session) => session.present > 0);
}

/** "3 of 4 trainings" for a member row; the dash when they had none. */
export function memberLine(row: Pick<MemberStatisticsSummaryRow, 'attended' | 'eligible'>): string {
  return row.eligible > 0 ? ofCount(row.attended, row.eligible) : 'No finalized trainings';
}

/** Spoken label of a member row. */
export function memberRowLabel(row: MemberStatisticsSummaryRow): string {
  const rate = row.attendance_rate === null ? 'no rate yet' : spokenPercent(row.attendance_rate);
  const notRecorded = row.not_recorded > 0 ? `, ${formatCount(row.not_recorded)} not recorded` : '';
  return `${row.display_name}, ${memberLine(row)}, ${rate}${notRecorded}`;
}

/** "5 present" for the most attended list. */
export function presentText(count: number): string {
  return `${formatCount(count)} present`;
}

