import { describe, expect, it } from 'vitest';

import { buildWebJoinLink, isJoinPath, parseJoinFragment } from './joinLink';
import { peekPendingJoinCode, readJoinLocation, setPendingJoinCode, takePendingJoinCode } from './pendingJoin';

describe('parseJoinFragment', () => {
  it('reads a plain code, with or without the leading #', () => {
    expect(parseJoinFragment('#code=ABCD-EFGH')).toBe('ABCDEFGH');
    expect(parseJoinFragment('code=ABCD-EFGH')).toBe('ABCDEFGH');
    expect(parseJoinFragment('#code=ABCDEFGH')).toBe('ABCDEFGH');
  });

  it('accepts lowercase, spaces and other dash characters', () => {
    expect(parseJoinFragment('#code=abcd-efgh')).toBe('ABCDEFGH');
    expect(parseJoinFragment('#code=abcd%20efgh')).toBe('ABCDEFGH');
    expect(parseJoinFragment('#code=abcd+efgh')).toBe('ABCDEFGH');
    expect(parseJoinFragment('#code=abcd%E2%80%93efgh')).toBe('ABCDEFGH'); // en dash
    expect(parseJoinFragment('#code=%20ABCD-EFGH%20')).toBe('ABCDEFGH');
  });

  it('decodes percent-encoding', () => {
    expect(parseJoinFragment('#code=ABCD%2DEFGH')).toBe('ABCDEFGH');
    expect(parseJoinFragment('#code=%41BCD-EFGH')).toBe('ABCDEFGH');
  });

  it('ignores other parameters in any order', () => {
    expect(parseJoinFragment('#utm=x&code=ABCD-EFGH&z=1')).toBe('ABCDEFGH');
    expect(parseJoinFragment('#code=ABCD-EFGH&code2=ZZZZZZZZ')).toBe('ABCDEFGH');
    expect(parseJoinFragment('#xcode=ABCD-EFGH')).toBeNull();
    expect(parseJoinFragment('#Code=ABCD-EFGH')).toBeNull();
  });

  it('two code parameters are ambiguous: nothing', () => {
    expect(parseJoinFragment('#code=ABCD-EFGH&code=WXYZ-2345')).toBeNull();
  });

  it('rejects missing, empty and malformed input', () => {
    for (const input of [null, undefined, '', '#', '#code', '#code=', '#=ABCD-EFGH', '#ABCD-EFGH', '#&&&']) {
      expect(parseJoinFragment(input)).toBeNull();
    }
  });

  it('rejects codes that are the wrong length or use forbidden characters', () => {
    for (const input of [
      '#code=ABCD-EFG',
      '#code=ABCD-EFGHJ',
      '#code=ABCD-EFG0',
      '#code=ABCD-EFGI',
      '#code=ABCD-EFGU',
      '#code=ABCD-EF!H',
    ]) {
      expect(parseJoinFragment(input)).toBeNull();
    }
  });

  it('rejects broken percent-encoding without throwing', () => {
    expect(parseJoinFragment('#code=%')).toBeNull();
    expect(parseJoinFragment('#code=%E0%A4%A')).toBeNull();
    expect(parseJoinFragment('#code=ABCD%ZZEFGH')).toBeNull();
  });

  it('rejects very long input without processing it', () => {
    expect(parseJoinFragment(`#code=${'A'.repeat(100_000)}`)).toBeNull();
    expect(parseJoinFragment(`#code=ABCD-EFGH&pad=${'x'.repeat(10_000)}`)).toBeNull();
  });

  it('is not fooled by markup, control characters or separators', () => {
    expect(parseJoinFragment('#code=<script>alert(1)</script>')).toBeNull();
    expect(parseJoinFragment('#code=ABCD-EFGH%0A')).toBe('ABCDEFGH'); // whitespace is dropped like any other
    expect(parseJoinFragment('#code=ABCD%00EFGH')).toBeNull();
    expect(parseJoinFragment('#code=ABCD-EFGH;rm -rf')).toBeNull();
  });

  it('only ever returns the normalized code or null', () => {
    const hostile = ['#code=ABCD-EFGH', '#a=b&code=wxyz-2345&c=d', '#code=%F0%9F%90%BB', '#code=\u0000'];
    for (const input of hostile) {
      const result = parseJoinFragment(input);
      expect(result === null || /^[2-9A-HJKMNP-TV-Z]{8}$/.test(result)).toBe(true);
    }
  });
});

describe('isJoinPath', () => {
  it('matches the join route, also under a sub-path', () => {
    expect(isJoinPath('/join')).toBe(true);
    expect(isJoinPath('/join/')).toBe(true);
    expect(isJoinPath('/trainhive/join')).toBe(true);
    expect(isJoinPath('/')).toBe(false);
    expect(isJoinPath('/rejoin')).toBe(false);
    expect(isJoinPath('/join/extra')).toBe(false);
  });
});

describe('buildWebJoinLink', () => {
  it('puts the code in the fragment, formatted', () => {
    expect(buildWebJoinLink('https://app.example.com', 'abcdefgh')).toBe('https://app.example.com/join#code=ABCD-EFGH');
    expect(buildWebJoinLink('https://example.com/trainhive', ' abcd efgh ')).toBe(
      'https://example.com/trainhive/join#code=ABCD-EFGH',
    );
  });

  it('is null without a web app url or with an invalid code', () => {
    expect(buildWebJoinLink(null, 'ABCD-EFGH')).toBeNull();
    expect(buildWebJoinLink('', 'ABCD-EFGH')).toBeNull();
    expect(buildWebJoinLink('https://app.example.com', 'short')).toBeNull();
    expect(buildWebJoinLink('https://app.example.com', 'ABCD-EFGH&x=1')).toBeNull();
  });

  it('round trips with the parser and has no query string', () => {
    const link = buildWebJoinLink('https://app.example.com', 'wxyz2345');
    expect(link).not.toBeNull();
    const url = new URL(link as string);
    expect(parseJoinFragment(url.hash)).toBe('WXYZ2345');
    expect(url.search).toBe('');
  });
});

describe('readJoinLocation', () => {
  it('reads the code only on the join route', () => {
    expect(readJoinLocation('/join', '#code=ABCD-EFGH')).toEqual({ isJoin: true, code: 'ABCDEFGH', hasFragment: true });
    expect(readJoinLocation('/trainings', '#code=ABCD-EFGH')).toEqual({
      isJoin: false,
      code: null,
      hasFragment: false,
    });
  });

  it('a malformed or missing fragment still reports whether one has to be removed', () => {
    expect(readJoinLocation('/join', '#code=nope')).toEqual({ isJoin: true, code: null, hasFragment: true });
    expect(readJoinLocation('/join', '')).toEqual({ isJoin: true, code: null, hasFragment: false });
    expect(readJoinLocation('/join', '#')).toEqual({ isJoin: true, code: null, hasFragment: false });
  });
});

describe('pending join code (memory only)', () => {
  it('peek keeps it, take clears it', () => {
    setPendingJoinCode('ABCDEFGH');
    expect(peekPendingJoinCode()).toBe('ABCDEFGH');
    expect(peekPendingJoinCode()).toBe('ABCDEFGH');
    expect(takePendingJoinCode()).toBe('ABCDEFGH');
    expect(peekPendingJoinCode()).toBeNull();
    expect(takePendingJoinCode()).toBeNull();
  });
});
