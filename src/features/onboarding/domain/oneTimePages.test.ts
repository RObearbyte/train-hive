import { describe, expect, it } from 'vitest';

import { nextOneTimePage, pathOf, routeOf, seenOf } from './oneTimePages';

const BASE = { isAnonymous: true, secureSeen: false, aboutYouSeen: false, hasCommunity: true } as const;

describe('nextOneTimePage', () => {
  it('shows the secure page first, then About you, then nothing', () => {
    expect(nextOneTimePage(BASE)).toBe('secure-account');
    expect(nextOneTimePage({ ...BASE, secureSeen: true })).toBe('about-you');
    expect(nextOneTimePage({ ...BASE, secureSeen: true, aboutYouSeen: true })).toBe('none');
  });

  it('never shows the secure page to a linked account, but About you still comes', () => {
    expect(nextOneTimePage({ ...BASE, isAnonymous: false })).toBe('about-you');
    expect(nextOneTimePage({ ...BASE, isAnonymous: false, aboutYouSeen: true })).toBe('none');
    // Even while its own note is unread: a linked account does not wait for it.
    expect(nextOneTimePage({ ...BASE, isAnonymous: false, secureSeen: undefined })).toBe('about-you');
  });

  it('shows nothing without a community', () => {
    expect(nextOneTimePage({ ...BASE, hasCommunity: false })).toBe('none');
  });

  it('waits while a device note is read, so About you never jumps the queue', () => {
    expect(nextOneTimePage({ ...BASE, secureSeen: undefined })).toBe('wait');
    expect(nextOneTimePage({ ...BASE, secureSeen: true, aboutYouSeen: undefined })).toBe('wait');
    expect(nextOneTimePage({ ...BASE, secureSeen: undefined, aboutYouSeen: true })).toBe('wait');
  });

  it('a failed read pushes nothing on the person, and the other page still queues', () => {
    expect(nextOneTimePage({ ...BASE, secureSeen: null })).toBe('about-you');
    expect(nextOneTimePage({ ...BASE, secureSeen: true, aboutYouSeen: null })).toBe('none');
  });

  it('terminates: marking each page seen in turn ends in none (no loop)', () => {
    const seen = { secure: false, about: false };
    const order: string[] = [];
    for (let i = 0; i < 5; i++) {
      const next = nextOneTimePage({ isAnonymous: true, secureSeen: seen.secure, aboutYouSeen: seen.about, hasCommunity: true });
      if (next === 'none') break;
      order.push(next);
      if (next === 'secure-account') seen.secure = true;
      if (next === 'about-you') seen.about = true;
    }
    expect(order).toEqual(['secure-account', 'about-you']);
  });
});

describe('helpers', () => {
  it('maps a prompt state to the seen value', () => {
    expect(seenOf('checking')).toBeUndefined();
    expect(seenOf('show')).toBe(false);
    expect(seenOf('done')).toBe(true);
  });
  it('routes and paths', () => {
    expect(routeOf('secure-account')).toBe('/secure-account');
    expect(routeOf('about-you')).toBe('/about-you?welcome=1');
    expect(pathOf('about-you')).toBe('/about-you');
  });
});
