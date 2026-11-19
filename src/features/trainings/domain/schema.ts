/**
 * Create / edit event form (any kind): validation, payload building and prefill.
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

import type {
  EventKind,
  SessionStatus,
  TrainingInput,
  TrainingSession,
} from '@/lib/database.types';
import {
  defaultRsvpDeadline,
  isValidDateString,
  isValidTimeString,
  isValidTimeZone,
  utcToWallTime,
  wallTimeToUtc,
} from '@/lib/datetime';

import { EVENT_KINDS, defaultSubtype, isTraining, takesCourse, takesObstacles } from './events';

/** Length in characters (code points), as Postgres `char_length` counts, not UTF-16 units. */
function charCount(text: string): number {
  return Array.from(text).length;
}

export const TITLE_MAX = 80;
export const LOCATION_NAME_MAX = 120;
export const DESCRIPTION_MAX = 2000;
export const ADDRESS_MAX = 200;
export const MAP_URL_MAX = 2048;
export const MEETING_INSTRUCTIONS_MAX = 1000;
export const EVENT_NOTES_MAX = 1000;
export const DISTANCE_KM_MAX = 1000;
export const ELEVATION_GAIN_MAX = 20000;
export const OBSTACLE_COUNT_MAX = 500;

export const TRAINING_FORM_FIELDS = [
  'title',
  'description',
  'eventKind',
  'eventSubtype',
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
  'distanceKm',
  'elevationGainM',
  'obstacleCount',
  'eventNotes',
] as const;

export type TrainingFormField = (typeof TRAINING_FORM_FIELDS)[number];

/**
 * Every field is a string, as typed. Optional fields are '' when empty.
 * - `date`, `deadlineDate`: `yyyy-MM-dd`; `startTime`, `endTime`, `deadlineTime`: `HH:mm`.
 * - `eventKind` is one of the four kinds (immutable once the event exists).
 * - `distanceKm` accepts a decimal comma; the course fields only count for subtypes that take them.
 * - `endTime` is on the same day as `date`.
 * - `deadlineDate` + `deadlineTime` both empty = default (2 hours before the start).
 */
export type TrainingFormValues = Record<TrainingFormField, string>;

/** The stored values an edit is checked against. */
export type EditedSession = Pick<
  TrainingSession,
  | 'status'
  | 'event_kind'
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

export function emptyTrainingForm(
  kind: EventKind = 'training',
  subtype: string = defaultSubtype(kind),
): TrainingFormValues {
  return {
    title: '',
    description: '',
    eventKind: kind,
    eventSubtype: subtype,
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
    distanceKm: '',
    elevationGainM: '',
    obstacleCount: '',
    eventNotes: '',
  };
}

const INTEGER_PATTERN = /^\d{1,9}$/;
// Accepts a decimal comma, which is what many European keyboards type.
const DECIMAL_PATTERN = /^[+-]?\d+(?:[.,]\d+)?$/;
// At most 2 decimals, like numeric(6,2) on the server (never rounded silently).
const DISTANCE_PATTERN = /^\d+(?:[.,]\d{1,2})?$/;
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
  eventKind: z.string(),
  eventSubtype: z.string(),
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
  distanceKm: z.string(),
  elevationGainM: z.string(),
  obstacleCount: z.string(),
  eventNotes: z.string(),
});

function asKind(value: string): EventKind | null {
  return (EVENT_KINDS as readonly string[]).includes(value) ? (value as EventKind) : null;
}

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
  const nowMs = now.getTime();

  return formShape.superRefine((values, ctx) => {
    const issue = (field: TrainingFormField, message: string) =>
      ctx.addIssue({ code: 'custom', path: [field], message });

    // --- Kind and subtype ----------------------------------------------------
    const kind = asKind(values.eventKind);
    if (kind === null) issue('eventKind', 'Choose what kind of event this is.');
    else if (stored && stored.event_kind !== kind) {
      issue('eventKind', 'The kind of an event cannot be changed after it is created.');
    }
    const training = kind === null || isTraining(kind);
    const subtype = values.eventSubtype.trim();
    if (subtype === '') issue('eventSubtype', 'Choose a type.');
    // A training whose registration is decided keeps its deadline and limits; a non-training event
    // only loses its deadline once the (stored) deadline has passed. Display rule; the server decides.
    const storedDeadlinePassed =
      stored !== undefined && nowMs >= new Date(stored.rsvp_deadline).getTime();
    // The server also freezes a scheduled training whose deadline has passed (the minutes before
    // the finalizer decides it).
    const trainingDecided =
      training &&
      (stored?.status === 'confirmed' || (stored?.status === 'scheduled' && storedDeadlinePassed));
    const deadlineFrozen =
      (stored?.status === 'confirmed' && (training || storedDeadlinePassed)) || trainingDecided;
    const limitsFrozen = trainingDecided;
    const frozenSince =
      stored?.status === 'confirmed' ? 'after the training is confirmed' : 'once the deadline has passed';
    const noun = training ? 'training' : 'event';

    // --- Text -------------------------------------------------------------
    const title = values.title.trim();
    if (title === '') issue('title', 'Enter a title.');
    else if (charCount(title) > TITLE_MAX) issue('title', `Keep the title to ${TITLE_MAX} characters.`);

    const locationName = values.locationName.trim();
    if (locationName === '') issue('locationName', `Enter where the ${noun} takes place.`);
    else if (charCount(locationName) > LOCATION_NAME_MAX) {
      issue('locationName', `Keep the location name to ${LOCATION_NAME_MAX} characters.`);
    }

    const mapUrl = values.mapUrl.trim();
    if (mapUrl !== '' && !HTTP_URL_PATTERN.test(mapUrl)) {
      issue('mapUrl', 'Enter a link that starts with http:// or https://.');
    } else if (mapUrl.length > MAP_URL_MAX) {
      issue('mapUrl', 'This link is too long. Use a shorter share link.');
    }

    // Same length caps as the server.
    if (values.description.trim().length > DESCRIPTION_MAX) {
      issue('description', `Keep the description to ${DESCRIPTION_MAX} characters.`);
    }
    if (values.address.trim().length > ADDRESS_MAX) {
      issue('address', `Keep the address to ${ADDRESS_MAX} characters.`);
    }
    if (values.meetingInstructions.trim().length > MEETING_INSTRUCTIONS_MAX) {
      issue(
        'meetingInstructions',
        `Keep the meeting instructions to ${MEETING_INSTRUCTIONS_MAX} characters.`,
      );
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

    // "In the future" applies to every timestamp on create, and on edit only to
    // timestamps that were changed (the server compares by instant).
    const isEdit = context.mode === 'edit';
    let startIsPast = false;
    if (startMs !== null) {
      const mustBeFuture =
        !isEdit || !sameInstant(startsAt, stored?.starts_at ?? null);
      if (mustBeFuture && startMs <= nowMs) {
        startIsPast = true;
        issue('date', 'The start must be in the future.');
      }
    }

    if (startMs !== null && endMs !== null) {
      if (endMs <= startMs) issue('endTime', 'The end time must be after the start time.');
      else if (
        isEdit &&
        !sameInstant(endsAt, stored?.ends_at ?? null) &&
        endMs <= nowMs
      ) {
        issue('endTime', 'The end time must be in the future.');
      }
    }

    if (deadlineFrozen) {
      if (deadlineMs !== null && !sameInstant(rsvpDeadline, stored?.rsvp_deadline ?? null)) {
        issue(
          'deadlineDate',
          training
            ? `The RSVP deadline cannot be changed ${frozenSince}.`
            : 'Registration has closed, so the deadline can no longer be changed.',
        );
      } else if (!training && deadlineMs !== null && startMs !== null && deadlineMs >= startMs) {
        issue('date', 'The new start must be after the registration deadline.');
      }
    } else if (deadlineMs !== null && startMs !== null) {
      // Strictly before: the server rejects a deadline equal to the start.
      if (deadlineMs >= startMs) {
        issue(
          'deadlineDate',
          `The ${training ? 'RSVP' : 'registration'} deadline must be before the start.`,
        );
      } else if (
        deadlineMs <= nowMs &&
        !startIsPast &&
        (!isEdit || !sameInstant(rsvpDeadline, stored?.rsvp_deadline ?? null))
      ) {
        issue(
          'deadlineDate',
          deadlineIsDefault
            ? `The ${noun} starts in less than 2 hours. Set ${training ? 'an RSVP deadline' : 'a registration deadline'} that is still in the future.`
            : `The ${training ? 'RSVP' : 'registration'} deadline must be in the future.`,
        );
      }
    }

    // --- Participants -------------------------------------------------------
    // Only a training has a minimum (required). Every other kind never sends one.
    let min: number | null = null;
    if (training) {
      const minText = values.minParticipants.trim();
      min = parseInteger(minText);
      if (minText === '') issue('minParticipants', 'Enter the minimum number of participants.');
      else if (min === null) issue('minParticipants', 'Enter a whole number.');
      else if (min < 1) issue('minParticipants', 'The minimum must be at least 1.');
      else if (limitsFrozen && min !== stored?.min_participants) {
        issue('minParticipants', `The minimum cannot be changed ${frozenSince}.`);
      }
    }

    const maxText = values.maxParticipants.trim();
    const max = maxText === '' ? null : parseInteger(maxText);
    if (maxText !== '' && max === null) issue('maxParticipants', 'Enter a whole number.');
    else if (limitsFrozen && max !== (stored?.max_participants ?? null)) {
      issue('maxParticipants', `The maximum cannot be changed ${frozenSince}.`);
    } else if (max !== null) {
      if (min !== null && min >= 1 && max < min) {
        issue('maxParticipants', 'The maximum cannot be lower than the minimum.');
      } else if (stored && !limitsFrozen && max < stored.going_count) {
        const going = stored.going_count;
        issue(
          'maxParticipants',
          `${going} ${going === 1 ? 'participant is' : 'participants are'} already going, so the maximum cannot be lower than ${going}.`,
        );
      } else if (max < 1) {
        issue('maxParticipants', 'The maximum must be at least 1.');
      }
    }

    // --- Course (running-type subtypes) and notes ----------------------------
    if (takesCourse(subtype)) {
      const distanceText = values.distanceKm.trim();
      if (distanceText !== '') {
        if (!DISTANCE_PATTERN.test(distanceText)) {
          issue('distanceKm', 'Enter a distance in km with at most 2 decimals, for example 21.1.');
        } else {
          const km = Number(distanceText.replace(',', '.'));
          if (km <= 0) issue('distanceKm', 'The distance must be more than 0 km.');
          else if (km > DISTANCE_KM_MAX) {
            issue('distanceKm', `The distance cannot be more than ${DISTANCE_KM_MAX} km.`);
          }
        }
      }
      const elevationText = values.elevationGainM.trim();
      if (elevationText !== '') {
        const elevation = parseInteger(elevationText);
        if (elevation === null) issue('elevationGainM', 'Enter whole metres, for example 450.');
        else if (elevation > ELEVATION_GAIN_MAX) {
          issue('elevationGainM', `D+ cannot be more than ${ELEVATION_GAIN_MAX} m.`);
        }
      }
    }
    if (takesObstacles(subtype)) {
      const obstacleText = values.obstacleCount.trim();
      if (obstacleText !== '') {
        const obstacles = parseInteger(obstacleText);
        if (obstacles === null) issue('obstacleCount', 'Enter a whole number.');
        else if (obstacles > OBSTACLE_COUNT_MAX) {
          issue('obstacleCount', `There cannot be more than ${OBSTACLE_COUNT_MAX} obstacles.`);
        }
      }
    }
    if (charCount(values.eventNotes.trim()) > EVENT_NOTES_MAX) {
      issue('eventNotes', `Keep the notes to ${EVENT_NOTES_MAX} characters.`);
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
 * and an empty deadline is sent as start - 2 hours, the same default the
 * server applies. `event_kind` and `event_subtype` are always sent
 * (`activity_type` is left out: the server derives it). Only a training sends a
 * minimum; every other kind sends null. Course fields the subtype does not take
 * are sent as null, which also clears a stored value when the subtype changes.
 * Throws RangeError when the values were not validated.
 */
export function toTrainingInput(
  values: TrainingFormValues,
  timezone: string,
  stored?: Pick<TrainingSession, 'starts_at' | 'ends_at' | 'rsvp_deadline'>,
): TrainingInput {
  if (!isValidTimeZone(timezone)) throw new RangeError(`Invalid time zone: ${String(timezone)}`);

  const kind = asKind(values.eventKind);
  const subtype = values.eventSubtype.trim();
  const { startsAt, endsAt, rsvpDeadline } = computeInstants(values, timezone, stored);
  const training = kind !== null && isTraining(kind);
  const min = training ? parseInteger(values.minParticipants) : null;
  const maxText = values.maxParticipants.trim();
  const max = maxText === '' ? null : parseInteger(maxText);
  const latText = values.latitude.trim();
  const lngText = values.longitude.trim();
  const latitude = latText === '' ? null : parseDecimal(latText);
  const longitude = lngText === '' ? null : parseDecimal(lngText);

  const distanceText = takesCourse(subtype) ? values.distanceKm.trim() : '';
  const distance = distanceText === '' ? null : parseDecimal(distanceText);
  const elevationText = takesCourse(subtype) ? values.elevationGainM.trim() : '';
  const elevation = elevationText === '' ? null : parseInteger(elevationText);
  const obstacleText = takesObstacles(subtype) ? values.obstacleCount.trim() : '';
  const obstacles = obstacleText === '' ? null : parseInteger(obstacleText);

  if (
    kind === null ||
    subtype === '' ||
    startsAt === null ||
    rsvpDeadline === null ||
    (training && min === null) ||
    (values.endTime.trim() !== '' && endsAt === null) ||
    (maxText !== '' && max === null) ||
    (latText !== '' && latitude === null) ||
    (lngText !== '' && longitude === null) ||
    (distanceText !== '' && distance === null) ||
    (elevationText !== '' && elevation === null) ||
    (obstacleText !== '' && obstacles === null)
  ) {
    throw new RangeError('toTrainingInput needs validated form values.');
  }

  const common = {
    title: values.title.trim(),
    description: optionalText(values.description),
    event_subtype: subtype,
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
    max_participants: max,
    distance_km: distance,
    elevation_gain_m: elevation,
    obstacle_count: obstacles,
    event_notes: optionalText(values.eventNotes),
  };

  if (kind === 'training') {
    return { ...common, event_kind: 'training', min_participants: min as number };
  }
  return { ...common, event_kind: kind, min_participants: null };
}

/** Prefills the edit form, with wall-clock values in the session's own zone. */
export function fromSession(
  session: Pick<
    TrainingSession,
    | 'title'
    | 'description'
    | 'event_kind'
    | 'event_subtype'
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
    | 'distance_km'
    | 'elevation_gain_m'
    | 'obstacle_count'
    | 'event_notes'
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
    eventKind: session.event_kind,
    eventSubtype: session.event_subtype,
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
    minParticipants: session.min_participants === null ? '' : String(session.min_participants),
    maxParticipants: session.max_participants === null ? '' : String(session.max_participants),
    distanceKm: session.distance_km === null ? '' : String(session.distance_km),
    elevationGainM: session.elevation_gain_m === null ? '' : String(session.elevation_gain_m),
    obstacleCount: session.obstacle_count === null ? '' : String(session.obstacle_count),
    eventNotes: session.event_notes ?? '',
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
// Non-training event after its registration deadline: only the deadline is frozen, the maximum stays editable.
const AFTER_DEADLINE_FIELDS: ReadonlySet<TrainingFormField> = new Set(
  TRAINING_FORM_FIELDS.filter((field) => field !== 'deadlineDate' && field !== 'deadlineTime'),
);
const NO_FIELDS: ReadonlySet<TrainingFormField> = new Set();

/**
 * Form fields an organizer may change, per the contract's update rules.
 * - training: scheduled = everything; confirmed = everything except the deadline and the
 *   participant limits.
 * - other kinds (always confirmed): everything while registration is open; once the deadline has
 *   passed (`deadlinePassed`) only the deadline is locked (the maximum stays editable).
 * - cancelled / completed: nothing (`session_not_editable`).
 * The kind itself is never editable: the form shows it, locked.
 */
export function editableFields(
  status: SessionStatus,
  kind: EventKind = 'training',
  deadlinePassed = false,
): ReadonlySet<TrainingFormField> {
  switch (status) {
    case 'scheduled':
      return ALL_FIELDS;
    case 'confirmed':
      if (isTraining(kind)) return CONFIRMED_FIELDS;
      return deadlinePassed ? AFTER_DEADLINE_FIELDS : ALL_FIELDS;
    case 'cancelled':
    case 'completed':
      return NO_FIELDS;
  }
}

/** True when the session can be opened in the edit form at all. */
export function isEditable(status: SessionStatus): boolean {
  return editableFields(status).size > 0;
}
