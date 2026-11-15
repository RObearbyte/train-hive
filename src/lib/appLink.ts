/**
 * Where people download the app, for the invitation message. Set
 * `EXPO_PUBLIC_APP_DOWNLOAD_URL` (see `.env.example`); anything that is not an
 * http(s) URL is ignored, so no dead or odd link is ever shared.
 */

/** The trimmed URL when it is http(s) without whitespace, otherwise null. */
export function parseAppDownloadUrl(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '' || /\s/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:' ? trimmed : null;
  } catch {
    return null;
  }
}

// Must be a static `process.env.EXPO_PUBLIC_*` access so Expo inlines it at build time.
export const APP_DOWNLOAD_URL: string | null = parseAppDownloadUrl(
  process.env.EXPO_PUBLIC_APP_DOWNLOAD_URL,
);
