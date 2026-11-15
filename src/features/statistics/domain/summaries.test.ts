import { describe, expect, it } from 'vitest';

import type {
  AttendanceHistoryItem,
  AttendanceHistoryPage,
  AttendanceTrendBucket,
  MemberStatisticsSummaryRow,
  MonthlyParticipation,
  TopSession,
} from '@/lib/database.types';

import { incompleteNote, truncatedNote } from './copy';
import {
  flattenHistory,
  MAX_SPOKEN_BUCKETS,
  memberLine,
  memberRowLabel,
  monthlySummary,
  outcomeLabel,
  rsvpLabel,
  trendSummary,
  visibleTopSessions,
} from './summaries';

const month = (period: string, eligible: number, attended: number, rate: number | null): MonthlyParticipation => ({
  period,
  from: '2026-01-01T00:00:00Z',
  to: '2026-02-01T00:00:00Z',
  eligible,
  attended,
  attendance_rate: rate,
});

const bucket = (
  period: string,
  sessions: number,
  present: number,
  average: number | null,
): AttendanceTrendBucket => ({
  period,
  from: '2026-01-01T00:00:00Z',
  to: '2026-01-08T00:00:00Z',
  sessions,
  present,
  incomplete_sessions: 0,
  average_attendees: average,
});

describe('monthlySummary', () => {
  it('describes each month and says no trainings for empty ones', () => {
    const text = monthlySummary([month('2026-10', 3, 2, 66.7), month('2026-11', 0, 0, null)]);
    expect(text).toBe(
      'Monthly attendance rate. October 2026: 66.7 percent, 2 of 3 trainings. November 2026: no finalized trainings.',
    );
  });

  it('handles an empty series and never prints NaN or null', () => {
    expect(monthlySummary([])).toContain('No months');
    const text = monthlySummary([month('2026-10', 0, 0, null), month('2026-11', 1, 0, 0)]);
    expect(text).not.toMatch(/NaN|null|undefined|Infinity/);
    expect(text).toContain('0 percent, 0 of 1 training');
  });

  it('keeps a long series short and says so', () => {
    const many = Array.from({ length: MAX_SPOKEN_BUCKETS + 6 }, (_, i) =>
      month(`${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, 1, 1, 100),
    );
    const text = monthlySummary(many);
    expect(text).toContain(`latest ${MAX_SPOKEN_BUCKETS} of ${MAX_SPOKEN_BUCKETS + 6} months`);
    expect(text.match(/percent/g)).toHaveLength(MAX_SPOKEN_BUCKETS);
  });
});

describe('trendSummary', () => {
  it('describes averages, empty weeks and unmarked weeks', () => {
    const text = trendSummary(
      [bucket('2026-10-12', 1, 4, 4), bucket('2026-10-19', 0, 0, null), bucket('2026-10-26', 2, 0, null)],
      'week',
    );
    expect(text).toBe(
      'Average attendees per week. Week of 12 October 2026: 4 average attendees, 1 session. Week of 19 October 2026: no sessions. Week of 26 October 2026: 2 sessions, attendance not marked.',
    );
  });

  it('works for a single point, all zeros and an empty series', () => {
    expect(trendSummary([bucket('2026-10', 3, 0, 0)], 'month')).toContain('0 average attendees, 3 sessions');
    expect(trendSummary([bucket('2026-10', 1, 1, 1)], 'month')).toContain('1 average attendee,');
    expect(trendSummary([], 'month')).toContain('No months');
  });
});

describe('history labels', () => {
  it('words outcomes; not recorded is never absent or missed', () => {
    expect(outcomeLabel('present')).toBe('Present');
    expect(outcomeLabel('absent')).toBe('Absent');
    expect(outcomeLabel('unrecorded')).toBe('Not recorded');
    expect(outcomeLabel('unrecorded')).not.toMatch(/absent|missed/i);
  });

  it('shows the RSVP only when there was an answer', () => {
    expect(rsvpLabel('going')).toBe('Said going');
    expect(rsvpLabel('not_going')).toBe('Said not going');
    expect(rsvpLabel('no_response')).toBeNull();
  });
});

const item = (id: string): AttendanceHistoryItem => ({
  session_id: id,
  title: id,
  activity_type: 'run',
  starts_at: '2026-10-01T10:00:00Z',
  ends_at: null,
  timezone: 'UTC',
  location_name: 'Park',
  rsvp_response: 'going',
  outcome: 'present',
  is_walk_in: false,
});

const page = (ids: string[], hasMore: boolean): AttendanceHistoryPage => ({
  window: '30d',
  from: null,
  to: '2026-11-01T00:00:00Z',
  generated_at: '2026-11-01T00:00:00Z',
  items: ids.map(item),
  has_more: hasMore,
  next_before: hasMore ? '2026-10-01T10:00:00+00:00' : null,
});

describe('flattenHistory', () => {
  it('joins pages in order and drops a session that appears twice', () => {
    const items = flattenHistory([page(['a', 'b'], true), page(['b', 'c'], false)]);
    expect(items.map((entry) => entry.session_id)).toEqual(['a', 'b', 'c']);
  });

  it('handles no pages', () => {
    expect(flattenHistory(undefined)).toEqual([]);
    expect(flattenHistory([])).toEqual([]);
  });
});

const top = (id: string, present: number): TopSession => ({
  session_id: id,
  title: id,
  starts_at: '2026-10-01T10:00:00Z',
  timezone: 'UTC',
  present,
  min_participants: 3,
  going_count: present,
});

describe('visibleTopSessions', () => {
  it('hides sessions nobody attended and keeps the order', () => {
    expect(visibleTopSessions([top('a', 5), top('b', 0), top('c', 2)]).map((s) => s.session_id)).toEqual([
      'a',
      'c',
    ]);
    expect(visibleTopSessions([top('a', 0)])).toEqual([]);
  });
});

const row = (over: Partial<MemberStatisticsSummaryRow>): MemberStatisticsSummaryRow => ({
  user_id: 'u',
  display_name: 'Ana',
  role: 'member',
  joined_at: '2026-01-01T00:00:00Z',
  eligible: 4,
  attended: 3,
  absent: 0,
  not_recorded: 1,
  attendance_rate: 75,
  confirmed_rsvps: 3,
  missed: 0,
  rsvp_going_present: 3,
  rsvp_going_recorded: 3,
  rsvp_reliability: 100,
  walk_ins: 0,
  ...over,
});

describe('member rows', () => {
  it('shows attended of eligible, and a words-only line when there were none', () => {
    expect(memberLine(row({}))).toBe('3 of 4 trainings');
    expect(memberLine(row({ eligible: 0, attended: 0 }))).toBe('No finalized trainings');
  });

  it('speaks the row, with a null rate as "no rate yet"', () => {
    expect(memberRowLabel(row({}))).toBe('Ana, 3 of 4 trainings, 75 percent, 1 not recorded');
    expect(memberRowLabel(row({ eligible: 0, attended: 0, not_recorded: 0, attendance_rate: null }))).toBe(
      'Ana, No finalized trainings, no rate yet',
    );
  });
});

describe('notes', () => {
  it('words the incomplete-session note only when there are some', () => {
    expect(incompleteNote(0)).toBeNull();
    expect(incompleteNote(1)).toBe('1 session had no attendance marked and is excluded.');
    expect(incompleteNote(3)).toBe('3 sessions had no attendance marked and are excluded.');
  });

  it('notes a truncated list only when members are missing', () => {
    expect(truncatedNote(500, 500)).toBeNull();
    expect(truncatedNote(500, 730)).toBe('Showing the first 500 of 730 members.');
  });
});
