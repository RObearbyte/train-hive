import { describe, expect, it } from 'vitest';

import { activeNavKey, NAV_ITEMS } from './navItems';

describe('NAV_ITEMS', () => {
  it('are the five tabs in order, each with a unique path', () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual(['Home', 'Events', 'Communications', 'Statistics', 'Profile']);
    expect(new Set(NAV_ITEMS.map((item) => item.href)).size).toBe(5);
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
    ['/communications', 'communications'],
    ['/activity', 'communications'],
    ['/notifications', 'communications'],
    ['/announcements', 'communications'],
    ['/announcements/new', 'communications'],
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
