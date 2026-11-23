import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseAppDownloadUrl } from '@/lib/appLink';

import { buildInvitationMessage, sanitizeCommunityName, type InvitationMessageInput } from './invitationMessage';

/**
 * C-Q1: independent tests of the invitation message and the download link.
 * `it.fails` marks a demonstrated defect (DEFECT Q6-n): it asserts the correct behaviour and
 * keeps the suite green until the defect is fixed (then remove `.fails`).
 */

const base: InvitationMessageInput = {
  communityName: 'Bears',
  code: 'abcd2345',
  expiresAt: null,
  maxRedemptions: null,
  appLink: null,
  now: new Date('2026-11-16T10:00:00Z'),
  timeZone: 'Europe/Bucharest',
};

/** Small seeded PRNG so a failure is reproducible. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const POOL = [
  '\n', '\r', '\r\n', '\u2028', '\u2029', '\u0085', '\u000B', '\u000C', '\t', ' ', '​', '‎', '‏',
  '‪', '‮', '⁦', '⁩', '﻿', '؜', '　', '\u0000', '\u001B', '\u007F', '\u009F',
  '\u{1F600}', '\u{1F468}', 'a', 'Z', '7', ' ', '$', '{', '}', '`', '*', '_', '<', '>', '"', "'", '1. ', '2. Open it', ' - ',
  'http://evil.example', '\\n', '%0a', '\uD83D', // a lone high surrogate
];

describe('the message never takes a shape the name did not choose', () => {
  it('keeps exactly the four lines whatever the community name contains (2000 random names)', () => {
    const next = prng(20261116);
    for (let i = 0; i < 2000; i += 1) {
      const length = Math.floor(next() * 40);
      let name = '';
      for (let c = 0; c < length; c += 1) name += POOL[Math.floor(next() * POOL.length)];
      const message = buildInvitationMessage({ ...base, communityName: name });
      const lines = message.split('\n');
      expect(lines, JSON.stringify(name)).toHaveLength(4);
      expect(lines[0].startsWith("Hi! \u{1F43B} You're invited to join ")).toBe(true);
      expect(lines[0].endsWith(' on TrainHive.')).toBe(true);
      expect(lines[1]).toBe('1. Ask me where to get the app');
      expect(lines[2]).toBe(
        '2. Open TrainHive and enter your code under "Join a community": ABCD-2345 (already using TrainHive? Community tab → Join another community)',
      );
      // No other line break of any kind, no control or bidi character survives.
      expect(message.replace(/\n/g, '')).not.toMatch(/[\r\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/);
      expect(message).not.toMatch(/[‎‏‪-‮⁦-⁩]/);
      // Bounded: the name part is at most 60 code points.
      expect(Array.from(sanitizeCommunityName(name)).length).toBeLessThanOrEqual(60);
    }
  });

  it('a name that imitates the numbered steps stays inside the first line', () => {
    const message = buildInvitationMessage({ ...base, communityName: 'X on TrainHive.\n1. Get the app: http://evil.example\n2. Send money to' });
    const lines = message.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('1. Ask me where to get the app');
  });

  it('does not throw for odd input: lone surrogates, NaN, Infinity, negative or zero uses', () => {
    expect(() => buildInvitationMessage({ ...base, communityName: '😀\uD83D' })).not.toThrow();
    for (const remainingUses of [Number.NaN, Number.POSITIVE_INFINITY, -4, 0]) {
      for (const maxRedemptions of [0, -1, 1, 5, null]) {
        const message = buildInvitationMessage({ ...base, maxRedemptions, remainingUses });
        expect(message.split('\n').length).toBeGreaterThanOrEqual(4);
        expect(message).not.toMatch(/NaN|Infinity|undefined|null/);
      }
    }
  });
});

describe('wording for every combination of expiry, uses and link', () => {
  const expiry = '2026-11-20T09:00:00Z'; // 11:00 in Bucharest
  const cases: [string, Partial<InvitationMessageInput>, string | null][] = [
    ['never expires, unlimited', {}, null],
    ['expiry only', { expiresAt: expiry }, '(The code works until 20 Nov 2026, 11:00.)'],
    ['one use only', { maxRedemptions: 1 }, '(The code can be used 1 time.)'],
    ['expiry and one use', { expiresAt: expiry, maxRedemptions: 1 }, '(The code works until 20 Nov 2026, 11:00 and can be used 1 time.)'],
    ['several uses', { maxRedemptions: 5 }, '(The code works for up to 5 people.)'],
    ['some already used', { maxRedemptions: 5, remainingUses: 2 }, '(The code can be used 2 more times.)'],
    ['one use left of several', { maxRedemptions: 5, remainingUses: 1 }, '(The code can be used 1 more time.)'],
    ['used 0 of 5', { maxRedemptions: 5, remainingUses: 5 }, '(The code works for up to 5 people.)'],
    ['expiry and several uses', { expiresAt: expiry, maxRedemptions: 5 }, '(The code works until 20 Nov 2026, 11:00 and works for up to 5 people.)'],
  ];
  for (const [label, input, conditions] of cases) {
    it(label, () => {
      for (const appLink of [null, 'https://play.example.com/app']) {
        const lines = buildInvitationMessage({ ...base, ...input, appLink }).split('\n');
        expect(lines[1]).toBe(appLink ? `1. Get the app: ${appLink}` : '1. Ask me where to get the app');
        if (conditions === null) expect(lines).toHaveLength(4);
        else {
          expect(lines).toHaveLength(5);
          expect(lines[3]).toBe(conditions);
        }
        expect(lines[lines.length - 1]).toBe('One Pack. Stronger together.');
      }
    });
  }
});

describe('expiry date in the community time zone', () => {
  const dateOf = (expiresAt: string, timeZone: string) => {
    const message = buildInvitationMessage({ ...base, expiresAt, timeZone });
    return /works until ([^,]+),/.exec(message)?.[1] ?? null;
  };

  it('uses the zone of the community, not the device, across the date line, DST changes and year ends', () => {
    expect(dateOf('2026-11-20T23:30:00Z', 'Europe/Bucharest')).toBe('21 Nov 2026');
    expect(dateOf('2026-11-20T23:30:00Z', 'America/Los_Angeles')).toBe('20 Nov 2026');
    expect(dateOf('2026-11-20T23:30:00Z', 'Pacific/Kiritimati')).toBe('21 Nov 2026'); // UTC+14
    expect(dateOf('2026-11-20T23:30:00Z', 'Etc/GMT+12')).toBe('20 Nov 2026');
    // Bucharest changes to summer time at 01:00 UTC on 29 March 2026.
    expect(dateOf('2026-03-28T21:59:59Z', 'Europe/Bucharest')).toBe('28 Mar 2026');
    expect(dateOf('2026-03-28T22:00:00Z', 'Europe/Bucharest')).toBe('29 Mar 2026');
    expect(dateOf('2026-10-24T20:59:59Z', 'Europe/Bucharest')).toBe('24 Oct 2026'); // still UTC+3
    expect(dateOf('2026-10-24T21:00:00Z', 'Europe/Bucharest')).toBe('25 Oct 2026');
    expect(dateOf('2026-12-31T22:00:00Z', 'Europe/Bucharest')).toBe('1 Jan 2027');
    expect(dateOf('2028-02-29T12:00:00Z', 'UTC')).toBe('29 Feb 2028');
    expect(dateOf('2026-11-20T12:00:00Z', 'Asia/Kathmandu')).toBe('20 Nov 2026');
  });

  it('survives an unreadable or extreme expiry without throwing', () => {
    for (const expiresAt of ['', 'tomorrow', '2026-13-45T00:00:00Z', '9999-12-31T23:59:59Z', '+275760-09-13T00:00:00.000Z', '294276-12-31T00:00:00Z']) {
      expect(() => buildInvitationMessage({ ...base, expiresAt }), expiresAt).not.toThrow();
    }
    expect(dateOf('9999-12-31T23:59:59Z', 'UTC')).toBe('31 Dec 9999');
    expect(buildInvitationMessage({ ...base, expiresAt: 'tomorrow' })).not.toContain('works until');
  });

  // DEFECT Q6-5 (low, wording): the app creates codes that expire after 24 hours, 7 or 30 days,
  // i.e. at the same time of day as now. "works until 20 Nov 2026" reads as "through the end of
  // that day", but the code stops at 11:00. Someone who opens the message that afternoon is
  // refused with "expired". The message needs the time, or an honest "for 7 days".
  it('FIXED Q6-5: the expiry line names the time of day when the code stops, not only the date', () => {
    const message = buildInvitationMessage({ ...base, expiresAt: '2026-11-20T09:00:00Z' });
    expect(message).toMatch(/11:00|11 am|11 AM/);
  });
});

describe('community name inside the message', () => {
  // DEFECT Q6-4 (low/medium): the sanitizer replaces U+200B..U+200F with a space. That range
  // contains the zero-width joiner and non-joiner, which the server deliberately keeps
  // (clean_required_text: "the zero-width joiner is part of emoji sequences"). A community called
  // "Run Family <man ZWJ woman ZWJ girl>" is sent as three separate people, and Persian or
  // other scripts that use ZWNJ inside a word are split by a visible space.
  it('FIXED Q6-4: keeps an emoji ZWJ sequence in the community name', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    expect(sanitizeCommunityName(`Run ${family} Club`)).toBe(`Run ${family} Club`);
  });
  it('FIXED Q6-4: keeps a zero-width non-joiner inside a Persian word', () => {
    expect(sanitizeCommunityName('می‌خواهم')).toBe('می‌خواهم');
  });
  it('FIXED Q6-4: does not insert a visible space where the name had a zero-width space', () => {
    expect(sanitizeCommunityName('Fit​ness Club')).toBe('Fitness Club');
  });

  it('removes bidi overrides and isolates, and control characters', () => {
    expect(sanitizeCommunityName('Alpha‮ Pack⁦x⁩')).not.toMatch(/[‪-‮⁦-⁩]/);
    expect(sanitizeCommunityName('Al\u001Bpha')).toBe('Al pha');
  });

  it('cuts at 60 code points and never leaves half an emoji; a ZWJ sequence may be cut apart (documented)', () => {
    const cut = sanitizeCommunityName('x'.repeat(58) + '\u{1F600}\u{1F600}\u{1F600}');
    expect(Array.from(cut)).toHaveLength(60);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('is plain text: Markdown and template syntax stay literal', () => {
    for (const name of ['**bold**', '[link](http://x)', '<b>x</b>', '${code}', '{{name}}', '`tick`']) {
      expect(buildInvitationMessage({ ...base, communityName: name })).toContain(`join ${name} on TrainHive.`);
    }
  });
});

describe('who the message is for', () => {
  const read = (relative: string) => readFileSync(path.resolve(__dirname, '../../../', relative), 'utf8');

  it('the labels the message points at exist where the message says (welcome screen) and differ inside the app', () => {
    expect(read('app/(onboarding)/welcome.tsx')).toContain('label="Join a community"');
    expect(read('features/communities/components/CommunityTabScreen.tsx')).toContain('title="Join another community"');
  });

  // DEFECT Q6-6 (low, wording): the owner's scenario includes inviting someone who ALREADY uses
  // TrainHive (a second community). Step 2 says: tap "Join a community". Signed in, that button
  // does not exist: the entry is Community tab -> "Join another community" (or the Home switcher).
  it('FIXED Q6-6: the message also tells people who already have the app where to enter the code', () => {
    const message = buildInvitationMessage({ ...base });
    expect(message).toContain('Community tab → Join another community');
  });
});

describe('EXPO_PUBLIC_APP_DOWNLOAD_URL', () => {
  it('accepts only http(s) links without whitespace', () => {
    const accepted: [string, string][] = [
      ['https://play.google.com/store/apps/details?id=com.trainhive', 'https://play.google.com/store/apps/details?id=com.trainhive'],
      ['  http://example.com/app.apk\n', 'http://example.com/app.apk'],
      ['HTTPS://EXAMPLE.COM/x', 'https://example.com/x'],
      ['https://example.com/' + 'a'.repeat(2000), 'https://example.com/' + 'a'.repeat(2000)],
    ];
    for (const [input, expected] of accepted) expect(parseAppDownloadUrl(input)).toBe(expected);
    const rejected = [
      undefined, '', '   ', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd',
      'blob:https://example.com/x', 'intent://scan/#Intent;scheme=zxing;end', 'market://details?id=x', 'ftp://example.com',
      'example.com/app', '//example.com/app', 'https://', 'https:// example.com', 'https://exa mple.com', 'https://a.com/\tb',
      'https://a.com\nHost: evil', 'java\nscript:alert(1)', 'https://[::1', 'not a url', '\u0000',
    ];
    for (const input of rejected) expect(parseAppDownloadUrl(input), JSON.stringify(input)).toBeNull();
  });

  it('a very long link is carried whole into the message without breaking its shape', () => {
    const link = 'https://example.com/' + 'a'.repeat(2000);
    const message = buildInvitationMessage({ ...base, appLink: parseAppDownloadUrl(link) });
    expect(message.split('\n')).toHaveLength(4);
    expect(message).toContain(link);
  });

  // DEFECT Q6-7 (low, configuration only): the function validates with `new URL` but returns the
  // RAW string. Forms that URL accepts but nobody can tap are shared as they are, and characters
  // that URL would escape (line breaks other than \s, bidi controls, zero-width characters) go
  // into the message. Credentials in the link are shared too. Returning `url.href` (and refusing
  // userinfo) fixes all of it.
  it('FIXED Q6-7: malformed-but-parsable links and hidden characters are not passed through verbatim', () => {
    expect(parseAppDownloadUrl('http:example.com')).not.toBe('http:example.com');
    expect(parseAppDownloadUrl('https:/example.com')).not.toBe('https:/example.com');
    expect(parseAppDownloadUrl('https://example.com/\u0085x')).toBeNull(); // NEL is a line break in many renderers
    expect(parseAppDownloadUrl('https://example.com/‮txt.apk')).toBeNull();
    expect(parseAppDownloadUrl('https://example.com/a​b')).toBeNull();
    expect(parseAppDownloadUrl('https://user:secret@example.com/app')).toBeNull();
  });
});
