import { describe, expect, it } from 'vitest';

import {
  CONTENT_MAX_WIDTH,
  dialogLayoutFor,
  layoutFor,
  ONBOARDING_MAX_WIDTH,
  SIDEBAR_WIDTH,
  usesWideContent,
  WIDE_BREAKPOINT,
  WIDE_CONTENT_MAX_WIDTH,
} from './layout';

describe('layoutFor', () => {
  it('phone widths keep the bottom tabs and full-width screens', () => {
    for (const width of [0, 320, 375, 430, 768, WIDE_BREAKPOINT - 1]) {
      expect(layoutFor(width)).toEqual({
        mode: 'narrow',
        sidebar: false,
        sidebarWidth: 0,
        contentMaxWidth: null,
        onboardingMaxWidth: null,
      });
    }
  });

  it('900 and wider: sidebar and a centred 960 px column', () => {
    for (const width of [WIDE_BREAKPOINT, 1024, 1280, 2560]) {
      expect(layoutFor(width)).toEqual({
        mode: 'wide',
        sidebar: true,
        sidebarWidth: SIDEBAR_WIDTH,
        contentMaxWidth: CONTENT_MAX_WIDTH,
        onboardingMaxWidth: ONBOARDING_MAX_WIDTH,
      });
    }
  });

  it('tables and charts may use the wider column, only when wide', () => {
    expect(layoutFor(1280, true).contentMaxWidth).toBe(WIDE_CONTENT_MAX_WIDTH);
    expect(layoutFor(375, true).contentMaxWidth).toBeNull();
  });

  it('nonsense widths fall back to the phone layout', () => {
    for (const width of [Number.NaN, -5, -Infinity]) {
      expect(layoutFor(width).mode).toBe('narrow');
    }
  });
});

describe('dialogLayoutFor', () => {
  it('phones get a sheet, wider windows a centred card of at most 480 (640 for panels)', () => {
    expect(dialogLayoutFor(375)).toEqual({ centered: false, maxWidth: null });
    expect(dialogLayoutFor(599)).toEqual({ centered: false, maxWidth: null });
    expect(dialogLayoutFor(600)).toEqual({ centered: true, maxWidth: 480 });
    expect(dialogLayoutFor(1280, 'panel')).toEqual({ centered: true, maxWidth: 640 });
  });
});

describe('usesWideContent', () => {
  it('statistics and the attendance sheet only', () => {
    expect(usesWideContent('/statistics')).toBe(true);
    expect(usesWideContent('/statistics/abc')).toBe(true);
    expect(usesWideContent('/trainings/abc/attendance')).toBe(true);
    expect(usesWideContent('/trainings/abc/attendance/')).toBe(true);
    expect(usesWideContent('/trainings')).toBe(false);
    expect(usesWideContent('/trainings/abc')).toBe(false);
    expect(usesWideContent('/statisticsx')).toBe(false);
    expect(usesWideContent('/')).toBe(false);
  });
});
