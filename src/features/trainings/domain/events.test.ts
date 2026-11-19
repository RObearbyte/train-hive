import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SUBTYPE,
  EVENT_KINDS,
  KIND_FILTER_OPTIONS,
  courseLine,
  courseParts,
  fallbackSubtypes,
  filterByKind,
  formatDistanceKm,
  isTraining,
  kindInfo,
  subtypeLabel,
  subtypeOptions,
  takesCourse,
  takesObstacles,
} from './events';

describe('kinds', () => {
  it('has the four kinds, each with a label, a description and an icon', () => {
    expect(EVENT_KINDS).toEqual(['training', 'race', 'sports_event', 'social']);
    for (const kind of EVENT_KINDS) {
      const info = kindInfo(kind);
      expect(info.label.length).toBeGreaterThan(2);
      expect(info.description.length).toBeGreaterThan(10);
      expect(info.icon.length).toBeGreaterThan(1);
    }
    expect(kindInfo('sports_event').label).toBe('Sports event');
    expect(kindInfo('social').label).toBe('Social event');
  });

  it('gives every kind its own glyph, so a kind is never told by colour alone', () => {
    const icons = EVENT_KINDS.map((kind) => kindInfo(kind).icon);
    expect(new Set(icons).size).toBe(EVENT_KINDS.length);
  });

  it('only a training is a training', () => {
    expect(isTraining('training')).toBe(true);
    expect(EVENT_KINDS.filter((kind) => !isTraining(kind))).toEqual(['race', 'sports_event', 'social']);
  });
});

describe('subtypes', () => {
  it('bundles exactly the lists the migration seeds', () => {
    expect(fallbackSubtypes('training').map((s) => s.key)).toEqual([
      'running',
      'trail_running',
      'strength',
      'functional_fitness',
      'ocr',
      'other',
    ]);
    expect(fallbackSubtypes('race').map((s) => s.label)).toEqual([
      'Trail running',
      'Asphalt running',
      'OCR',
    ]);
    expect(fallbackSubtypes('sports_event').map((s) => s.key)).toEqual([
      'crossfit_event',
      'public_training',
      'other',
    ]);
    expect(fallbackSubtypes('social').map((s) => s.key)).toEqual(['social_gathering', 'other']);
  });

  it('every kind defaults to one of its own subtypes', () => {
    for (const kind of EVENT_KINDS) {
      expect(fallbackSubtypes(kind).map((s) => s.key)).toContain(DEFAULT_SUBTYPE[kind]);
    }
  });

  it('uses the loaded rows of the kind, in sort order, once there are some', () => {
    const rows = [
      { kind: 'race' as const, key: 'ocr', label: 'Obstacle race', sort_order: 2 },
      { kind: 'race' as const, key: 'trail_running', label: 'Trail', sort_order: 1 },
      { kind: 'social' as const, key: 'other', label: 'Other', sort_order: 1 },
    ];
    expect(subtypeOptions('race', rows)).toEqual([
      { key: 'trail_running', label: 'Trail' },
      { key: 'ocr', label: 'Obstacle race' },
    ]);
    // Nothing loaded for the kind: the bundled list.
    expect(subtypeOptions('sports_event', rows).map((s) => s.key)).toEqual([
      'crossfit_event',
      'public_training',
      'other',
    ]);
    expect(subtypeOptions('race', undefined).length).toBe(3);
  });

  it('keeps a stored subtype this build does not know, with a readable label', () => {
    const options = subtypeOptions('social', undefined, 'board_games');
    expect(options.at(-1)).toEqual({ key: 'board_games', label: 'Board games' });
    // A known one is not added twice.
    expect(subtypeOptions('social', undefined, 'other').filter((s) => s.key === 'other')).toHaveLength(1);
  });

  it('labels from the loaded row, else the bundled one, else the key', () => {
    const rows = [{ kind: 'race' as const, key: 'ocr', label: 'Obstacle race', sort_order: 1 }];
    expect(subtypeLabel('race', 'ocr', rows)).toBe('Obstacle race');
    expect(subtypeLabel('race', 'ocr')).toBe('OCR');
    expect(subtypeLabel('training', 'ocr')).toBe('OCR');
    expect(subtypeLabel('social', 'pub_quiz')).toBe('Pub quiz');
    expect(subtypeLabel('social', null)).toBe('Other');
  });
});

describe('which subtypes carry course facts', () => {
  it('distance and D+ for the running types, of any kind', () => {
    for (const key of ['running', 'trail_running', 'asphalt_running', 'ocr']) {
      expect(takesCourse(key)).toBe(true);
    }
    for (const key of ['strength', 'functional_fitness', 'other', 'crossfit_event', 'public_training', 'social_gathering']) {
      expect(takesCourse(key)).toBe(false);
    }
  });

  it('obstacles for OCR only', () => {
    expect(takesObstacles('ocr')).toBe(true);
    for (const key of ['running', 'trail_running', 'asphalt_running', 'other']) {
      expect(takesObstacles(key)).toBe(false);
    }
  });
});

describe('course line', () => {
  const none = { distance_km: null, elevation_gain_m: null, obstacle_count: null };

  it('reads "21.1 km · D+ 450 m · 12 obstacles"', () => {
    expect(
      courseLine({ distance_km: 21.1, elevation_gain_m: 450, obstacle_count: 12 }, 'en'),
    ).toBe('21.1 km · D+ 450 m · 12 obstacles');
  });

  it('leaves out what is not set, and is null when nothing is', () => {
    expect(courseLine({ ...none, distance_km: 10 }, 'en')).toBe('10 km');
    expect(courseLine({ ...none, elevation_gain_m: 80 }, 'en')).toBe('D+ 80 m');
    expect(courseLine({ ...none, distance_km: 5, obstacle_count: 1 }, 'en')).toBe('5 km · 1 obstacle');
    expect(courseLine(none, 'en')).toBeNull();
    expect(courseParts(none)).toEqual([]);
  });

  it('keeps a real zero (0 m of climb, 0 obstacles) instead of hiding it', () => {
    expect(courseLine({ ...none, elevation_gain_m: 0 }, 'en')).toBe('D+ 0 m');
    expect(courseLine({ ...none, obstacle_count: 0 }, 'en')).toBe('0 obstacles');
  });

  it('uses the locale decimal comma and thousands separator', () => {
    expect(formatDistanceKm(21.1, 'ro-RO')).toBe('21,1');
    expect(formatDistanceKm(21.1, 'de-DE')).toBe('21,1');
    expect(courseLine({ distance_km: 42.195, elevation_gain_m: 1250, obstacle_count: null }, 'de-DE')).toBe(
      '42,2 km · D+ 1.250 m',
    );
  });

  it('shows at most two decimals and no trailing zeros', () => {
    expect(formatDistanceKm(21.0, 'en')).toBe('21');
    expect(formatDistanceKm(21.5, 'en')).toBe('21.5');
    expect(formatDistanceKm(0.25, 'en')).toBe('0.25');
    expect(formatDistanceKm(10.126, 'en')).toBe('10.13');
  });
});

describe('kind filter', () => {
  const events = [
    { id: 'a', event_kind: 'training' as const },
    { id: 'b', event_kind: 'race' as const },
    { id: 'c', event_kind: 'race' as const },
    { id: 'd', event_kind: 'social' as const },
    { id: 'e', event_kind: 'sports_event' as const },
  ];

  it('offers All plus one entry per kind', () => {
    expect(KIND_FILTER_OPTIONS.map((o) => o.value)).toEqual([
      'all',
      'training',
      'race',
      'sports_event',
      'social',
    ]);
  });

  it('All keeps everything, in order, as a copy', () => {
    const all = filterByKind(events, 'all');
    expect(all.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(all).not.toBe(events);
  });

  it('a kind keeps only that kind and preserves order', () => {
    expect(filterByKind(events, 'race').map((e) => e.id)).toEqual(['b', 'c']);
    expect(filterByKind(events, 'training').map((e) => e.id)).toEqual(['a']);
    expect(filterByKind(events, 'social').map((e) => e.id)).toEqual(['d']);
    expect(filterByKind([], 'race')).toEqual([]);
  });
});
