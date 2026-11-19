import { describe, expect, it } from 'vitest';

import { activeNavKey, NAV_ITEMS } from './navItems';

describe('NAV_ITEMS', () => {
  it('are the four tabs in order, each with a unique path, and no Activity tab', () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual(['Home', 'Events', 'Statistics', 'Profile']);
    expect(new Set(NAV_ITEMS.map((item) => item.href)).size).toBe(4);
    expect(NAV_ITEMS.some((item) => item.href === '/activity')).toBe(false);
  });
});

describe('activeNavKey', () => {
  it.each([
    ['/', 'home'],
    ['', 'home'],
    ['/trainings', 'trainings'],
    ['/trainings/', 'trainings'],
    ['/trainings/new', 'trainings'],
    ['/trainings/5/attendance', 'trainings'],
    ['/activity', 'home'],
    ['/notifications', 'home'],
    ['/announcements', 'home'],
    ['/announcements/new', 'home'],
    ['/statistics/u1', 'statistics'],
    ['/profile', 'profile'],
    ['/invitations', 'profile'],
    ['/members', 'profile'],
    ['/privacy', 'profile'],
    ['/community-settings', 'profile'],
    ['/attendance-history', 'profile'],
    ['/add-community/join-code', 'profile'],
    ['/welcome', null],
    ['/join', null],
  ])('%s -> %s', (path, key) => {
    expect(activeNavKey(path)).toBe(key);
  });
});
