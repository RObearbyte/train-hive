import { describe, expect, it } from 'vitest';

import { parseAppDownloadUrl } from './appLink';

describe('parseAppDownloadUrl', () => {
  it('accepts http and https', () => {
    expect(parseAppDownloadUrl('https://play.google.com/store/apps/details?id=x')).toBe(
      'https://play.google.com/store/apps/details?id=x',
    );
    expect(parseAppDownloadUrl('  http://example.com/app.apk ')).toBe('http://example.com/app.apk');
  });

  it('returns the normalized URL, not the input', () => {
    expect(parseAppDownloadUrl('HTTPS://EXAMPLE.COM')).toBe('https://example.com/');
    expect(parseAppDownloadUrl('https://example.com:443/a%20b')).toBe('https://example.com/a%20b');
  });

  it('rejects credentials, odd forms, hidden characters and absurd length', () => {
    const rejected = [
      'https://user:pw@example.com/',
      'https://user@example.com/',
      'http:example.com',
      'https:/example.com',
      'https:///example.com',
      'https://example.com/\u{200B}x',
      'https://example.com/\u{202E}txt',
      'https://example.com/\u0085x',
      'https://example.com/\u{2060}x',
      'https://example.com/\u{FEFF}x',
      'https://example.com/' + 'a'.repeat(2100),
    ];
    for (const value of rejected) expect(parseAppDownloadUrl(value), JSON.stringify(value)).toBeNull();
  });

  it('ignores empty, missing, other schemes and junk', () => {
    for (const value of [undefined, '', '   ', 'javascript:alert(1)', 'ftp://x.com', 'play.google.com', 'https://a b.com', 'not a url']) {
      expect(parseAppDownloadUrl(value)).toBeNull();
    }
  });
});
