import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { hrefForLink, parseAppLink, targetFromPushData } from './deepLink';
import { createNavigationQueue } from './navigationQueue';

/**
 * C-Q1: hostile notification payloads, and the navigation queue the community switch relies on.
 * `it.fails` marks a demonstrated defect (DEFECT Q6-n).
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

describe('navigation queue, the part the notification community switch relies on', () => {
  it('delivers a held tap once, on the next ready signal, and ignores a repeat of the same notification', () => {
    const navigate = vi.fn();
    const queue = createNavigationQueue(navigate);
    expect(queue.offer({ id: 'n1', href: '/activity' })).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    queue.setReady(true);
    queue.setReady(true);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(queue.offer({ id: 'n1', href: '/activity' })).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('keeps only the latest of several taps while not ready', () => {
    const navigate = vi.fn();
    const queue = createNavigationQueue(navigate);
    queue.offer({ id: 'n1', href: '/activity' });
    queue.offer({ id: 'n2', href: `/trainings/${ID}` });
    queue.setReady(true);
    expect(navigate.mock.calls).toEqual([[`/trainings/${ID}`]]);
  });

  // Evidence for DEFECT Q6-9 (by reading, `useNotificationLinks.ts:93-99` and `:63-66`): the
  // tap handler calls `queue.setReady(false)` and then selects the other community. The queue is
  // told "ready" again only by an effect that depends on `ready`. When the target community's
  // detail is already cached (the user was in it earlier in the session), `ready` goes
  // true -> true in the same render, the effect does not run, and the tap stays queued: it is
  // delivered by the next unrelated false -> true change, possibly much later. This test shows the
  // queue half of that: it does not deliver on its own.
  it('after setReady(false) a held tap waits for an explicit setReady(true), however long that takes', () => {
    const navigate = vi.fn();
    const queue = createNavigationQueue(navigate);
    queue.setReady(true);
    queue.setReady(false); // what the tap handler does before switching
    queue.offer({ id: 'n9', href: `/trainings/${ID}` });
    expect(navigate).not.toHaveBeenCalled();
    queue.offer({ id: 'n10', href: '/activity' }); // later taps pile up behind it
    expect(navigate).not.toHaveBeenCalled();
    queue.setReady(true); // the unrelated future event
    expect(navigate.mock.calls).toEqual([['/activity']]); // the earlier tap was silently replaced
  });
});

describe('screens that decide organizer rights', () => {
  const src = (relative: string) => readFileSync(path.resolve(__dirname, '../../../', relative), 'utf8');

  // DEFECT Q6-10 (low/medium, source check): `trainings/[id].tsx` takes `isOrganizer` from the
  // ACTIVE community. A training of another community can be on screen (a notification tap whose
  // community lookup failed, a screen left in the navigation stack when a notification switched
  // communities, a hand-built link). The organizer controls then follow the wrong community:
  // organizer of A, member of B, opening B's training shows "record attendance" (the server
  // answers forbidden), and the reverse hides controls an organizer of B should have. The check
  // needed is `session.community_id === community.id`.
  it.fails('DEFECT Q6-10: the training screen ties organizer controls to the training\'s own community', () => {
    const source = src('app/(app)/trainings/[id].tsx');
    expect(source).toMatch(/community_id/);
  });
});
