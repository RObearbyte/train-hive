import { describe, expect, it } from 'vitest';

import { parseAppDownloadUrl, parseWebAppUrl } from './appLink';

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

describe('parseWebAppUrl', () => {
  it('normalizes: origin plus path, no trailing slash', () => {
    expect(parseWebAppUrl('https://app.example.com')).toBe('https://app.example.com');
    expect(parseWebAppUrl('https://app.example.com/')).toBe('https://app.example.com');
    expect(parseWebAppUrl('  https://App.Example.com//  ')).toBe('https://app.example.com');
    expect(parseWebAppUrl('https://example.com/trainhive/')).toBe('https://example.com/trainhive');
    expect(parseWebAppUrl('http://localhost:8081/')).toBe('http://localhost:8081');
  });

  it('rejects what the download parser rejects', () => {
    for (const value of [
      undefined,
      '',
      '   ',
      'ftp://example.com',
      'javascript:alert(1)',
      'https://user:pw@example.com',
      'https:example.com',
      'https://exa mple.com',
      'https://example.com/\nevil',
      'https://example.com/‮evil',
      `https://example.com/${'a'.repeat(3000)}`,
    ]) {
      expect(parseWebAppUrl(value)).toBeNull();
    }
  });

  it('rejects a query string or fragment: the join link adds its own', () => {
    expect(parseWebAppUrl('https://app.example.com/?a=1')).toBeNull();
    expect(parseWebAppUrl('https://app.example.com/#code=ABCD-EFGH')).toBeNull();
    expect(parseWebAppUrl('https://app.example.com/?')).toBeNull();
    expect(parseWebAppUrl('https://app.example.com/#')).toBeNull();
  });
});
