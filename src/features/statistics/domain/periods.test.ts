import { describe, expect, it } from 'vitest';

import { axisLabels, monthLong, monthShort, parsePeriod, periodSpoken, weekLong, weekShort } from './periods';

describe('parsePeriod', () => {
  it('parses months and weeks and rejects anything else', () => {
    expect(parsePeriod('2026-10')).toEqual({ year: 2026, month: 10, day: null });
    expect(parsePeriod('2026-10-12')).toEqual({ year: 2026, month: 10, day: 12 });
    expect(parsePeriod('2026-13')).toBeNull();
    expect(parsePeriod('2026-10-32')).toBeNull();
    expect(parsePeriod('October')).toBeNull();
    expect(parsePeriod('')).toBeNull();
  });
});

describe('labels', () => {
  it('names months and weeks from the bucket name, independent of any device zone', () => {
    // 2026-10 is the community-local month, even though its first instant is 2026-09-30T21:00Z.
    expect(monthShort('2026-10')).toBe('Oct');
    expect(monthShort('2026-01', true)).toBe("Jan '26");
    expect(monthLong('2026-10')).toBe('October 2026');
    expect(weekShort('2026-10-12')).toBe('Oct 12');
    expect(weekShort('2026-12-28', true)).toBe("Dec 28 '26");
    expect(weekLong('2026-10-12')).toBe('week of 12 October 2026');
  });

  it('returns unknown input unchanged instead of "undefined"', () => {
    expect(monthShort('weird')).toBe('weird');
    expect(monthLong('weird')).toBe('weird');
    expect(weekShort('2026-10')).toBe('2026-10');
    expect(weekLong('2026-10')).toBe('2026-10');
  });

  it('adds the year on the first label and at a year boundary', () => {
    expect(axisLabels(['2026-11', '2026-12', '2027-01', '2027-02'], 'month')).toEqual([
      "Nov '26",
      'Dec',
      "Jan '27",
      'Feb',
    ]);
    expect(axisLabels(['2026-12-28', '2027-01-04'], 'week')).toEqual(["Dec 28 '26", "Jan 4 '27"]);
    expect(axisLabels([], 'week')).toEqual([]);
  });

  it('speaks a bucket by unit', () => {
    expect(periodSpoken('2026-10', 'month')).toBe('October 2026');
    expect(periodSpoken('2026-10-12', 'week')).toBe('week of 12 October 2026');
  });
});
