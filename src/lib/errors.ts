/**
 * Backend error parsing. See "Conventions" in docs/API_CONTRACT.md:
 * - mutations raise P0001 with the machine code as the message;
 * - invitation RPCs return `{ ok: false, error: '<code>' }`.
 *
 * Pure TypeScript: no react-native or supabase-js imports (errors are
 * inspected structurally).
 */

/** Every machine code the contract can produce. */
export const BACKEND_ERROR_CODES = [
  'not_authenticated',
  'not_a_member',
  'forbidden',
  'not_found',
  'validation_failed',
  'invalid_code',
  'expired',
  'revoked',
  'exhausted',
  'rate_limited',
  'invalid_display_name',
  'community_limit_reached',
  'session_not_editable',
  'session_not_cancellable',
  'session_has_attendance',
  'rsvp_closed',
  'session_full',
  'session_not_confirmed',
  'session_not_ended',
  'attendee_not_a_member',
  'no_going_rsvp',
  'attendee_has_going_rsvp',
  'announcement_not_editable',
  'announcement_not_cancellable',
  'stale_data',
  'consent_required',
  'not_withdrawable',
  'last_organizer',
  'cannot_change_own_role',
  'cannot_remove_self',
  'not_a_top_level_post',
  'post_deleted',
  'event_closed',
  'not_loggable',
  'event_not_ended',
  'not_eligible',
] as const;

export type BackendErrorCode = (typeof BACKEND_ERROR_CODES)[number];

/**
 * Backend codes plus the client-side ones. `app_update_required`: the server
 * asks for a version of the legal texts this build does not contain.
 */
export type AppErrorCode = BackendErrorCode | 'network_error' | 'app_update_required' | 'unknown';

const VALIDATION_PREFIX = 'validation_failed';
const CONSENT_PREFIX = 'consent_required';

const BACKEND_CODE_SET: ReadonlySet<string> = new Set(BACKEND_ERROR_CODES);

function isBackendErrorCode(value: string): value is BackendErrorCode {
  return BACKEND_CODE_SET.has(value);
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  /** Column name for `validation_failed:<field>` (e.g. `max_participants`), or the purpose of `consent_required:<purpose>`. */
  readonly field: string | undefined;
  /** The value that was thrown / returned, kept for logging. */
  readonly original: unknown;

  /**
   * `message` is the original backend / runtime message (for logs), never
   * user-facing text: use `userMessage(error.code, error.field)` for that.
   */
  constructor(
    code: AppErrorCode,
    options: { message?: string; field?: string; original?: unknown } = {},
  ) {
    super(options.message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.field = options.field;
    this.original = options.original;
  }
}

/**
 * Parses a machine code string such as `rsvp_closed` or
 * `validation_failed:max_participants`. Returns null when the string is not a
 * contract code.
 */
export function parseErrorCode(
  raw: string,
): { code: BackendErrorCode; field: string | undefined } | null {
  const text = raw.trim();
  if (text === VALIDATION_PREFIX) return { code: 'validation_failed', field: undefined };
  if (text.startsWith(`${VALIDATION_PREFIX}:`)) {
    const field = text.slice(VALIDATION_PREFIX.length + 1).trim();
    return { code: 'validation_failed', field: field === '' ? undefined : field };
  }
  // `consent_required:<purpose>` (About you): the purpose travels in `field`.
  if (text.startsWith(`${CONSENT_PREFIX}:`)) {
    const purpose = text.slice(CONSENT_PREFIX.length + 1).trim();
    return { code: 'consent_required', field: purpose === '' ? undefined : purpose };
  }
  return isBackendErrorCode(text) ? { code: text, field: undefined } : null;
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' ? found : undefined;
}

const NETWORK_MESSAGE =
  /network request failed|failed to fetch|fetch failed|load failed|networkerror|network error|internet connection appears to be offline|econnrefused|econnreset|enotfound|etimedout/i;

/**
 * True when the request never produced a server answer (offline, DNS, timeout).
 * supabase-js reports these as an error object whose message carries the
 * fetch failure text, or as `AuthRetryableFetchError` from the auth client.
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof AppError) return error.code === 'network_error';
  if (typeof error === 'string') return NETWORK_MESSAGE.test(error);
  if (typeof error !== 'object' || error === null) return false;

  const name = readString(error, 'name');
  if (name === 'AuthRetryableFetchError' || name === 'FunctionsFetchError') return true;
  // A server answer always has a Postgres / PostgREST code; a failed fetch does not.
  const code = readString(error, 'code');
  if (code !== undefined && code !== '') return false;

  const message = readString(error, 'message') ?? '';
  const details = readString(error, 'details') ?? '';
  return NETWORK_MESSAGE.test(message) || NETWORK_MESSAGE.test(details);
}

function describe(error: unknown): string {
  if (typeof error === 'string') return error;
  const message = readString(error, 'message');
  if (message !== undefined && message !== '') return message;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * Converts anything thrown or returned as `error` by supabase-js into an
 * AppError. Unknown errors become code `unknown` and keep their original
 * message and value, so nothing is lost for logging.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  const message = describe(error);

  // P0001 = `raise exception` from our RPCs: the message is the machine code.
  if (readString(error, 'code') === 'P0001') {
    const parsed = parseErrorCode(message);
    if (parsed) return new AppError(parsed.code, { message, field: parsed.field, original: error });
    return new AppError('unknown', { message, original: error });
  }

  if (isNetworkError(error)) return new AppError('network_error', { message, original: error });

  return new AppError('unknown', { message, original: error });
}

/**
 * Converts the `error` of an `{ ok: false, error }` RPC result into an
 * AppError. An unrecognized code becomes `unknown` with the raw code kept as
 * the message.
 */
export function appErrorFromResult(errorCode: unknown): AppError {
  if (typeof errorCode === 'string') {
    const parsed = parseErrorCode(errorCode);
    if (parsed) {
      return new AppError(parsed.code, {
        message: errorCode,
        field: parsed.field,
        original: errorCode,
      });
    }
  }
  return new AppError('unknown', { message: describe(errorCode), original: errorCode });
}

const MESSAGES: Record<AppErrorCode, string> = {
  not_authenticated: 'Your session has ended. Please restart the app and try again.',
  not_a_member: 'You are not a member of this community.',
  forbidden: 'Only an organizer can do that.',
  not_found: 'We could not find that. It may have been removed.',
  validation_failed: 'Some details are not valid. Please check them and try again.',
  invalid_code: 'That invitation code is not valid. Check it and try again.',
  expired: 'This invitation code has expired. Ask your organizer for a new one.',
  revoked: 'This invitation code is no longer active. Ask your organizer for a new one.',
  exhausted: 'This invitation code has already been used the maximum number of times.',
  rate_limited: 'Too many attempts. Please wait 15 minutes and try again.',
  invalid_display_name: 'Your name must be between 2 and 40 characters.',
  community_limit_reached:
    'You have reached the maximum number of communities you can create (5). You can still join more with an invitation code.',
  session_not_editable: 'This event can no longer be edited.',
  session_not_cancellable: 'This event is already completed and cannot be cancelled.',
  session_has_attendance:
    'This event already has attendance recorded and can no longer be cancelled. Correct the attendance instead.',
  rsvp_closed: 'Responses are closed for this event.',
  session_full: 'This event is full. No spots are left.',
  session_not_confirmed:
    'Attendance can only be taken for a confirmed event. This one is not confirmed (it is still open or was cancelled).',
  session_not_ended: 'This event has not ended yet. Attendance can be recorded once it is over.',
  attendee_not_a_member: 'That person is no longer an active member of this community.',
  no_going_rsvp: 'That member did not say they were going. Add them as a walk-in instead.',
  attendee_has_going_rsvp:
    'That member said they were going, so they are already on the list. Mark them Present there.',
  announcement_not_editable:
    'This announcement was already published or cancelled, so it can no longer be changed.',
  announcement_not_cancellable:
    'This announcement was already published, so it can no longer be cancelled.',
  stale_data:
    'Someone else changed these community settings while you were editing. Review the latest values and try again.',
  consent_required:
    'Please confirm the Terms of Use, the Privacy Notice and your age first, then try again.',
  not_withdrawable:
    'That agreement is needed to use TrainHive and cannot be withdrawn. To stop, delete your account.',
  last_organizer:
    'A community needs at least one organizer. Make another member an organizer first.',
  cannot_change_own_role: 'You cannot change your own role. Ask another organizer to do it.',
  cannot_remove_self:
    'You cannot remove yourself here. Use "Leave this community" in your profile instead.',
  not_a_top_level_post: 'You can reply to a post, but not to a reply.',
  post_deleted: 'That post was deleted.',
  event_closed: 'The discussion for this event is closed. It stays readable.',
  not_loggable: 'Workouts cannot be logged for this kind of event.',
  event_not_ended: 'This event has not ended yet. You can log your workout once it is over.',
  not_eligible: 'Only members who said they were going, or were marked present, can log this event.',
  app_update_required:
    'Our terms or privacy notice changed and this version of TrainHive cannot show the new text. Please update the app and try again.',
  network_error: 'No connection. Check your internet and try again.',
  unknown: 'Something went wrong. Please try again.',
};

/** Friendly names for the columns `validation_failed:<field>` can point at. */
const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  description: 'description',
  activity_type: 'activity type',
  starts_at: 'start time',
  ends_at: 'end time',
  rsvp_deadline: 'RSVP deadline',
  timezone: 'time zone',
  location_name: 'location name',
  address: 'address',
  latitude: 'latitude',
  longitude: 'longitude',
  map_url: 'map link',
  meeting_instructions: 'meeting instructions',
  min_participants: 'minimum participants',
  max_participants: 'maximum participants',
  display_name: 'name',
  expires_at: 'expiry date',
  max_redemptions: 'maximum uses',
  name: 'name',
  request_id: 'request',
  reason: 'reason (200 characters at most)',
  user_id: 'member',
  role: 'role',
  status: 'attendance status',
  body: 'message',
  scheduled_for: 'publish time (it must be in the future, within a year)',
  token: 'push token',
  platform: 'platform',
  device_label: 'device name',
  window: 'time period',
  limit: 'page size',
  input: 'details',
  birth_year: 'birth year',
  gender: 'gender',
  emergency_contact_name: "emergency contact's name",
  emergency_contact_phone: "emergency contact's phone number",
  emergency_contact_relationship: 'relationship to your emergency contact',
  tshirt_size: 'T-shirt size',
  exercises: 'exercises (add at least one exercise or a note, at most 30)',
  exercise_name: 'exercise name (1 to 80 characters)',
  sets: 'sets (1 to 20 per exercise)',
  reps: 'repetitions (whole number from 1 to 1000)',
  weight_kg: 'weight (0 to 1000 kg, in steps of 0.25)',
  distance_m: 'distance',
  duration_s: 'time',
  notes: 'notes (at most 1000 characters)',
  range: 'date range',
};

/** `consent_required:<purpose>` on the About-you page: which agreement is missing. */
const CONSENT_FIELD_MESSAGES: Record<string, string> = {
  profile_demographics:
    'To save your birth year or gender, please agree to the statistics notice first, then try again.',
  emergency_contact:
    'To save your emergency contact or T-shirt size, please agree to sharing them with organizers first, then try again.',
  workout_logs:
    'To save a workout log, please agree to workout logs first (the box above the Save button), then try again.',
};

/**
 * Clear English text for a code. Accepts any string so callers can pass an
 * unparsed value; anything unrecognized gets the generic fallback.
 */
export function userMessage(code: AppErrorCode | (string & {}), field?: string): string {
  if (code === 'consent_required' && field !== undefined && Object.hasOwn(CONSENT_FIELD_MESSAGES, field)) {
    return CONSENT_FIELD_MESSAGES[field];
  }
  if (code === 'validation_failed' && field !== undefined) {
    const label = FIELD_LABELS[field];
    if (label !== undefined) return `The ${label} is not valid. Please check it and try again.`;
  }
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code as AppErrorCode] : MESSAGES.unknown;
}

/** Shortcut: friendly text for anything thrown. */
export function userMessageFor(error: unknown): string {
  const appError = toAppError(error);
  return userMessage(appError.code, appError.field);
}
