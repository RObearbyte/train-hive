import { describe, expect, it } from 'vitest';

import {
  DASH,
  formatCount,
  formatDecimal,
  formatPercent,
  ofCount,
  sessionsText,
  smallSampleLabel,
  spokenPercent,
  trimDecimal,
} from './format';

describe('formatPercent', () => {
  it('trims to one decimal and drops a trailing .0', () => {
    expect(formatPercent(75)).toBe('75%');
    expect(formatPercent(75.0)).toBe('75%');
    expect(formatPercent(66.7)).toBe('66.7%');
    expect(formatPercent(66.66)).toBe('66.7%');
    expect(formatPercent(100)).toBe('100%');
    expect(formatPercent(0)).toBe('0%');
  });

  it('shows the dash for null, undefined and non-finite values, never NaN or null', () => {
    for (const bad of [null, undefined, Number.NaN, Infinity, -Infinity]) {
      const text = formatPercent(bad);
      expect(text).toBe(DASH);
      expect(text).not.toMatch(/NaN|Infinity|null|undefined/);
    }
  });

  it('keeps a real 0% distinct from no data', () => {
    expect(formatPercent(0)).not.toBe(formatPercent(null));
  });
});

describe('trimDecimal / formatDecimal / formatCount', () => {
  it('formats averages with at most one decimal', () => {
    expect(trimDecimal(3)).toBe('3');
    expect(trimDecimal(2.5)).toBe('2.5');
    expect(trimDecimal(2.54)).toBe('2.5');
    expect(trimDecimal(-0.04)).toBe('0');
    expect(formatDecimal(null)).toBe(DASH);
    expect(formatDecimal(0)).toBe('0');
  });

  it('formats counts and falls back to the dash', () => {
    expect(formatCount(7)).toBe('7');
    expect(formatCount(0)).toBe('0');
    expect(formatCount(null)).toBe(DASH);
    expect(formatCount(Number.NaN)).toBe(DASH);
  });
});

describe('ofCount', () => {
  it('words "7 of 9 trainings" with the right singular', () => {
    expect(ofCount(7, 9)).toBe('7 of 9 trainings');
    expect(ofCount(1, 1)).toBe('1 of 1 training');
    expect(ofCount(0, 0)).toBe('0 of 0 trainings');
    expect(ofCount(2, 4, 'going RSVPs')).toBe('2 of 4 going RSVPs');
  });

  it('never prints NaN', () => {
    expect(ofCount(Number.NaN, 3)).toBe(DASH);
    expect(ofCount(1, Infinity)).toBe(DASH);
  });
});

describe('smallSampleLabel', () => {
  it('labels a denominator of 1 or 2 only', () => {
    expect(smallSampleLabel(1)).toBe('based on 1 training');
    expect(smallSampleLabel(2)).toBe('based on 2 trainings');
  });

  it('has no label at 0 (no percentage exists) or from 3 on', () => {
    expect(smallSampleLabel(0)).toBeNull();
    expect(smallSampleLabel(3)).toBeNull();
    expect(smallSampleLabel(40)).toBeNull();
    expect(smallSampleLabel(Number.NaN)).toBeNull();
  });
});

describe('spokenPercent / sessionsText', () => {
  it('speaks percentages and handles missing', () => {
    expect(spokenPercent(66.7)).toBe('66.7 percent');
    expect(spokenPercent(null)).toBe('not available');
  });

  it('pluralizes sessions', () => {
    expect(sessionsText(1)).toBe('1 session');
    expect(sessionsText(0)).toBe('0 sessions');
    expect(sessionsText(4)).toBe('4 sessions');
  });
});
