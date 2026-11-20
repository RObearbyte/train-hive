import { describe, expect, it } from 'vitest';

import { activeNavKey } from '@/features/shell/domain/navItems';
import { titleForPath } from '@/features/shell/domain/pageTitle';

import { bellAccessibilityLabel, bellBadgeText } from './bell';
import { parseAppLink, targetFromPushData } from './deepLink';
import { redirectFor } from './legacyRoutes';
import { combinedUnreadCount } from './unread';

const ID = '123e4567-e89b-12d3-a456-426614174000';

describe('Q8 deep links and routes after P2', () => {
  it('database-allowed links stay accepted, each push payload shape resolves, hostile ones do not', () => {
    for (const link of ['/activity', `/trainings/${ID}`, `/announcements/${ID}`]) expect(parseAppLink(link), link).not.toBeNull();
    expect(targetFromPushData({ deepLink: '/activity', notificationId: ID }).href).toBe('/activity');
    expect(targetFromPushData({ url: `/trainings/${ID}` }).href).toBe(`/trainings/${ID}`);
    const hostile = [
      '/notifications', '/activity/', '/activity?x=1', '//evil.com', 'https://evil.com', `/trainings/${ID}/edit`,
      `/trainings/${ID}?a=b`, `/trainings/${ID}#x`, '/trainings/new', '/members', '/invitations', '/privacy',
      `/trainings/../${ID}`, '/ACTIVITY', ' /activity', '/activity\n', `/announcements/${ID}/edit`, '/announcements/new',
      'javascript:alert(1)',
    ];
    for (const raw of hostile) expect(parseAppLink(raw), raw).toBeNull();
    expect(targetFromPushData({ deepLink: 'https://evil.com', url: '/members' }).href).toBeNull();
    expect(targetFromPushData(null).href).toBeNull();
    expect(targetFromPushData('/activity').href).toBeNull();
  });

  it('/activity redirects to the notification centre; nothing else moved', () => {
    expect(redirectFor('/activity')).toBe('/notifications');
    expect(redirectFor('/activity/')).toBe('/notifications');
    expect(redirectFor('/notifications')).toBeNull();
    expect(redirectFor('/activity/x')).toBeNull();
  });

  it('every route has a sidebar owner and a page title', () => {
    const routes: [string, string][] = [
      ['/', 'home'], ['/notifications', 'communications'], ['/activity', 'communications'], ['/announcements', 'communications'], [`/announcements/${ID}`, 'communications'],
      ['/trainings', 'trainings'], [`/trainings/${ID}/edit`, 'trainings'], ['/statistics', 'statistics'], ['/profile', 'profile'],
      ['/members', 'profile'], ['/privacy', 'profile'], ['/invitations', 'profile'], ['/community-settings', 'profile'],
      ['/attendance-history', 'profile'], ['/add-community/join-code', 'profile'],
    ];
    for (const [path, key] of routes) {
      expect(activeNavKey(path), path).toBe(key);
      expect(titleForPath(path), path).not.toBe('TrainHive');
    }
  });
});

describe('Q8 bell badge', () => {
  it('shows 1..9, "9+" above, hides 0 / negative / NaN, and speaks the real number', () => {
    expect([0, 1, 9, 10, 100, -3, Number.NaN, Infinity, 9.9].map(bellBadgeText)).toEqual([null, '1', '9', '9+', '9+', null, null, null, '9']);
    expect(bellAccessibilityLabel(120)).toBe('Notifications, 120 unread');
    expect(bellAccessibilityLabel(0)).toBe('Notifications');
  });

  it('counts an announcement and its notification once, ignores other communities, and is 0 once read state arrives', () => {
    const ann = (id: string, community: string) => ({ id, community_id: community, status: 'published', author_id: 'x' }) as never;
    const note = (id: string, community: string, announcement: string | null, read: string | null) =>
      ({ id, community_id: community, related_announcement_id: announcement, read_at: read }) as never;
    const base = { userId: 'me', communityId: 'c1' };
    expect(combinedUnreadCount({ ...base, items: [ann('a1', 'c1')], readIds: [], notifications: [note('n1', 'c1', 'a1', null)] })).toBe(1);
    expect(combinedUnreadCount({ ...base, items: [ann('a2', 'c2')], readIds: [], notifications: [note('n2', 'c2', null, null)] })).toBe(0);
    expect(combinedUnreadCount({ ...base, items: [ann('a1', 'c1')], readIds: ['a1'], notifications: [note('n1', 'c1', 'a1', '2026-01-01')] })).toBe(0);
  });
});
