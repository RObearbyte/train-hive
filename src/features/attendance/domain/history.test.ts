import { describe, expect, it } from 'vitest';

import { countByStatus, countsLine, groupByMonth, myOutcomeText } from './history';

describe('myOutcomeText', () => {
  it('words each outcome; unrecorded and a missing row are never "absent"', () => {
    expect(myOutcomeText('present')).toBe('You were present');
    expect(myOutcomeText('absent')).toBe('You were marked absent');
    expect(myOutcomeText('unrecorded')).toBe('Attendance not recorded');
    expect(myOutcomeText(null)).toBe('Attendance not recorded');
    expect(myOutcomeText(undefined)).toBe('Attendance not recorded');
  });
});

const item = (id: string, startsAt: string, status: 'present' | 'absent' | 'unrecorded', timezone = 'UTC') => ({
  status,
  session: { id, startsAt, timezone },
});

describe('groupByMonth', () => {
  it('groups newest month first and keeps input order inside a month', () => {
    const groups = groupByMonth([
      item('a', '2026-11-20T10:00:00Z', 'present'),
      item('b', '2026-11-02T10:00:00Z', 'absent'),
      item('c', '2026-10-30T10:00:00Z', 'unrecorded'),
      item('d', '2027-01-05T10:00:00Z', 'present'),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['January 2027', 'November 2026', 'October 2026']);
    expect(groups[1]?.items.map((i) => i.session.id)).toEqual(['a', 'b']);
  });

  it("assigns the month in the session's own zone", () => {
    // 2026-11-30 23:30 UTC is already 1 December in Bucharest (UTC+2)
    const groups = groupByMonth([
      item('a', '2026-11-30T23:30:00Z', 'present', 'Europe/Bucharest'),
      item('b', '2026-11-30T23:30:00Z', 'present', 'UTC'),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['2026-12', '2026-11']);
  });

  it('returns no groups for no items', () => {
    expect(groupByMonth([])).toEqual([]);
  });
});

describe('counts', () => {
  it('counts each status and words the one allowed summary line', () => {
    const counts = countByStatus([
      { status: 'present' },
      { status: 'present' },
      { status: 'absent' },
      { status: 'unrecorded' },
    ]);
    expect(counts).toEqual({ present: 2, absent: 1, unrecorded: 1 });
    expect(countsLine(counts)).toBe('Present 2 · Absent 1 · Not recorded 1');
  });
});
