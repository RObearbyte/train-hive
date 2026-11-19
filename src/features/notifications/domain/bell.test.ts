import { describe, expect, it } from 'vitest';

import { bellAccessibilityLabel, bellBadgeText } from './bell';

describe('bellBadgeText', () => {
  it.each([
    [0, null],
    [-3, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [0.4, null],
    [1, '1'],
    [9, '9'],
    [10, '9+'],
    [250, '9+'],
    [3.9, '3'],
  ])('%s -> %s', (count, text) => {
    expect(bellBadgeText(count)).toBe(text);
  });
});

describe('bellAccessibilityLabel', () => {
  it('says the real number, even above 9', () => {
    expect(bellAccessibilityLabel(1)).toBe('Notifications, 1 unread');
    expect(bellAccessibilityLabel(12)).toBe('Notifications, 12 unread');
  });
  it('is plain when nothing is unread or the count is not usable', () => {
    expect(bellAccessibilityLabel(0)).toBe('Notifications');
    expect(bellAccessibilityLabel(Number.NaN)).toBe('Notifications');
  });
});
