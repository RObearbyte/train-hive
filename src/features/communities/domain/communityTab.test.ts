import { describe, expect, it } from 'vitest';

import { NAV_ITEMS } from '@/features/shell/domain/navItems';

import { communityTabSections, managementLinks, memberCountText, tabLabelFits } from './communityTab';

describe('memberCountText', () => {
  it.each([[0, '0 members'], [1, '1 member'], [2, '2 members'], [-3, '0 members'], [Number.NaN, '0 members'], [4.9, '4 members']])(
    '%s -> %s',
    (n, text) => expect(memberCountText(n)).toBe(text),
  );
});

describe('organizer controls', () => {
  it('members get no management section and no links', () => {
    expect(communityTabSections(false).management).toBe(false);
    expect(managementLinks(false)).toEqual([]);
  });
  it('organizers get every shortcut, to routes that exist', () => {
    expect(communityTabSections(true).management).toBe(true);
    expect(managementLinks(true).map((l) => l.href)).toEqual([
      '/invitations', '/community-settings', '/announcements/new', '/announcements', '/members', '/statistics',
    ]);
  });
});

describe('tab label fit', () => {
  it('the six tab labels fit a 360dp phone', () => {
    expect(NAV_ITEMS).toHaveLength(6);
    expect(tabLabelFits(NAV_ITEMS.map((i) => i.tabLabel ?? i.label), 360)).toBe(true);
    // The long sidebar label would truncate in the bar, hence the short one.
    expect(tabLabelFits(NAV_ITEMS.map((i) => i.label), 360)).toBe(false);
  });
  it('flags a label that is too long', () => {
    expect(tabLabelFits(['Home', 'A very long tab label', 'x', 'y', 'z', 'w'], 360)).toBe(false);
  });
});
