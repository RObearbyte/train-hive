import { describe, expect, it, vi } from 'vitest';

import { statisticsKeys } from '../api/keys';
import {
  createWindowStore,
  DEFAULT_WINDOW,
  isStatisticsWindow,
  WINDOW_OPTIONS,
  windowPhrase,
} from './windows';

describe('windows', () => {
  it('offers the four filters in order and defaults to 30 days', () => {
    expect(WINDOW_OPTIONS.map((option) => option.value)).toEqual(['7d', '30d', '90d', 'all']);
    expect(WINDOW_OPTIONS.map((option) => option.label)).toEqual(['7 days', '30 days', '90 days', 'All time']);
    expect(DEFAULT_WINDOW).toBe('30d');
  });

  it('maps every option to the server token and a phrase', () => {
    for (const option of WINDOW_OPTIONS) {
      expect(isStatisticsWindow(option.value)).toBe(true);
      expect(windowPhrase(option.value)).not.toMatch(/undefined/);
    }
    expect(windowPhrase('all')).toBe('all time');
    expect(isStatisticsWindow('7D')).toBe(false);
    expect(isStatisticsWindow('week')).toBe(false);
    expect(isStatisticsWindow(null)).toBe(false);
  });
});

describe('window store', () => {
  it('starts at the default, remembers the choice and notifies once per change', () => {
    const store = createWindowStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(store.get()).toBe('30d');
    store.set('90d');
    store.set('90d');
    expect(store.get()).toBe('90d');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.set('all');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ignores an invalid value', () => {
    const store = createWindowStore('7d');
    store.set('week' as never);
    expect(store.get()).toBe('7d');
  });
});

describe('statisticsKeys', () => {
  it('puts the window, the community and the user in every key', () => {
    expect(statisticsKeys.mine('c1', 'u1', '30d')).toEqual(['statistics', 'mine', 'c1', 'u1', '30d']);
    expect(statisticsKeys.mine('c1', 'u1', '7d')).not.toEqual(statisticsKeys.mine('c1', 'u1', '30d'));
    expect(statisticsKeys.mine('c1', 'u1', '7d')).not.toEqual(statisticsKeys.mine('c1', 'u2', '7d'));
    expect(statisticsKeys.history('c1', 'u1', 'all')).toEqual(['statistics', 'history', 'c1', 'u1', 'all']);
    expect(statisticsKeys.member('c1', 'm1', '90d')).toEqual(['statistics', 'member', 'c1', 'm1', '90d']);
    expect(statisticsKeys.community('c1', '90d')).toEqual(['statistics', 'community', 'c1', '90d']);
    expect(statisticsKeys.summary('c1', '90d')).toEqual(['statistics', 'summary', 'c1', '90d']);
  });

  it('shares one prefix so a single invalidation covers all statistics', () => {
    for (const key of [
      statisticsKeys.mine('c', 'u', '7d'),
      statisticsKeys.history('c', 'u', '7d'),
      statisticsKeys.member('c', 'm', '7d'),
      statisticsKeys.community('c', '7d'),
      statisticsKeys.summary('c', '7d'),
    ]) {
      expect(key[0]).toBe(statisticsKeys.all[0]);
    }
  });
});
