import { describe, expect, it } from 'vitest';

import {
  barHeight,
  barsFor,
  columnWidth,
  countScale,
  needsScroll,
  niceMax,
  rateScale,
  visibleLabelIndexes,
} from './chart';

describe('niceMax', () => {
  it('rounds up to a round number', () => {
    expect(niceMax(3.2)).toBe(4);
    expect(niceMax(4)).toBe(4);
    expect(niceMax(7)).toBe(8);
    expect(niceMax(11)).toBe(15);
    expect(niceMax(0.3)).toBe(0.3);
  });

  it('never returns 0, NaN or Infinity', () => {
    for (const value of [0, -5, Number.NaN, Infinity]) expect(niceMax(value)).toBe(1);
  });
});

describe('scales', () => {
  it('rates always span 0 to 100', () => {
    expect(rateScale()).toEqual({ max: 100, ticks: [0, 50, 100] });
  });

  it('counts scale to the largest value', () => {
    expect(countScale([1, 4, null, 2.5])).toEqual({ max: 4, ticks: [0, 2, 4] });
  });

  it('an all-zero series still has a usable scale', () => {
    const scale = countScale([0, 0, 0]);
    expect(scale.max).toBe(1);
    expect(barsFor([0, 0, 0], scale).map((bar) => bar.ratio)).toEqual([0, 0, 0]);
  });

  it('an all-null or empty series has a usable scale', () => {
    expect(countScale([null, null]).max).toBe(1);
    expect(countScale([]).max).toBe(1);
  });
});

describe('barsFor', () => {
  it('computes ratios and marks null as empty, 0 as a real zero', () => {
    const bars = barsFor([50, null, 0, 100], rateScale());
    expect(bars.map((bar) => bar.ratio)).toEqual([0.5, 0, 0, 1]);
    expect(bars.map((bar) => bar.empty)).toEqual([false, true, false, false]);
    expect(bars[1].value).toBeNull();
    expect(bars[2].value).toBe(0);
  });

  it('handles a single point', () => {
    const [full] = barsFor([3], countScale([3]));
    expect(full.ratio).toBe(1);
    const [partial] = barsFor([3.2], countScale([3.2]));
    expect(partial.ratio).toBe(0.8);
  });

  it('clamps values beyond the scale and ignores NaN', () => {
    const bars = barsFor([150, -10, Number.NaN], rateScale());
    expect(bars.map((bar) => bar.ratio)).toEqual([1, 0, 0]);
    expect(bars[2].empty).toBe(true);
  });
});

describe('barHeight', () => {
  it('scales to the plot, keeps small non-zero bars visible and zero flat', () => {
    expect(barHeight(0.5, 100)).toBe(50);
    expect(barHeight(0.001, 100)).toBe(3);
    expect(barHeight(0, 100)).toBe(0);
    expect(barHeight(1, 100)).toBe(100);
    expect(barHeight(Number.NaN, 100)).toBe(0);
    expect(barHeight(0.5, 0)).toBe(0);
  });
});

describe('column layout', () => {
  it('shares the width up to a maximum, and scrolls when too narrow', () => {
    expect(columnWidth(2, 300)).toBe(120);
    expect(columnWidth(5, 300)).toBe(60);
    expect(columnWidth(12, 300)).toBe(48);
    expect(needsScroll(5, 300)).toBe(false);
    expect(needsScroll(12, 300)).toBe(true);
  });

  it('copes with no width yet and no columns', () => {
    expect(columnWidth(3, 0)).toBe(48);
    expect(columnWidth(0, 300)).toBe(48);
  });
});

describe('visibleLabelIndexes', () => {
  it('shows every label when they fit and every Nth otherwise, always the first', () => {
    expect([...visibleLabelIndexes(5, 6)]).toEqual([0, 1, 2, 3, 4]);
    expect([...visibleLabelIndexes(12, 6)]).toEqual([0, 2, 4, 6, 8, 10]);
    expect([...visibleLabelIndexes(1, 6)]).toEqual([0]);
    expect(visibleLabelIndexes(0, 6).size).toBe(0);
  });
});
