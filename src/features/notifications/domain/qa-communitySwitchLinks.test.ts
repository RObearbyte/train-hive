import { describe, expect, it } from 'vitest';

import { hrefForLink, parseAppLink, targetFromPushData } from './deepLink';

/**
 * C-Q1: hostile notification payloads. The community switch on a tap is covered in
 * `notificationNavigation.test.ts` (Q6-9) and the organizer rights of a training in
 * `features/community/domain/sessionAccess.test.ts` (Q6-10).
 */

const ID = '0f0f0f0f-0000-4000-8000-00000000000a';
const ALLOWED = new RegExp(`^(/activity|/trainings/${ID.replace(/[0-9a-f]/g, '[0-9a-f]')}|/announcements/${ID.replace(/[0-9a-f]/g, '[0-9a-f]')})$`);

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('a hostile push payload can only reach the allowlist', () => {
  it('rejects every classic way of leaving it', () => {
    const attacks = [
      'https://evil.example/', 'http://evil.example', '//evil.example/x', 'javascript:alert(1)', 'data:text/html,x', 'trainhive://trainings/' + ID,
      `/trainings/${ID}/../../invitations`, `/trainings/${ID}/`, `/trainings/${ID}?x=1`, `/trainings/${ID}#frag`, `/trainings/${ID}\n`,
      ` /trainings/${ID}`, `/trainings/${ID} `, `/Trainings/${ID}`, `/trainings/../invitations`, `/trainings/${ID}/edit`, `/trainings//${ID}`,
      `\\trainings\\${ID}`, `/trainings/${ID.slice(0, -1)}`, `/trainings/${ID}0`, `/trainings/%2e%2e/${ID}`, `/(app)/invitations`, '/invitations',
      '/community-settings', '/add-community/creator-code', '/profile', '/activity/', '/activity?x', '/ACTIVITY', '', '/', '..', null, undefined, 0, true, {}, [], ['/activity'],
    ];
    for (const attack of attacks) {
      expect(parseAppLink(attack), JSON.stringify(attack)).toBeNull();
      expect(targetFromPushData({ url: attack }).href, JSON.stringify(attack)).toBeNull();
      expect(targetFromPushData({ deepLink: attack, url: attack }).href).toBeNull();
    }
  });

  it('only builds hrefs from validated parts: 3000 random payloads', () => {
    const next = prng(7);
    const junk = ['/activity', `/trainings/${ID}`, `/announcements/${ID}`, '/x', ID, '..', '?', '#', '//', 'http://', '\n', '%2e', '', ' '];
    const pick = () => junk[Math.floor(next() * junk.length)];
    for (let i = 0; i < 3000; i += 1) {
      const value = pick() + pick() + (next() < 0.5 ? pick() : '');
      const payload = next() < 0.5 ? { url: value } : { deepLink: value, url: pick(), notification_id: pick() };
      const { href, notificationId } = targetFromPushData(payload);
      if (href !== null) expect(href, JSON.stringify(payload)).toMatch(ALLOWED);
      if (notificationId !== null) expect(notificationId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('survives prototype tricks and non-object data', () => {
    const polluted = JSON.parse('{"__proto__":{"url":"/activity"},"constructor":{"url":"/activity"}}');
    expect(targetFromPushData(polluted).href).toBeNull();
    for (const data of [null, undefined, 'x', 5, [], [1], () => 1, Symbol.iterator]) {
      expect(targetFromPushData(data)).toEqual({ href: null, notificationId: null });
    }
    expect(Object.prototype).not.toHaveProperty('url');
  });

  it('a payload may name any notification id, but it is only used to look the community up on the server; the id must be a UUID', () => {
    expect(targetFromPushData({ url: '/activity', notification_id: "x'; drop table notifications;--" }).notificationId).toBeNull();
    expect(targetFromPushData({ url: '/activity', notification_id: ID.toUpperCase() }).notificationId).toBe(ID);
    expect(targetFromPushData({ url: '/activity', notificationId: ID }).notificationId).toBe(ID);
    expect(hrefForLink({ kind: 'training', id: ID })).toBe(`/trainings/${ID}`);
  });
});
