/**
 * Create / edit training form: validation, payload building and prefill.
 *
 * The form holds what the inputs hold: strings. Date and time are wall-clock
 * values in the SESSION's time zone (the community's zone on create), not the
 * device's. `toTrainingInput` turns them into the snake_case `p_input` of
 * `create_training` / `update_training` with UTC ISO timestamps.
 *
 * Client validation mirrors docs/API_CONTRACT.md to give early, per-field
 * feedback. `now` is injected and advisory: the server re-validates
 * everything, including "in the future", with its own clock.
 */
import { z } from 'zod';

import type { SessionStatus, TrainingInput, TrainingSession } from '@/lib/database.types';
import {
  defaultRsvpDeadline,
  isValidDateString,
  isValidTimeString,
  isValidTimeZone,
  utcToWallTime,
  wallTimeToUtc,
} from '@/lib/datetime';

import { DEFAULT_ACTIVITY_TYPE } from './activity';

export const TITLE_MAX = 80;
export const LOCATION_NAME_MAX = 120;

export const TRAINING_FORM_FIELDS = [
  'title',
  'description',
  'activityType',
  'date',
  'startTime',
  'endTime',
  'deadlineDate',
  'deadlineTime',
  'locationName',
  'address',
  'latitude',
  'longitude',
  'mapUrl',
  'meetingInstructions',
  'minParticipants',
  'maxParticipants',
] as const;

export type TrainingFormField = (typeof TRAINING_FORM_FIELDS)[number];

/**
 * Every field is a string, as typed. Optional fields are '' when empty.
 * - `date`, `deadlineDate`: `yyyy-MM-dd`; `startTime`, `endTime`, `deadlineTime`: `HH:mm`.
 * - `endTime` is on the same day as `date`.
 * - `deadlineDate` + `deadlineTime` both empty = default (2 hours before the start).
 */
export type TrainingFormValues = Record<TrainingFormField, string>;

/** The stored values an edit is checked against. */
export type EditedSession = Pick<
  TrainingSession,
  | 'status'
  | 'going_count'
  | 'starts_at'
  | 'ends_at'
  | 'rsvp_deadline'
  | 'min_participants'
  | 'max_participants'
>;

export type TrainingFormContext =
  | { mode: 'create'; timezone: string; now: Date }
  | { mode: 'edit'; timezone: string; now: Date; session: EditedSession };

export function emptyTrainingForm(): TrainingFormValues {
  return {
    title: '',
    description: '',
    activityType: DEFAULT_ACTIVITY_TYPE,
    date: '',
    startTime: '',
    endTime: '',
    deadlineDate: '',
    deadlineTime: '',
    locationName: '',
    address: '',
    latitude: '',
    longitude: '',
    mapUrl: '',
    meetingInstructions: '',
    minParticipants: '',
    maxParticipants: '',
  };
}

const INTEGER_PATTERN = /^\d{1,9}$/;
// Accepts a decimal comma, which is what many European keyboards type.
const DECIMAL_PATTERN = /^[+-]?\d+(?:[.,]\d+)?$/;
const HTTP_URL_PATTERN = /^https?:\/\/[^\s/?#]+[^\s]*$/i;

function parseInteger(text: string): number | null {
  const trimmed = text.trim();
  return INTEGER_PATTERN.test(trimmed) ? Number(trimmed) : null;
}

function parseDecimal(text: string): number | null {
  const trimmed = text.trim();
  return DECIMAL_PATTERN.test(trimmed) ? Number(trimmed.replace(',', '.')) : null;
}

function optionalText(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return new Date(a).getTime() === new Date(b).getTime();
}

/**
 * Wall time → UTC. When the form still shows the stored value's wall time,
 * the stored instant is returned verbatim, so an untouched field never
 * "changes" through rounding or a repeated DST hour.
 */
function resolveInstant(
  date: string,
  time: string,
  timezone: string,
  stored: string | null | undefined,
): string {
  if (stored) {
    const wall = utcToWallTime(stored, timezone);
    if (wall.date === date && wall.time === time) return stored;
  }
  return wallTimeToUtc(date, time, timezone);
}

type Instants = {
  startsAt: string | null;
  endsAt: string | null;
  /** Explicit or defaulted deadline; null when it cannot be computed. */
  rsvpDeadline: string | null;
  deadlineIsDefault: boolean;
};

function computeInstants(
  values: TrainingFormValues,
  timezone: string,
  stored: Pick<TrainingSession, 'starts_at' | 'ends_at' | 'rsvp_deadline'> | undefined,
): Instants {
  const date = values.date.trim();
  const startTime = values.startTime.trim();
  const endTime = values.endTime.trim();
  const deadlineDate = values.deadlineDate.trim();
  const deadlineTime = values.deadlineTime.trim();
  const dateOk = isValidDateString(date);

  const startsAt =
    dateOk && isValidTimeString(startTime)
      ? resolveInstant(date, startTime, timezone, stored?.starts_at)
      : null;
  const endsAt =
    dateOk && isValidTimeString(endTime)
      ? resolveInstant(date, endTime, timezone, stored?.ends_at)
      : null;

  const deadlineIsDefault = deadlineDate === '' && deadlineTime === '';
  let rsvpDeadline: string | null = null;
  if (deadlineIsDefault) {
    rsvpDeadline = startsAt === null ? null : defaultRsvpDeadline(startsAt);
  } else if (isValidDateString(deadlineDate) && isValidTimeString(deadlineTime)) {
    rsvpDeadline = resolveInstant(deadlineDate, deadlineTime, timezone, stored?.rsvp_deadline);
  }
  return { startsAt, endsAt, rsvpDeadline, deadlineIsDefault };
}

const formShape = z.object({
  title: z.string(),
  description: z.string(),
  activityType: z.string(),
  date: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  deadlineDate: z.string(),
  deadlineTime: z.string(),
  locationName: z.string(),
  address: z.string(),
  latitude: z.string(),
  longitude: z.string(),
  mapUrl: z.string(),
  meetingInstructions: z.string(),
  minParticipants: z.string(),
  maxParticipants: z.string(),
});

/**
 * Zod schema for the form. All rules run in one pass so every invalid field
 * gets its message at once, each on its own field path.
 */
export function trainingFormSchema(context: TrainingFormContext) {
  if (!isValidTimeZone(context.timezone)) {
    throw new RangeError(`Invalid time zone: ${String(context.timezone)}`);
  }
  const { timezone, now } = context;
  const stored = context.mode === 'edit' ? context.session : undefined;
  const isConfirmedEdit = stored?.status === 'confirmed';
  const nowMs = now.getTime();

  return formShape.superRefine((values, ctx) => {
    const issue = (field: TrainingFormField, message: string) =>
      ctx.addIssue({ code: 'custom', path: [field], message });

    // --- Text -------------------------------------------------------------
    const title = values.title.trim();
    if (title === '') issue('title', 'Enter a title.');
    else if (title.length > TITLE_MAX) issue('title', `Keep the title to ${TITLE_MAX} characters.`);

    const locationName = values.locationName.trim();
    if (locationName === '') issue('locationName', 'Enter where the training takes place.');
    else if (locationName.length > LOCATION_NAME_MAX) {
      issue('locationName', `Keep the location name to ${LOCATION_NAME_MAX} characters.`);
    }

    if (values.activityType.trim() === '') issue('activityType', 'Choose an activity.');

    const mapUrl = values.mapUrl.trim();
    if (mapUrl !== '' && !HTTP_URL_PATTERN.test(mapUrl)) {
      issue('mapUrl', 'Enter a link that starts with http:// or https://.');
    }

    // --- Date and time ------------------------------------------------------
    const date = values.date.trim();
    const startTime = values.startTime.trim();
    const endTime = values.endTime.trim();
    const deadlineDate = values.deadlineDate.trim();
    const deadlineTime = values.deadlineTime.trim();

    if (date === '') issue('date', 'Choose a date.');
    else if (!isValidDateString(date)) issue('date', 'Enter a valid date.');

    if (startTime === '') issue('startTime', 'Choose a start time.');
    else if (!isValidTimeString(startTime)) issue('startTime', 'Enter a valid start time.');

    if (endTime !== '' && !isValidTimeString(endTime)) issue('endTime', 'Enter a valid end time.');

    if (deadlineDate !== '' && !isValidDateString(deadlineDate)) {
      issue('deadlineDate', 'Enter a valid deadline date.');
    }
    if (deadlineTime !== '' && !isValidTimeString(deadlineTime)) {
      issue('deadlineTime', 'Enter a valid deadline time.');
    }
    if (deadlineDate === '' && deadlineTime !== '') {
      issue('deadlineDate', 'Choose a deadline date, or clear the deadline time.');
    }
    if (deadlineDate !== '' && deadlineTime === '') {
      issue('deadlineTime', 'Choose a deadline time, or clear the deadline date.');
    }

    const { startsAt, endsAt, rsvpDeadline, deadlineIsDefault } = computeInstants(
      values,
      timezone,
      stored,
    );
    const startMs = startsAt === null ? null : new Date(startsAt).getTime();
    const endMs = endsAt === null ? null : new Date(endsAt).getTime();
    const deadlineMs = rsvpDeadline === null ? null : new Date(rsvpDeadline).getTime();

    // Start in the future: always on create; on a confirmed session only when moved.
    let startIsPast = false;
    if (startMs !== null) {
      const mustBeFuture =
        context.mode === 'create' ||
        (isConfirmedEdit && !sameInstant(startsAt, stored?.starts_at ?? null));
      if (mustBeFuture && startMs <= nowMs) {
        startIsPast = true;
        issue('date', 'The start must be in the future.');
      }
    }

    if (startMs !== null && endMs !== null) {
      if (endMs <= startMs) issue('endTime', 'The end time must be after the start time.');
      else if (
        isConfirmedEdit &&
        !sameInstant(endsAt, stored?.ends_at ?? null) &&
        endMs <= nowMs
      ) {
        issue('endTime', 'The end time must be in the future.');
      }
    }

    if (isConfirmedEdit) {
      if (deadlineMs !== null && !sameInstant(rsvpDeadline, stored?.rsvp_deadline ?? null)) {
        issue(
          'deadlineDate',
          'The RSVP deadline cannot be changed after the training is confirmed.',
        );
      }
    } else if (deadlineMs !== null && startMs !== null) {
      if (deadlineMs > startMs) {
        issue('deadlineDate', 'The RSVP deadline must be at or before the start.');
      } else if (deadlineMs <= nowMs && !startIsPast) {
        issue(
          'deadlineDate',
          deadlineIsDefault
            ? 'The training starts in less than 2 hours. Set an RSVP deadline that is still in the future.'
            : 'The RSVP deadline must be in the future.',
        );
      }
    }

    // --- Participants -------------------------------------------------------
    const minText = values.minParticipants.trim();
    const min = parseInteger(minText);
    if (minText === '') issue('minParticipants', 'Enter the minimum number of participants.');
    else if (min === null) issue('minParticipants', 'Enter a whole number.');
    else if (min < 1) issue('minParticipants', 'The minimum must be at least 1.');
    else if (isConfirmedEdit && min !== stored?.min_participants) {
      issue('minParticipants', 'The minimum cannot be changed after the training is confirmed.');
    }

    const maxText = values.maxParticipants.trim();
    const max = maxText === '' ? null : parseInteger(maxText);
    if (maxText !== '' && max === null) issue('maxParticipants', 'Enter a whole number.');
    else if (isConfirmedEdit && max !== (stored?.max_participants ?? null)) {
      issue('maxParticipants', 'The maximum cannot be changed after the training is confirmed.');
    } else if (max !== null) {
      if (min !== null && min >= 1 && max < min) {
        issue('maxParticipants', 'The maximum cannot be lower than the minimum.');
      } else if (stored && stored.status === 'scheduled' && max < stored.going_count) {
        const going = stored.going_count;
        issue(
          'maxParticipants',
          `${going} ${going === 1 ? 'participant is' : 'participants are'} already going, so the maximum cannot be lower than ${going}.`,
        );
      }
    }

    // --- Coordinates --------------------------------------------------------
    const latText = values.latitude.trim();
    const lngText = values.longitude.trim();
    const latitude = latText === '' ? null : parseDecimal(latText);
    const longitude = lngText === '' ? null : parseDecimal(lngText);

    if (latText !== '' && (latitude === null || latitude < -90 || latitude > 90)) {
      issue('latitude', 'Latitude must be a number between -90 and 90.');
    }
    if (lngText !== '' && (longitude === null || longitude < -180 || longitude > 180)) {
      issue('longitude', 'Longitude must be a number between -180 and 180.');
    }
    if (latText !== '' && lngText === '') issue('longitude', 'Enter the longitude too.');
    if (lngText !== '' && latText === '') issue('latitude', 'Enter the latitude too.');
  });
}

/**
 * Builds `p_input` from VALIDATED form values. `timezone` is the zone the
 * wall-clock fields are in. Pass the session being edited as `stored` so
 * untouched timestamps are sent back exactly as stored.
 *
 * Every key is sent (update is a full replace); empty optional fields are null
 * and an empty deadline is sent as start − 2 hours, the same default the
 * server applies. Throws RangeError when the values were not validated.
 */
export function toTrainingInput(
  values: TrainingFormValues,
  timezone: string,
  stored?: Pick<TrainingSession, 'starts_at' | 'ends_at' | 'rsvp_deadline'>,
): TrainingInput {
  if (!isValidTimeZone(timezone)) throw new RangeError(`Invalid time zone: ${String(timezone)}`);

  const { startsAt, endsAt, rsvpDeadline } = computeInstants(values, timezone, stored);
  const min = parseInteger(values.minParticipants);
  const maxText = values.maxParticipants.trim();
  const max = maxText === '' ? null : parseInteger(maxText);
  const latText = values.latitude.trim();
  const lngText = values.longitude.trim();
  const latitude = latText === '' ? null : parseDecimal(latText);
  const longitude = lngText === '' ? null : parseDecimal(lngText);

  if (
    startsAt === null ||
    rsvpDeadline === null ||
    min === null ||
    (values.endTime.trim() !== '' && endsAt === null) ||
    (maxText !== '' && max === null) ||
    (latText !== '' && latitude === null) ||
    (lngText !== '' && longitude === null)
  ) {
    throw new RangeError('toTrainingInput needs validated form values.');
  }

  return {
    title: values.title.trim(),
    description: optionalText(values.description),
    activity_type: values.activityType.trim() || DEFAULT_ACTIVITY_TYPE,
    starts_at: startsAt,
    ends_at: endsAt,
    rsvp_deadline: rsvpDeadline,
    timezone,
    location_name: values.locationName.trim(),
    address: optionalText(values.address),
    latitude,
    longitude,
    map_url: optionalText(values.mapUrl),
    meeting_instructions: optionalText(values.meetingInstructions),
    min_participants: min,
    max_participants: max,
  };
}

/** Prefills the edit form, with wall-clock values in the session's own zone. */
export function fromSession(
  session: Pick<
    TrainingSession,
    | 'title'
    | 'description'
    | 'activity_type'
    | 'starts_at'
    | 'ends_at'
    | 'rsvp_deadline'
    | 'timezone'
    | 'location_name'
    | 'address'
    | 'latitude'
    | 'longitude'
    | 'map_url'
    | 'meeting_instructions'
    | 'min_participants'
    | 'max_participants'
  >,
): TrainingFormValues {
  const start = utcToWallTime(session.starts_at, session.timezone);
  const deadline = utcToWallTime(session.rsvp_deadline, session.timezone);
  // The form keeps the end on the start's day; an end on another day shows its
  // time only and then fails "end after start", so it is never silently changed.
  const end = session.ends_at === null ? null : utcToWallTime(session.ends_at, session.timezone);

  return {
    title: session.title,
    description: session.description ?? '',
    activityType: session.activity_type,
    date: start.date,
    startTime: start.time,
    endTime: end?.time ?? '',
    deadlineDate: deadline.date,
    deadlineTime: deadline.time,
    locationName: session.location_name,
    address: session.address ?? '',
    latitude: session.latitude === null ? '' : String(session.latitude),
    longitude: session.longitude === null ? '' : String(session.longitude),
    mapUrl: session.map_url ?? '',
    meetingInstructions: session.meeting_instructions ?? '',
    minParticipants: String(session.min_participants),
    maxParticipants: session.max_participants === null ? '' : String(session.max_participants),
  };
}

const ALL_FIELDS: ReadonlySet<TrainingFormField> = new Set(TRAINING_FORM_FIELDS);
const FROZEN_WHEN_CONFIRMED: ReadonlySet<TrainingFormField> = new Set([
  'deadlineDate',
  'deadlineTime',
  'minParticipants',
  'maxParticipants',
]);
const CONFIRMED_FIELDS: ReadonlySet<TrainingFormField> = new Set(
  TRAINING_FORM_FIELDS.filter((field) => !FROZEN_WHEN_CONFIRMED.has(field)),
);
const NO_FIELDS: ReadonlySet<TrainingFormField> = new Set();

/**
 * Form fields an organizer may change, per the contract's update rules:
 * scheduled = everything; confirmed = everything except the deadline and the
 * participant limits; cancelled / completed = nothing (`session_not_editable`).
 */
export function editableFields(status: SessionStatus): ReadonlySet<TrainingFormField> {
  switch (status) {
    case 'scheduled':
      return ALL_FIELDS;
    case 'confirmed':
      return CONFIRMED_FIELDS;
    case 'cancelled':
    case 'completed':
      return NO_FIELDS;
  }
}

/** True when the session can be opened in the edit form at all. */
export function isEditable(status: SessionStatus): boolean {
  return editableFields(status).size > 0;
}
