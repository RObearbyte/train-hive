/**
 * Optional e-mail linking and sign-in with a 6-digit code. Pure TypeScript:
 * validation, masking, the resend countdown and the mapping of Supabase Auth
 * errors to friendly text. The calls themselves live in `api/emailAuth.ts`.
 *
 * Nothing here enforces a rule: the server decides who may link or sign in and
 * rate-limits every step. The countdown only keeps people from tapping "Resend"
 * in vain.
 */

/** The code Supabase puts in the e-mail (`{{ .Token }}`). Length is a project setting, 6 by default. */
export const OTP_LENGTH = 6;

/** Seconds the "Send again" button stays disabled after a code was sent. */
export const RESEND_COOLDOWN_SECONDS = 60;

/** Longest address the standard allows. */
export const EMAIL_MAX_LENGTH = 254;

const EMAIL_PATTERN =
  /^[^\s@<>"'`()[\]\\,;:]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Trims and lower-cases: auth treats addresses case-insensitively, and phones love capitals. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** A plausible address (one @, a dotted domain, no spaces). Whether it exists is for the e-mail itself to prove. */
export function isValidEmail(raw: string): boolean {
  const email = normalizeEmail(raw);
  return email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email);
}

/** Keeps only the digits, cut to the code length: pasted "123 456" and "123-456" work. */
export function toCodeInput(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, OTP_LENGTH);
}

/** Exactly six digits, nothing else (surrounding spaces are tolerated). */
export function isValidCode(raw: string): boolean {
  return new RegExp(`^\\d{${OTP_LENGTH}}$`).test(raw.trim());
}

/** `anna.k@gmail.com` -> `a***@g***.com`. Hints at the address without printing it. Not an address: returned as is. */
export function maskEmail(raw: string): string {
  const email = normalizeEmail(raw);
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const lastDot = domain.lastIndexOf('.');
  const first = Array.from(local)[0];
  if (lastDot < 1) return `${first}***@${Array.from(domain)[0]}***`;
  return `${first}***@${Array.from(domain)[0]}***${domain.slice(lastDot)}`;
}

/** One second further in the resend countdown (never below 0). */
export function tickCooldown(remaining: number): number {
  return Math.max(0, remaining - 1);
}

/** Label of the resend button. */
export function resendLabel(remaining: number): string {
  return remaining > 0 ? `Send again in ${remaining} s` : 'Send the code again';
}

/** What the person is told about the account behind the current session. */
export type AccountKind =
  | { kind: 'anonymous'; pendingEmail: string | null }
  | { kind: 'linked'; email: string | null };

/**
 * Anonymous (nothing linked), possibly with an address waiting for its code
 * (`new_email`), or linked. Only `is_anonymous === true` counts as anonymous: a
 * user object without the flag is a full account.
 */
export function accountKindOf(user: {
  is_anonymous?: boolean | undefined;
  email?: string | null | undefined;
  new_email?: string | null | undefined;
}): AccountKind {
  if (user.is_anonymous === true) {
    const pending = typeof user.new_email === 'string' && user.new_email !== '' ? user.new_email : null;
    return { kind: 'anonymous', pendingEmail: pending };
  }
  const email = typeof user.email === 'string' && user.email !== '' ? user.email : null;
  return { kind: 'linked', email };
}

export type AuthFailureKind =
  /** Too many e-mails or attempts (per hour, or per address). */
  | 'rate_limited'
  /** Wrong or expired code (the server does not say which). */
  | 'invalid_code'
  /** The address already belongs to another account. */
  | 'email_in_use'
  | 'invalid_email'
  /** The e-mail could not be sent (sender not set up, address not allowed on the test sender). */
  | 'send_failed'
  /** Linking or sign-in by e-mail is switched off on the server. */
  | 'unavailable'
  /** Sign-in only: no account for this address, or sign-ups are off. Never shown as such. */
  | 'no_account'
  | 'network'
  | 'unknown';

function field(error: unknown, key: string): unknown {
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[key] : undefined;
}

/**
 * Classifies a Supabase Auth error. Uses the stable `code` first, then the HTTP
 * status, then the message text (older servers send no code).
 */
export function classifyAuthError(error: unknown): AuthFailureKind {
  const rawCode = field(error, 'code');
  const rawStatus = field(error, 'status');
  const rawMessage = field(error, 'message');
  const rawName = field(error, 'name');
  const code = typeof rawCode === 'string' ? rawCode : '';
  const status = typeof rawStatus === 'number' ? rawStatus : undefined;
  const message = typeof rawMessage === 'string' ? rawMessage.toLowerCase() : '';
  const name = typeof rawName === 'string' ? rawName : '';

  if (
    name === 'AuthRetryableFetchError' ||
    /network request failed|failed to fetch|fetch failed|load failed|networkerror/.test(message)
  ) {
    return 'network';
  }
  switch (code) {
    case 'over_email_send_rate_limit':
    case 'over_request_rate_limit':
      return 'rate_limited';
    case 'email_exists':
    case 'user_already_exists':
    case 'email_conflict_identity_not_deletable':
    case 'identity_already_exists':
      return 'email_in_use';
    case 'otp_expired':
    case 'bad_code_verifier':
      return 'invalid_code';
    case 'email_address_invalid':
      return 'invalid_email';
    case 'email_address_not_authorized':
    case 'smtp_error':
      return 'send_failed';
    case 'email_provider_disabled':
    case 'provider_disabled':
      return 'unavailable';
    case 'signup_disabled':
    case 'otp_disabled':
    case 'user_not_found':
      return 'no_account';
    default:
      break;
  }
  if (status === 429) return 'rate_limited';
  if (/rate limit|too many requests|after \d+ seconds?/.test(message)) return 'rate_limited';
  if (/already (been )?registered|already exists|already in use/.test(message)) return 'email_in_use';
  if (/token has expired or is invalid|invalid token|expired|invalid otp/.test(message)) return 'invalid_code';
  if (/signups? not allowed|user not found/.test(message)) return 'no_account';
  if (/error sending|unable to send/.test(message)) return 'send_failed';
  if (/invalid.*email|email.*invalid/.test(message)) return 'invalid_email';
  return 'unknown';
}

export const EMAIL_IN_USE_MESSAGE =
  'This email already belongs to a TrainHive account. To use that account, sign out of this one and choose "I already have an account" on the welcome screen. Or add a different email here.';

const WRONG_CODE_MESSAGE = 'That code is not correct or has expired. Check it, or ask for a new one.';

const FAILURE_MESSAGES: Record<AuthFailureKind, string> = {
  rate_limited: 'Too many emails or attempts. Wait a few minutes and try again.',
  invalid_code: WRONG_CODE_MESSAGE,
  email_in_use: EMAIL_IN_USE_MESSAGE,
  invalid_email: 'That does not look like a valid email address.',
  send_failed: 'We could not send the email right now. Try again later.',
  unavailable: 'Signing in with an email is not available right now. Try again later.',
  // Reads like a wrong code on purpose: it never says whether an address has an account.
  no_account: WRONG_CODE_MESSAGE,
  network: 'No connection. Check your internet and try again.',
  unknown: 'Something went wrong. Please try again.',
};

/** Friendly text for a failure. */
export function failureMessage(kind: AuthFailureKind): string {
  return FAILURE_MESSAGES[kind];
}

/** Shown after asking for a sign-in code, whether or not the address has an account. */
export const SIGN_IN_SENT_NEUTRAL =
  'If this email has an account we sent you a code. It can take a minute to arrive. Check your spam folder too.';

/** Shown after asking to link an address. */
export function linkSentMessage(maskedEmail: string): string {
  return `We sent a ${OTP_LENGTH}-digit code to ${maskedEmail}. It can take a minute to arrive. Check your spam folder too.`;
}
