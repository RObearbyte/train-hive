/**
 * Display helpers for the create / edit training form: where a server
 * validation error belongs, which fields are locked, and what the default
 * RSVP deadline will be.
 *
 * `now` is injected and for display only. The server decides what is
 * actually frozen and rejects a change with `validation_failed:<field>`.
 */
import type { TrainingSession } from '@/lib/database.types';
import {
  defaultRsvpDeadline,
  formatDateTime,
  isValidDateString,
  isValidTimeString,
  isValidTimeZone,
  utcToWallTime,
  wallTimeToUtc,
  type WallTime,
} from '@/lib/datetime';
import { userMessage, type AppErrorCode } from '@/lib/errors';

import { TRAINING_FORM_FIELDS, editableFields, type TrainingFormField } from './schema';
import { hasPredictedEnded } from './status';

/** `p_input` column → the form field that edits it. `timezone` has no field. */
const COLUMN_TO_FIELD: Readonly<Record<string, TrainingFormField>> = {
  title: 'title',
  description: 'description',
  activity_type: 'activityType',
  starts_at: 'date',
  ends_at: 'endTime',
  rsvp_deadline: 'deadlineDate',
  location_name: 'locationName',
  address: 'address',
  latitude: 'latitude',
  longitude: 'longitude',
  map_url: 'mapUrl',
  meeting_instructions: 'meetingInstructions',
  min_participants: 'minParticipants',
  max_participants: 'maxParticipants',
};

/** Server rules the client cannot fully check, said in the server's terms. */
const COLUMN_MESSAGES: Readonly<Record<string, string>> = {
  starts_at:
    'The start must be in the future and after the RSVP deadline. It cannot change once the training has ended or attendance has been recorded.',
  ends_at:
    'The end time must be after the start time. It cannot change once the training has ended or attendance has been recorded.',
  rsvp_deadline:
    'The RSVP deadline must be in the future and before the start. It cannot be changed once responses have closed.',
  min_participants:
    'The minimum must be at least 1. It cannot be changed once responses have closed.',
  max_participants:
    'The maximum cannot be lower than the minimum or the number already going. It cannot be changed once responses have closed.',
};

/** The form field for a `validation_failed:<column>` column, or null when there is none. */
export function formFieldForColumn(column: string | undefined): TrainingFormField | null {
  if (column === undefined || !Object.hasOwn(COLUMN_TO_FIELD, column)) return null;
  return COLUMN_TO_FIELD[column];
}

/**
 * Where to show a failed save: on a form field (with its message) when the
 * server named a column the form edits, otherwise null (show a banner).
 */
export function serverFieldError(error: {
  code: AppErrorCode;
  field?: string | undefined;
}): { field: TrainingFormField; message: string } | null {
  if (error.code !== 'validation_failed') return null;
  const field = formFieldForColumn(error.field);
  if (field === null || error.field === undefined) return null;
  const message = Object.hasOwn(COLUMN_MESSAGES, error.field)
    ? COLUMN_MESSAGES[error.field]
    : userMessage('validation_failed', error.field);
  return { field, message };
}

export type FrozenFields = {
  fields: ReadonlySet<TrainingFormField>;
  /** One short sentence for the locked fields, or null when nothing is locked. */
  reason: string | null;
  /** Sentence for the date / start / end fields when they are locked by the ended rule, else null. */
  timeReason: string | null;
};

const NOTHING_FROZEN: FrozenFields = {
  fields: new Set(),
  reason: null,
  timeReason: null,
};

const TIME_FIELDS: readonly TrainingFormField[] = ['date', 'startTime', 'endTime'];
export const ENDED_TIME_REASON = 'This training has already ended';

function allExcept(editable: ReadonlySet<TrainingFormField>): ReadonlySet<TrainingFormField> {
  return new Set(TRAINING_FORM_FIELDS.filter((field) => !editable.has(field)));
}

/**
 * Fields to show as locked in the edit form. Besides the per-status rule, a
 * scheduled session whose deadline has passed is only waiting for the server's
 * decision, and the server freezes its deadline and limits like a confirmed one.
 */
export function frozenFormFields(
  session: Pick<TrainingSession, 'status' | 'rsvp_deadline' | 'starts_at' | 'ends_at'>,
  now: Date,
): FrozenFields {
  switch (session.status) {
    case 'confirmed': {
      const fields = new Set(allExcept(editableFields('confirmed')));
      // The server freezes the time of a confirmed session once it has ended (or has attendance
      // records, which the client cannot see). Prediction only; the server stays the authority.
      const ended = hasPredictedEnded(session, now);
      if (ended) for (const field of TIME_FIELDS) fields.add(field);
      return {
        fields,
        reason: 'Locked because the training is confirmed.',
        timeReason: ended ? ENDED_TIME_REASON : null,
      };
    }
    case 'cancelled':
    case 'completed':
      return {
        fields: allExcept(editableFields(session.status)),
        reason: 'This training can no longer be edited.',
        timeReason: null,
      };
    case 'scheduled':
      if (now.getTime() >= new Date(session.rsvp_deadline).getTime()) {
        return {
          fields: allExcept(editableFields('confirmed')),
          reason: 'Locked because the RSVP deadline has passed.',
          timeReason: null,
        };
      }
      return NOTHING_FROZEN;
  }
}

/**
 * The deadline used when none is entered (start minus 2 hours) in the
 * session's zone: as wall time, and formatted, e.g. "Sat 14 Nov, 07:00".
 * Null until the date and start time are valid.
 */
export function defaultDeadline(
  values: { date: string; startTime: string },
  timezone: string,
): { wall: WallTime; text: string } | null {
  const date = values.date.trim();
  const startTime = values.startTime.trim();
  if (!isValidTimeZone(timezone) || !isValidDateString(date) || !isValidTimeString(startTime)) {
    return null;
  }
  const instant = defaultRsvpDeadline(wallTimeToUtc(date, startTime, timezone));
  return {
    wall: utcToWallTime(instant, timezone),
    text: formatDateTime(instant, timezone),
  };
}
