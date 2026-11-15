import { describe, expect, it } from 'vitest';

import { parseAppDownloadUrl } from './appLink';

describe('parseAppDownloadUrl', () => {
  it('accepts http and https', () => {
    expect(parseAppDownloadUrl('https://play.google.com/store/apps/details?id=x')).toBe(
      'https://play.google.com/store/apps/details?id=x',
    );
    expect(parseAppDownloadUrl('  http://example.com/app.apk ')).toBe('http://example.com/app.apk');
  });

  it('ignores empty, missing, other schemes and junk', () => {
    for (const value of [undefined, '', '   ', 'javascript:alert(1)', 'ftp://x.com', 'play.google.com', 'https://a b.com', 'not a url']) {
      expect(parseAppDownloadUrl(value)).toBeNull();
    }
  });
});
