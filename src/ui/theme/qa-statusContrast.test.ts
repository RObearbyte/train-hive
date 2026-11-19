import { describe, expect, it } from 'vitest';

import { darkColors, lightColors, type ColorPalette } from './colors';
import { buildStatusColors, statusMeta, TRAINING_DISPLAY_STATUSES } from './status';

/** WCAG 2.x contrast ratio of two #RRGGBB colours. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const themes: [string, ColorPalette][] = [
  ['light', lightColors],
  ['dark', darkColors],
];

describe.each(themes)('Q8 status token contrast (%s)', (_name, c) => {
  const status = buildStatusColors(c);
  it('every status label is readable (4.5:1) on its own fill, or on the card / page when transparent', () => {
    for (const key of TRAINING_DISPLAY_STATUSES) {
      const { fg, bg } = status[key];
      const surfaces = bg === 'transparent' ? [c.surface, c.surfaceRaised, c.background] : [bg];
      for (const surface of surfaces) {
        expect(ratio(fg, surface), `${key} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('registration borders reach 3:1 against the card (non-text contrast)', () => {
    for (const key of ['registration_open', 'registration_closed'] as const) {
      expect(ratio(status[key].border, c.surface), key).toBeGreaterThanOrEqual(3);
    }
  });
  it('the bell badge and the invite button text (onAccent on accent) are readable', () => {
    expect(ratio(c.onAccent, c.accent)).toBeGreaterThanOrEqual(4.5);
  });
  it('registration states differ from confirmed without colour: glyph and fill style', () => {
    expect(statusMeta.registration_open.icon).not.toBe(statusMeta.confirmed.icon);
    expect(statusMeta.registration_open.visual).not.toBe(statusMeta.confirmed.visual);
    expect(statusMeta.registration_closed.icon).not.toBe(statusMeta.registration_open.icon);
  });
});
