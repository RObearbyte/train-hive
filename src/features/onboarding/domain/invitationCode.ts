/**
 * Invitation code format (see `create_invitation` in docs/API_CONTRACT.md):
 * 8 characters from an alphabet without look-alikes (no 0, 1, I, L, O, U).
 * The server matches case-insensitively and ignores spaces and dashes; the
 * format check here only saves a round trip that would count toward the
 * rate limit.
 */

export const INVITATION_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const INVITATION_CODE_LENGTH = 8;

const CODE_PATTERN = new RegExp(`^[${INVITATION_CODE_ALPHABET}]{${INVITATION_CODE_LENGTH}}$`);

/** Uppercases and removes whitespace and dashes (any dash-like character). */
export function normalizeInvitationCode(input: string): string {
  return input.replace(/[\s\-‐-―−]/g, '').toUpperCase();
}

/** True when the input, once normalized, is 8 characters of the code alphabet. */
export function isValidInvitationCodeFormat(input: string): boolean {
  return CODE_PATTERN.test(normalizeInvitationCode(input));
}

/**
 * Display form `ABCD-EFGH`. Also works on partial input while typing
 * ("abcde" → "ABCD-E"); anything past 8 characters is kept after the dash so
 * the user can see and fix it.
 */
export function formatInvitationCode(input: string): string {
  const code = normalizeInvitationCode(input);
  const half = INVITATION_CODE_LENGTH / 2;
  return code.length <= half ? code : `${code.slice(0, half)}-${code.slice(half)}`;
}

/**
 * Value for the code text input: whatever was typed or pasted, normalized,
 * cut to 8 characters and shown as `ABCD-EFGH`.
 */
export function toInvitationCodeInput(text: string): string {
  return formatInvitationCode(normalizeInvitationCode(text).slice(0, INVITATION_CODE_LENGTH));
}

const CODE_PROBLEMS: ReadonlySet<string> = new Set(['invalid_code', 'expired', 'revoked', 'exhausted']);

/**
 * True for server answers that are about the code itself (shown on the code
 * field), as opposed to rate limiting, connection or unexpected failures
 * (shown as a banner).
 */
export function isInvitationCodeProblem(errorCode: string): boolean {
  return CODE_PROBLEMS.has(errorCode);
}
