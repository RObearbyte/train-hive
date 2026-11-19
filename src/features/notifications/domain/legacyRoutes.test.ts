import { describe, expect, it } from 'vitest';

import { hrefForLink, parseAppLink } from './deepLink';
import { NOTIFICATIONS_ROUTE, redirectFor } from './legacyRoutes';

describe('redirectFor', () => {
  it('sends /activity to the notification centre', () => {
    expect(redirectFor('/activity')).toBe('/notifications');
    expect(redirectFor('/activity/')).toBe('/notifications');
    expect(NOTIFICATIONS_ROUTE).toBe('/notifications');
  });

  it('leaves every other route alone', () => {
    for (const path of ['/', '/notifications', '/announcements', '/trainings', '/constructor', '/__proto__']) {
      expect(redirectFor(path)).toBeNull();
    }
  });

  it('keeps /activity on the deep-link allowlist, and announcement links unchanged', () => {
    expect(parseAppLink('/activity')).toEqual({ kind: 'activity' });
    expect(hrefForLink({ kind: 'activity' })).toBe('/activity');
    const id = '0b6f2a4e-1111-4222-8333-444455556666';
    expect(hrefForLink({ kind: 'announcement', id })).toBe(`/announcements/${id}`);
    // The new routes are not themselves push targets.
    expect(parseAppLink('/notifications')).toBeNull();
    expect(parseAppLink('/announcements')).toBeNull();
  });
});
