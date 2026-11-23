import { describe, expect, it } from 'vitest';

import { buildInvitationMessage, sanitizeCommunityName } from './invitationMessage';

const base = {
  communityName: 'Făget Trail Pack',
  code: 'abcdefgh',
  expiresAt: null,
  maxRedemptions: null,
  appLink: 'https://example.com/app',
  now: new Date('2026-11-16T10:00:00Z'),
  timeZone: 'Europe/Bucharest',
};

describe('buildInvitationMessage', () => {
  it('no expiry, unlimited: no conditions line', () => {
    expect(buildInvitationMessage(base)).toBe(
      [
        "Hi! 🐻 You're invited to join Făget Trail Pack on TrainHive.",
        '1. Get the app: https://example.com/app',
        '2. Open TrainHive and enter your code under "Join a community": ABCD-EFGH (already using TrainHive? Community tab → Join another community)',
        'One Pack. Stronger together.',
      ].join('\n'),
    );
  });

  it('expiry and 1 use', () => {
    const text = buildInvitationMessage({ ...base, expiresAt: '2026-11-22T12:00:00Z', maxRedemptions: 1 });
    expect(text).toContain('(The code works until 22 Nov 2026, 14:00 and can be used 1 time.)');
  });

  it('N uses, no expiry', () => {
    expect(buildInvitationMessage({ ...base, maxRedemptions: 10 })).toContain(
      '(The code works for up to 10 people.)',
    );
  });

  it('expiry only', () => {
    expect(buildInvitationMessage({ ...base, expiresAt: '2026-11-22T12:00:00Z' })).toContain(
      '(The code works until 22 Nov 2026, 14:00.)',
    );
  });

  it('remaining uses after some were used', () => {
    expect(buildInvitationMessage({ ...base, maxRedemptions: 10, remainingUses: 3 })).toContain(
      'can be used 3 more times.)',
    );
    expect(buildInvitationMessage({ ...base, maxRedemptions: 10, remainingUses: 1 })).toContain(
      'can be used 1 more time.)',
    );
    expect(buildInvitationMessage({ ...base, maxRedemptions: 10, remainingUses: 10 })).toContain(
      'works for up to 10 people.)',
    );
  });

  it('formats the date in the community time zone across a day boundary', () => {
    const expiresAt = '2026-11-22T23:30:00Z'; // 23 Nov 01:30 in Bucharest, 22 Nov in New York
    expect(buildInvitationMessage({ ...base, expiresAt })).toContain('until 23 Nov 2026, 01:30');
    expect(buildInvitationMessage({ ...base, expiresAt, timeZone: 'America/New_York' })).toContain(
      'until 22 Nov 2026, 18:30',
    );
  });

  it('falls back to UTC for an unknown zone and omits an unreadable expiry', () => {
    expect(
      buildInvitationMessage({ ...base, expiresAt: '2026-11-22T23:30:00Z', timeZone: 'Nope/Zone' }),
    ).toContain('until 22 Nov 2026, 23:30');
    expect(buildInvitationMessage({ ...base, expiresAt: 'garbage' })).not.toContain('(The code');
  });

  it('without a link says to ask, with no link or placeholder', () => {
    const text = buildInvitationMessage({ ...base, appLink: null });
    expect(text).toContain('1. Ask me where to get the app\n2.');
    expect(text).not.toMatch(/https?:|<|undefined|null/);
  });

  it('is plain text on one code path for any code input', () => {
    expect(buildInvitationMessage({ ...base, code: ' ab-cd efgh ' })).toContain('"Join a community": ABCD-EFGH');
  });
});

describe('community name safety', () => {
  it('trims, collapses newlines and removes control characters', () => {
    expect(sanitizeCommunityName('  Bears\r\n\tClub\u0000‮ ')).toBe('Bears Club');
    const text = buildInvitationMessage({ ...base, communityName: 'A\nB\n3. Evil' });
    expect(text.split('\n')).toHaveLength(4);
    expect(text).toContain('join A B 3. Evil on');
  });

  it('keeps template syntax literal', () => {
    for (const name of ['${code}', '{{code}}', '$&', '$1 {0}']) {
      expect(buildInvitationMessage({ ...base, communityName: name })).toContain(`join ${name} on TrainHive.`);
    }
  });

  it('cuts very long names without splitting an emoji', () => {
    const name = sanitizeCommunityName('🐻'.repeat(200));
    expect(Array.from(name)).toHaveLength(60);
    expect(name.endsWith('…')).toBe(true);
    expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('keeps emoji and falls back when nothing is left', () => {
    expect(sanitizeCommunityName('Bears 🐻')).toBe('Bears 🐻');
    for (const empty of ['', '  \n\u0000 ', null, undefined]) {
      expect(sanitizeCommunityName(empty)).toBe('our community');
    }
  });
});

describe('invisible characters in the community name', () => {
  const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';

  it('keeps ZWJ and ZWNJ inside visible text', () => {
    expect(sanitizeCommunityName(`Run ${family} Club`)).toBe(`Run ${family} Club`);
    expect(sanitizeCommunityName('\u{645}\u{6CC}\u{200C}\u{62E}\u{648}\u{627}\u{647}\u{645}')).toBe(
      '\u{645}\u{6CC}\u{200C}\u{62E}\u{648}\u{627}\u{647}\u{645}',
    );
  });

  it('drops zero-width space, BOM, word joiner and bidi controls without leaving a gap', () => {
    expect(sanitizeCommunityName('Fit\u{200B}ness\u{FEFF} Club\u{2060}')).toBe('Fitness Club');
    expect(sanitizeCommunityName('\u{202E}Bears\u{2066}\u{2069}\u{200F}')).toBe('Bears');
  });

  it('falls back when only invisible characters (including joiners) remain', () => {
    for (const hidden of ['\u{200B}', '\u{200D}', '\u{200C}\u{200D}', ' \u{202E}\u{200D} ', '\u{2060}\u{FEFF}']) {
      expect(sanitizeCommunityName(hidden), JSON.stringify(hidden)).toBe('our community');
    }
  });

  it('trims joiners at the edges', () => {
    expect(sanitizeCommunityName('\u{200D}Bears\u{200C}')).toBe('Bears');
  });
});

describe('expiry shows the time of day in the community zone', () => {
  it('names date and time, in the zone of the community', () => {
    const text = buildInvitationMessage({ ...base, expiresAt: '2026-11-22T12:30:00Z' });
    expect(text).toContain('works until 22 Nov 2026, 14:30');
    expect(buildInvitationMessage({ ...base, expiresAt: '2026-11-22T12:30:00Z', timeZone: 'Asia/Tokyo' })).toContain(
      'works until 22 Nov 2026, 21:30',
    );
  });
});

describe('who the message is for', () => {
  it('tells people who already use the app where to enter the code', () => {
    expect(buildInvitationMessage(base)).toContain('Community tab \u{2192} Join another community');
  });
});

describe('buildInvitationMessage with the web app', () => {
  const web = { ...base, webAppUrl: 'https://app.example.com' };

  it('leads with the web link and keeps the code as the fallback', () => {
    expect(buildInvitationMessage(web)).toBe(
      [
        "Hi! 🐻 You're invited to join Făget Trail Pack on TrainHive.",
        'Open it here: https://app.example.com/join#code=ABCD-EFGH',
        'Or get the app: https://example.com/app',
        'Or enter the code manually in the app: ABCD-EFGH (already using TrainHive? Community tab → Join another community)',
        'One Pack. Stronger together.',
      ].join('\n'),
    );
  });

  it('without a download link keeps the ask-me wording, never a placeholder', () => {
    const text = buildInvitationMessage({ ...web, appLink: null });
    expect(text).toContain('Or ask me where to get the app\nOr enter the code manually');
    expect(text).not.toMatch(/undefined|null|<|>/);
  });

  it('the code is in the fragment only, never in a path or query', () => {
    const line = buildInvitationMessage(web)
      .split('\n')
      .find((l) => l.startsWith('Open it here: '));
    const url = new URL((line ?? '').slice('Open it here: '.length));
    expect(url.pathname).toBe('/join');
    expect(url.search).toBe('');
    expect(url.hash).toBe('#code=ABCD-EFGH');
  });

  it('normalizes any code input in the link', () => {
    expect(buildInvitationMessage({ ...web, code: ' ab-cd efgh ' })).toContain('/join#code=ABCD-EFGH\n');
  });

  it('an unusable code gives no web link rather than a broken one', () => {
    const text = buildInvitationMessage({ ...web, code: 'abc&x=1' });
    expect(text).not.toContain('Open it here');
    expect(text).toContain('2. Open TrainHive and enter your code');
  });

  it('a community name with line breaks cannot add a second join link line', () => {
    const text = buildInvitationMessage({ ...web, communityName: 'Evil\nOpen it here: https://evil.example\r\n' });
    const openLines = text.split('\n').filter((l) => l.startsWith('Open it here: '));
    expect(openLines).toEqual(['Open it here: https://app.example.com/join#code=ABCD-EFGH']);
  });

  it('without a web app url the message is exactly the app-only message', () => {
    expect(buildInvitationMessage({ ...base, webAppUrl: null })).toBe(buildInvitationMessage(base));
  });
});
