/**
 * Organizer announcement form: validation and payload building.
 *
 * The form holds strings. When scheduling, `date` (`yyyy-MM-dd`) and `time`
 * (`HH:mm`) are wall-clock values in the COMMUNITY's time zone, converted to a
 * UTC instant here. `now` is injected and advisory: only the server decides
 * whether the time is in the future (`validation_failed:scheduled_for`) and
 * only the server publishes.
 */
import { z } from 'zod';

import type { Announcement } from '@/lib/database.types';
import {
  isValidDateString,
  isValidTimeString,
  isValidTimeZone,
  utcToWallTime,
  wallTimeToUtc,
} from '@/lib/datetime';

export const ANNOUNCEMENT_TITLE_MAX = 100;
export const ANNOUNCEMENT_BODY_MAX = 2000;
/** The server rejects a publish time further out than this. */
export const ANNOUNCEMENT_MAX_DAYS_AHEAD = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

export type PublishMode = 'now' | 'schedule';

export type AnnouncementFormValues = {
  title: string;
  body: string;
  mode: PublishMode;
  date: string;
  time: string;
};

export type AnnouncementFormField = keyof AnnouncementFormValues;

export type AnnouncementInput = {
  title: string;
  body: string;
  /** UTC ISO instant, or null to publish now. */
  scheduledFor: string | null;
};

/** Length in characters (code points), as Postgres `char_length` counts. */
function charCount(text: string): number {
  return Array.from(text).length;
}

export function emptyAnnouncementForm(): AnnouncementFormValues {
  return { title: '', body: '', mode: 'now', date: '', time: '', };
}

/** Prefill for editing a scheduled announcement, in the community's zone. */
export function fromAnnouncement(
  announcement: Pick<Announcement, 'title' | 'body' | 'scheduled_for'>,
  timezone: string,
): AnnouncementFormValues {
  if (announcement.scheduled_for === null) {
    return { title: announcement.title, body: announcement.body, mode: 'now', date: '', time: '' };
  }
  const wall = utcToWallTime(announcement.scheduled_for, timezone);
  return {
    title: announcement.title,
    body: announcement.body,
    mode: 'schedule',
    date: wall.date,
    time: wall.time,
  };
}

const shape = z.object({
  title: z.string(),
  body: z.string(),
  mode: z.enum(['now', 'schedule']),
  date: z.string(),
  time: z.string(),
});

export function announcementFormSchema(context: { timezone: string; now: Date }) {
  if (!isValidTimeZone(context.timezone)) {
    throw new RangeError(`Invalid time zone: ${String(context.timezone)}`);
  }
  const { timezone } = context;
  const nowMs = context.now.getTime();

  return shape.superRefine((values, ctx) => {
    const issue = (field: AnnouncementFormField, message: string) =>
      ctx.addIssue({ code: 'custom', path: [field], message });

    const title = values.title.trim();
    if (title === '') issue('title', 'Enter a title.');
    else if (/[\r\n]/.test(title)) issue('title', 'The title must be a single line.');
    else if (charCount(title) > ANNOUNCEMENT_TITLE_MAX) {
      issue('title', `Keep the title to ${ANNOUNCEMENT_TITLE_MAX} characters.`);
    }

    const body = values.body.trim();
    if (body === '') issue('body', 'Write the announcement.');
    else if (charCount(body) > ANNOUNCEMENT_BODY_MAX) {
      issue('body', `Keep the message to ${ANNOUNCEMENT_BODY_MAX} characters.`);
    }

    if (values.mode !== 'schedule') return;

    const date = values.date.trim();
    const time = values.time.trim();
    if (date === '') issue('date', 'Choose a date.');
    else if (!isValidDateString(date)) issue('date', 'Enter a valid date.');
    if (time === '') issue('time', 'Choose a time.');
    else if (!isValidTimeString(time)) issue('time', 'Enter a valid time.');
    if (!isValidDateString(date) || !isValidTimeString(time)) return;

    const instantMs = new Date(wallTimeToUtc(date, time, timezone)).getTime();
    if (instantMs <= nowMs) issue('date', 'The publish time must be in the future.');
    else if (instantMs > nowMs + ANNOUNCEMENT_MAX_DAYS_AHEAD * DAY_MS) {
      issue('date', `Schedule at most ${ANNOUNCEMENT_MAX_DAYS_AHEAD} days ahead.`);
    }
  });
}

/** The RPC arguments. Call only for values that passed the schema. */
export function toAnnouncementInput(
  values: AnnouncementFormValues,
  timezone: string,
): AnnouncementInput {
  return {
    title: values.title.trim(),
    body: values.body.trim(),
    scheduledFor:
      values.mode === 'schedule' ? wallTimeToUtc(values.date.trim(), values.time.trim(), timezone) : null,
  };
}

/** Which field a `validation_failed:<field>` from the server belongs to. */
export function announcementFieldForServerError(field: string | undefined): AnnouncementFormField | null {
  switch (field) {
    case 'title':
      return 'title';
    case 'body':
      return 'body';
    case 'scheduled_for':
      return 'date';
    default:
      return null;
  }
}
