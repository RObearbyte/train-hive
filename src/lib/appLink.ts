/**
 * Where people download the app, for the invitation message. Set
 * `EXPO_PUBLIC_APP_DOWNLOAD_URL` (see `.env.example`); anything that is not a
 * plain http(s) URL is ignored, so no dead, odd or credential-bearing link is
 * ever shared.
 */

const MAX_LENGTH = 2048;
// Whitespace, control characters, Arabic letter mark, bidi controls, zero-width characters,
// line and paragraph separators, invisible operators, BOM.
const HIDDEN_OR_SPACE =
  /[\s\u{0}-\u{1F}\u{7F}-\u{9F}\u{61C}\u{180E}\u{200B}-\u{200F}\u{2028}\u{2029}\u{202A}-\u{202E}\u{2060}-\u{206F}\u{FEFF}]/u;

/** The normalized URL (`URL.href`) when it is an absolute http(s) URL with a host and no credentials, otherwise null. */
export function parseAppDownloadUrl(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '' || trimmed.length > MAX_LENGTH || HIDDEN_OR_SPACE.test(trimmed)) return null;
  // Only the `scheme://host` form: `http:example.com` and `https:/example.com` parse, but are not what the owner meant.
  if (!/^https?:\/\/[^/]/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.hostname === '' || url.username !== '' || url.password !== '') return null;
    return url.href.length > MAX_LENGTH ? null : url.href;
  } catch {
    return null;
  }
}

// Must be a static `process.env.EXPO_PUBLIC_*` access so Expo inlines it at build time.
export const APP_DOWNLOAD_URL: string | null = parseAppDownloadUrl(
  process.env.EXPO_PUBLIC_APP_DOWNLOAD_URL,
);

/**
 * The address of the web app (`EXPO_PUBLIC_WEB_APP_URL`), used to build the
 * `<web-app>/join#code=...` link in the invitation message. Same strict
 * rules as `parseAppDownloadUrl`, plus: no query string or fragment (the link
 * adds its own), and the result has no trailing slash, so
 * `https://app.example.com/` and `https://app.example.com` both give
 * `https://app.example.com`. A sub-path (`https://example.com/trainhive/`)
 * is kept.
 */
export function parseWebAppUrl(value: string | undefined): string | null {
  const href = parseAppDownloadUrl(value);
  if (href === null) return null;
  const url = new URL(href);
  if (url.search !== '' || url.hash !== '') return null;
  // `?` or `#` with nothing after them still parse as empty search / hash.
  if (/[?#]/.test(href)) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

export const WEB_APP_URL: string | null = parseWebAppUrl(process.env.EXPO_PUBLIC_WEB_APP_URL);
