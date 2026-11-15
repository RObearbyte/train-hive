import { describe, expect, it } from 'vitest';

import { barHeight, barsFor, columnWidth, countScale, niceMax, rateScale, visibleLabelIndexes } from './chart';
import { EMPTY_STATS, MEMBER_LIST_NOTE, NOT_RECORDED_NOTE, RATE_NOTE, incompleteNote, truncatedNote } from './copy';
import { DASH, formatDecimal, formatTickValue, smallRsvpSampleLabel, formatPercent, ofCount, sessionsText, smallSampleLabel, trimDecimal } from './format';
import { axisLabels, monthLong, parsePeriod, weekLong } from './periods';
import { memberRowLabel, monthlySummary, trendSummary } from './summaries';
import { createWindowStore, isStatisticsWindow, windowPhrase } from './windows';

/**
 * M4-Q1: edge cases of the statistics presentation code that the developer's tests do not pin.
 * Pure functions only (the React components cannot render in the Node test environment).
 */

describe('copy: Not recorded and the rate (Q5-1)', () => {
  it('says Not recorded is not an absence but stays in the rate', () => {
    expect(NOT_RECORDED_NOTE).toMatch(/not counted as an absence/);
    expect(NOT_RECORDED_NOTE).toMatch(/included when the rate is calculated/);
    expect(MEMBER_LIST_NOTE).toMatch(/included in that total/);
    expect(RATE_NOTE).toMatch(/all finalized trainings/i);
  });
});

describe('chart axis', () => {
  // DEFECT Q5-3: the middle tick of a count chart is max / 2 shown with one decimal. With a
  // maximum of 1.5 (a "nice" step) the middle is 0.75, printed "0.8": the axis says 0.8 at the height
  // of 0.75 (chart.ts countScale, BarChart.tsx formatTick = formatDecimal). Cosmetic.
  it('Q5-3 fixed: every tick label of a count chart is the tick value it sits at', () => {
    for (const highest of [1.2, 1.4, 2.4, 0.3, 7.1, 12.4]) {
      const scale = countScale([highest]);
      for (const tick of scale.ticks) expect(Number(formatTickValue(tick)), `max ${scale.max}`).toBeCloseTo(tick, 6);
    }
  });

  it('tick text is exact, without trailing zeros, and the dash when unusable', () => {
    expect(formatTickValue(0.75)).toBe('0.75');
    expect(formatTickValue(1.25)).toBe('1.25');
    expect(formatTickValue(12.5)).toBe('12.5');
    expect(formatTickValue(4)).toBe('4');
    expect(formatTickValue(0)).toBe('0');
    expect(formatTickValue(Number.NaN)).toBe(DASH);
  });

  it('RSVP sample label counts RSVPs, not trainings', () => {
    expect([0, 1, 2, 3, Number.NaN].map((n) => smallRsvpSampleLabel(n))).toEqual([null, 'based on 1 RSVP', 'based on 2 RSVPs', null, null]);
  });

  it('ticks are 0, half and the maximum; the maximum is never below the largest value', () => {
    for (const v of [0, 0.1, 1, 1.01, 2.5, 4.99, 5, 9.99, 10, 11, 99, 100.1, 1234.5]) {
      const scale = countScale([v, null, 0]);
      expect(scale.max).toBeGreaterThanOrEqual(v);
      expect(scale.ticks).toEqual([0, scale.max / 2, scale.max]);
    }
    expect(niceMax(Number.NaN)).toBe(1);
    expect(niceMax(-4)).toBe(1);
    expect(niceMax(Infinity)).toBe(1);
  });

  it('a real zero is a bar of height 0 with the label "0", missing data is an empty slot with the dash', () => {
    const bars = barsFor([0, null, 3], countScale([0, null, 3]));
    expect(bars.map((b) => b.empty)).toEqual([false, true, false]);
    expect(barHeight(bars[0].ratio, 120)).toBe(0);
    expect(barHeight(bars[1].ratio, 120)).toBe(0);
    expect(barHeight(0.001, 120)).toBe(3);
    expect(barHeight(2, 120)).toBe(120);
    expect(barHeight(Number.NaN, 120)).toBe(0);
  });

  it('rate bars keep one scale (0 to 100) whatever the data, so months are comparable', () => {
    expect(rateScale()).toEqual({ max: 100, ticks: [0, 50, 100] });
    expect(barsFor([100, 50, 0, 120, -5], rateScale()).map((b) => b.ratio)).toEqual([1, 0.5, 0, 1, 0]);
  });

  it('column width and label thinning never produce NaN or collide labels', () => {
    for (const count of [0, 1, 2, 12, 36, 120]) {
      for (const available of [0, 100, 320, 1000, Number.NaN]) {
        const w = columnWidth(count, available);
        expect(Number.isFinite(w)).toBe(true);
        expect(w).toBeGreaterThanOrEqual(48);
      }
    }
    const shown = visibleLabelIndexes(36, 5);
    expect(shown.has(0)).toBe(true);
    expect(shown.size).toBeLessThanOrEqual(5);
    expect(visibleLabelIndexes(0, 5).size).toBe(0);
    expect(visibleLabelIndexes(5, 0).size).toBe(0);
  });
});

describe('periods across the year boundary and in odd input', () => {
  it('the first label and the first label after a year change carry the year', () => {
    expect(axisLabels(['2026-11', '2026-12', '2027-01', '2027-02'], 'month')).toEqual(["Nov '26", 'Dec', "Jan '27", 'Feb']);
    expect(axisLabels(['2026-12-28', '2027-01-04'], 'week')).toEqual(["Dec 28 '26", "Jan 4 '27"]);
  });

  it('a malformed period is returned as it is, never as "undefined" or NaN', () => {
    for (const bad of ['', 'abc', '2026-13', '2026-00', '2026-1', '2026-11-32', '2026-11-00', '99999-01', '2026-11-1']) {
      expect(parsePeriod(bad), bad).toBeNull();
      expect(monthLong(bad)).toBe(bad);
      expect(weekLong(bad)).toBe(bad);
    }
    expect(weekLong('2026-11')).toBe('2026-11');
  });
});

describe('spoken summaries', () => {
  const month = (period: string, eligible: number, attended: number, rate: number | null) => ({ period, from: '', to: '', eligible, attended, attendance_rate: rate });

  it('months with nothing finalized are spoken as such, rates keep their counts', () => {
    const text = monthlySummary([month('2026-10', 3, 2, 66.7), month('2026-11', 0, 0, null)]);
    expect(text).toBe('Monthly attendance rate. October 2026: 66.7 percent, 2 of 3 trainings. November 2026: no finalized trainings.');
    expect(monthlySummary([])).toMatch(/No months/);
  });

  it('a long series is capped and says how many months are left out', () => {
    const months = Array.from({ length: 36 }, (_, i) => month(`${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, 1, 1, 100));
    const text = monthlySummary(months);
    expect(text).toContain('latest 24 of 36 months');
    expect(text).not.toContain('January 2024');
    expect(text).toContain('December 2026');
  });

  it('trend buckets: no sessions, sessions without marks, a real average, singular and plural', () => {
    const bucket = (period: string, sessions: number, average: number | null) => ({ period, from: '', to: '', sessions, present: 0, incomplete_sessions: 0, average_attendees: average });
    const text = trendSummary([bucket('2026-10-12', 0, null), bucket('2026-10-19', 2, null), bucket('2026-10-26', 1, 1), bucket('2026-11-02', 3, 4.5)], 'week');
    expect(text).toContain('Week of 12 October 2026: no sessions');
    expect(text).toContain('Week of 19 October 2026: 2 sessions, attendance not marked');
    expect(text).toContain('Week of 26 October 2026: 1 average attendee, 1 session');
    expect(text).toContain('Week of 2 November 2026: 4.5 average attendees, 3 sessions');
  });

  it('member rows: no rate yet when there is none, "not recorded" is named, never "absent"', () => {
    const row = { user_id: 'u', display_name: 'Ana', role: 'member' as const, joined_at: '', eligible: 0, attended: 0, absent: 0, not_recorded: 0, attendance_rate: null, confirmed_rsvps: 0, missed: 0, rsvp_going_present: 0, rsvp_going_recorded: 0, rsvp_reliability: null, walk_ins: 0 };
    expect(memberRowLabel(row)).toBe('Ana, No finalized trainings, no rate yet');
    const busy = memberRowLabel({ ...row, eligible: 4, attended: 2, not_recorded: 2, attendance_rate: 50 });
    expect(busy).toBe('Ana, 2 of 4 trainings, 50 percent, 2 not recorded');
    expect(busy).not.toMatch(/absent|miss/i);
  });
});

describe('formatting', () => {
  it('small samples: labelled for 1 and 2, not for 0 or 3 and up, singular for 1', () => {
    expect([0, 1, 2, 3, 10, Number.NaN, -1].map(smallSampleLabel)).toEqual([null, 'based on 1 training', 'based on 2 trainings', null, null, null, null]);
  });

  it('counts read naturally and never fabricate', () => {
    expect(ofCount(1, 1)).toBe('1 of 1 training');
    expect(ofCount(0, 0)).toBe('0 of 0 trainings');
    expect(ofCount(Number.NaN, 3)).toBe(DASH);
    expect(sessionsText(1)).toBe('1 session');
    expect(sessionsText(Number.NaN)).toBe('0 sessions');
    expect(incompleteNote(0)).toBeNull();
    expect(incompleteNote(1)).toBe('1 session had no attendance marked and is excluded.');
    expect(incompleteNote(3)).toBe('3 sessions had no attendance marked and are excluded.');
    expect(truncatedNote(500, 501)).toBe('Showing the first 500 of 501 members.');
    expect(truncatedNote(5, 5)).toBeNull();
  });

  it('a rate of 0 is "0%", not the dash; null is the dash (zero denominators are never 0%)', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(null)).toBe(DASH);
    expect(formatDecimal(0)).toBe('0');
    expect(formatDecimal(null)).toBe(DASH);
    expect(trimDecimal(-0)).toBe('0');
    expect(trimDecimal(0.04)).toBe('0');
    expect(EMPTY_STATS).toMatch(/No finalized trainings yet/);
  });
});

describe('time filter store', () => {
  it('starts at 30 days, ignores anything that is not a filter, and tells listeners only about real changes', () => {
    const store = createWindowStore();
    const seen: string[] = [];
    const stop = store.subscribe(() => seen.push(store.get()));
    expect(store.get()).toBe('30d');
    for (const bad of ['7D', '', 'week', null, undefined, 7, '30d ']) store.set(bad as never);
    store.set('30d');
    expect(seen).toEqual([]);
    store.set('all');
    store.set('all');
    store.set('7d');
    expect(seen).toEqual(['all', '7d']);
    stop();
    store.set('90d');
    expect(seen).toEqual(['all', '7d']);
    expect(['7d', '30d', '90d', 'all'].every(isStatisticsWindow)).toBe(true);
    expect(windowPhrase('all')).toBe('all time');
  });
});
