import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_TYPE_KEYS,
  DEFAULT_ACTIVITY_TYPE,
  activityLabel,
  activityOptions,
  isKnownActivityType,
} from '@/features/trainings/domain/activity';

describe('activity labels', () => {
  it('covers exactly the seeded keys from the contract, in order', () => {
    expect(ACTIVITY_TYPE_KEYS).toEqual([
      'running',
      'trail_running',
      'strength',
      'functional_fitness',
      'ocr',
      'other',
    ]);
    expect(ACTIVITY_TYPE_KEYS).toContain(DEFAULT_ACTIVITY_TYPE);
  });

  it.each([
    ['running', 'Running'],
    ['trail_running', 'Trail running'],
    ['strength', 'Strength'],
    ['functional_fitness', 'Functional fitness'],
    ['ocr', 'OCR'],
    ['other', 'Other'],
  ])('labels %s as %s', (key, label) => {
    expect(activityLabel(key)).toBe(label);
  });

  it('derives a readable label for a key added on the server later', () => {
    expect(activityLabel('stand_up_paddle')).toBe('Stand up paddle');
    expect(activityLabel('yoga')).toBe('Yoga');
    expect(activityLabel('open-water__swim')).toBe('Open water swim');
  });

  it('falls back to Other for missing or empty keys', () => {
    expect(activityLabel(null)).toBe('Other');
    expect(activityLabel(undefined)).toBe('Other');
    expect(activityLabel('')).toBe('Other');
    expect(activityLabel('___')).toBe('Other');
  });

  it('does not treat object prototype names as known keys', () => {
    expect(isKnownActivityType('toString')).toBe(false);
    expect(activityLabel('constructor')).toBe('Constructor');
  });

  it('builds picker options for every seeded key', () => {
    expect(activityOptions()).toEqual(
      ACTIVITY_TYPE_KEYS.map((key) => ({ key, label: activityLabel(key) })),
    );
  });
});
