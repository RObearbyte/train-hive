/**
 * The controller's details, read ONLY from the environment (they are public
 * inside the app and baked in at build time, like every EXPO_PUBLIC_ value).
 * Nothing personal is ever written in source, tests or docs.
 *
 * Pure TypeScript apart from `process.env`: also loaded by the web page
 * generator in plain Node. `process.env.EXPO_PUBLIC_*` must stay a static
 * property access, because Expo inlines it at build time.
 */
import { PLACEHOLDER } from './constants';

export const CONTROLLER_NAME_MAX = 120;
export const CONTROLLER_ADDRESS_MAX = 250;
export const PRIVACY_EMAIL_MAX = 254;

// Characters that never belong in a name or an address, as code point ranges:
// C0/C1 controls, the Arabic letter mark, zero-width characters and the directional
// marks (LRM, RLM), line and paragraph separators, every bidi embedding / override,
// word joiner and the bidi isolates, and the byte order mark.
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];

function isUnsafe(codePoint: number): boolean {
  return UNSAFE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
}

/** Characters that separate lines or words: they become a plain space before everything else is stripped. */
function isBreak(codePoint: number): boolean {
  return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x2028 || codePoint === 0x2029;
}

/**
 * Cleans one configured value: removes control and bidi characters (a line
 * break becomes a space, never a way to forge a second line), collapses
 * whitespace, trims and cuts to `max` characters. Empty or non-string input
 * gives ''. HTML is NOT removed here: every output escapes text on its own.
 */
export function sanitizeLegalText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const kept: string[] = [];
  for (const char of raw) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isBreak(codePoint)) kept.push(' ');
    else if (!isUnsafe(codePoint)) kept.push(char);
  }
  const cleaned = kept.join('').replace(/\s+/g, ' ').trim();
  const chars = Array.from(cleaned);
  return chars.length > max ? chars.slice(0, max).join('').trim() : cleaned;
}

const EMAIL =
  /^[^\s@<>"'`()[\]\\,;:]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** A plausible e-mail address after cleaning, else '' (treated as unset). Never truncated: a cut address is a wrong address. */
export function sanitizeEmail(raw: unknown): string {
  const cleaned = sanitizeLegalText(raw, PRIVACY_EMAIL_MAX + 1);
  if (cleaned === '' || Array.from(cleaned).length > PRIVACY_EMAIL_MAX) return '';
  return EMAIL.test(cleaned) ? cleaned : '';
}

export type LegalConfig = {
  /** The configured value, or the `[TO BE FILLED]` marker. */
  controllerName: string;
  controllerAddress: string;
  privacyEmail: string;
  nameSet: boolean;
  addressSet: boolean;
  emailSet: boolean;
  /** All three details are configured. */
  legalDetailsComplete: boolean;
};

export type RawLegalEnv = {
  name?: string | undefined;
  address?: string | undefined;
  email?: string | undefined;
};

/** Builds the config from raw (untrusted) values. */
export function buildLegalConfig(raw: RawLegalEnv): LegalConfig {
  const name = sanitizeLegalText(raw.name, CONTROLLER_NAME_MAX);
  const address = sanitizeLegalText(raw.address, CONTROLLER_ADDRESS_MAX);
  const email = sanitizeEmail(raw.email);
  return {
    controllerName: name === '' ? PLACEHOLDER : name,
    controllerAddress: address === '' ? PLACEHOLDER : address,
    privacyEmail: email === '' ? PLACEHOLDER : email,
    nameSet: name !== '',
    addressSet: address !== '',
    emailSet: email !== '',
    legalDetailsComplete: name !== '' && address !== '' && email !== '',
  };
}

/** The configuration of this build. */
export const legalConfig: LegalConfig = buildLegalConfig({
  name: process.env.EXPO_PUBLIC_CONTROLLER_NAME,
  address: process.env.EXPO_PUBLIC_CONTROLLER_ADDRESS,
  email: process.env.EXPO_PUBLIC_PRIVACY_EMAIL,
});

export const legalDetailsComplete: boolean = legalConfig.legalDetailsComplete;
