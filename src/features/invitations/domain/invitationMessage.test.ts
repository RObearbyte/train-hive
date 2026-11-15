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
        '2. Open it, tap "Join a community" and enter your code: ABCD-EFGH',
        'One Pack. Stronger together.',
      ].join('\n'),
    );
  });

  it('expiry and 1 use', () => {
    const text = buildInvitationMessage({ ...base, expiresAt: '2026-11-22T12:00:00Z', maxRedemptions: 1 });
    expect(text).toContain('(The code works until 22 Nov 2026 and can be used 1 time.)');
  });

  it('N uses, no expiry', () => {
    expect(buildInvitationMessage({ ...base, maxRedemptions: 10 })).toContain(
      '(The code works for up to 10 people.)',
    );
  });

  it('expiry only', () => {
    expect(buildInvitationMessage({ ...base, expiresAt: '2026-11-22T12:00:00Z' })).toContain(
      '(The code works until 22 Nov 2026.)',
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
    expect(buildInvitationMessage({ ...base, expiresAt })).toContain('until 23 Nov 2026');
    expect(buildInvitationMessage({ ...base, expiresAt, timeZone: 'America/New_York' })).toContain(
      'until 22 Nov 2026',
    );
  });

  it('falls back to UTC for an unknown zone and omits an unreadable expiry', () => {
    expect(
      buildInvitationMessage({ ...base, expiresAt: '2026-11-22T23:30:00Z', timeZone: 'Nope/Zone' }),
    ).toContain('until 22 Nov 2026');
    expect(buildInvitationMessage({ ...base, expiresAt: 'garbage' })).not.toContain('(The code');
  });

  it('without a link says to ask, with no link or placeholder', () => {
    const text = buildInvitationMessage({ ...base, appLink: null });
    expect(text).toContain('1. Ask me where to get the app\n2.');
    expect(text).not.toMatch(/https?:|<|undefined|null/);
  });

  it('is plain text on one code path for any code input', () => {
    expect(buildInvitationMessage({ ...base, code: ' ab-cd efgh ' })).toContain('code: ABCD-EFGH');
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
