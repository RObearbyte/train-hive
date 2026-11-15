import { describe, expect, it } from 'vitest';

import { hrefForLink, parseAppLink, targetFromPushData } from './deepLink';

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

describe('parseAppLink', () => {
  it('accepts the allowlisted routes', () => {
    expect(parseAppLink(`/trainings/${ID}`)).toEqual({ kind: 'training', id: ID });
    expect(parseAppLink(`/announcements/${ID}`)).toEqual({ kind: 'announcement', id: ID });
    expect(parseAppLink('/activity')).toEqual({ kind: 'activity' });
  });

  it('normalizes the id to lower case', () => {
    expect(parseAppLink(`/trainings/${ID.toUpperCase()}`)).toEqual({ kind: 'training', id: ID });
  });

  it.each([
    'https://evil.example/trainings/' + ID,
    'trainhive://trainings/' + ID,
    `//evil.example/trainings/${ID}`,
    `/trainings/${ID}?next=/profile`,
    `/trainings/${ID}#x`,
    `/trainings/${ID}/edit`,
    `/trainings/${ID}/`,
    `trainings/${ID}`,
    '/trainings/not-a-uuid',
    '/trainings/',
    '/trainings',
    '/profile',
    '/invitations',
    '/activity/',
    '/activity?x=1',
    '/../activity',
    `/trainings/..%2F${ID}`,
    '',
    ' /activity',
  ])('rejects %s', (raw) => {
    expect(parseAppLink(raw)).toBeNull();
  });

  it.each([null, undefined, 5, {}, [], true])('rejects a non-string (%s)', (raw) => {
    expect(parseAppLink(raw)).toBeNull();
  });
});

describe('hrefForLink', () => {
  it('builds routes from validated parts', () => {
    expect(hrefForLink({ kind: 'training', id: ID })).toBe(`/trainings/${ID}`);
    expect(hrefForLink({ kind: 'announcement', id: ID })).toBe(`/announcements/${ID}`);
    expect(hrefForLink({ kind: 'activity' })).toBe('/activity');
  });
});

describe('targetFromPushData', () => {
  it('reads the contract payload { url, notification_id, kind }', () => {
    expect(
      targetFromPushData({ url: `/trainings/${ID}`, notification_id: ID, kind: 'training_created' }),
    ).toEqual({ href: `/trainings/${ID}`, notificationId: ID });
  });

  it('accepts deepLink and prefers it over url', () => {
    expect(targetFromPushData({ deepLink: '/activity', url: `/trainings/${ID}` }).href).toBe(
      '/activity',
    );
  });

  it('falls back to url when deepLink is not allowed', () => {
    expect(targetFromPushData({ deepLink: 'https://evil.example', url: '/activity' }).href).toBe(
      '/activity',
    );
  });

  it('returns no target for hostile or missing data', () => {
    expect(targetFromPushData({ url: 'https://evil.example' })).toEqual({
      href: null,
      notificationId: null,
    });
    expect(targetFromPushData(null)).toEqual({ href: null, notificationId: null });
    expect(targetFromPushData('x')).toEqual({ href: null, notificationId: null });
  });

  it('ignores a notification id that is not a uuid', () => {
    expect(targetFromPushData({ url: '/activity', notification_id: 'abc' }).notificationId).toBeNull();
  });
});
