import { describe, expect, it } from 'vitest';

import { announcement, notification } from './testFixtures';
import { badgeText, combinedUnreadCount, isAnnouncementUnread, unreadAnnouncements } from './unread';

describe('unreadAnnouncements', () => {
  it('lists published, unread ones I did not write', () => {
    const items = [
      announcement({ id: 'a1' }),
      announcement({ id: 'a2' }),
      announcement({ id: 'a3', author_id: 'me' }),
      announcement({ id: 'a4', status: 'scheduled', published_at: null, scheduled_for: '2027-01-01T00:00:00Z' }),
    ];
    expect(unreadAnnouncements(items, ['a2'], 'me').map((a) => a.id)).toEqual(['a1']);
  });

  it('isAnnouncementUnread follows the same rule', () => {
    expect(isAnnouncementUnread(announcement(), [], 'me')).toBe(true);
    expect(isAnnouncementUnread(announcement(), ['a1'], 'me')).toBe(false);
  });
});

describe('combinedUnreadCount', () => {
  it('adds unread notifications and unread announcements', () => {
    expect(
      combinedUnreadCount({
        items: [announcement({ id: 'a1' })],
        readIds: [],
        notifications: [notification({ id: 'n1' }), notification({ id: 'n2', read_at: '2026-11-10T11:00:00Z' })],
        userId: 'me',
      }),
    ).toBe(2);
  });

  it('counts an announcement and its own unread notification once', () => {
    expect(
      combinedUnreadCount({
        items: [announcement({ id: 'a1' })],
        readIds: [],
        notifications: [
          notification({
            id: 'n1',
            kind: 'announcement_published',
            related_session_id: null,
            related_announcement_id: 'a1',
          }),
        ],
        userId: 'me',
      }),
    ).toBe(1);
  });

  it('is zero when everything is read', () => {
    expect(
      combinedUnreadCount({
        items: [announcement()],
        readIds: ['a1'],
        notifications: [notification({ read_at: '2026-11-10T11:00:00Z' })],
        userId: 'me',
      }),
    ).toBe(0);
  });
});

describe('combinedUnreadCount community scope', () => {
  it('ignores items of other communities', () => {
    expect(
      combinedUnreadCount({
        items: [announcement({ id: 'a1' }), announcement({ id: 'a2', community_id: 'c2' })],
        readIds: [],
        notifications: [notification({ id: 'n1' }), notification({ id: 'n2', community_id: 'c2' })],
        userId: 'me',
        communityId: 'c1',
      }),
    ).toBe(2);
  });
});

describe('badgeText', () => {
  it('hides zero, caps at 99+', () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(-3)).toBeNull();
    expect(badgeText(7)).toBe('7');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });
});
