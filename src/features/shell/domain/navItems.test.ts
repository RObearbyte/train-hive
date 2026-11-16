import { describe, expect, it } from 'vitest';

import { activeNavKey, NAV_ITEMS } from './navItems';

describe('NAV_ITEMS', () => {
  it('are the five tabs in order, each with a unique path', () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual(['Home', 'Trainings', 'Activity', 'Statistics', 'Profile']);
    expect(new Set(NAV_ITEMS.map((item) => item.href)).size).toBe(5);
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
    ['/activity', 'activity'],
    ['/announcements/new', 'activity'],
    ['/statistics/u1', 'statistics'],
    ['/profile', 'profile'],
    ['/invitations', 'profile'],
    ['/community-settings', 'profile'],
    ['/attendance-history', 'profile'],
    ['/add-community/join-code', 'profile'],
    ['/welcome', null],
    ['/join', null],
  ])('%s -> %s', (path, key) => {
    expect(activeNavKey(path)).toBe(key);
  });
});
