/**
 * Form rules for creating and editing a community, mirroring the server
 * (`create_community_with_code`, `update_community`): the name is 1 to 80
 * characters after whitespace is collapsed, the time zone is `UTC` or an IANA
 * `Area/Location`. The server stays the authority; its `validation_failed`
 * answers are mapped onto the same fields.
 */
import { z } from 'zod';

import { displayNameSchema } from '@/features/onboarding/domain/displayName';
import { isValidTimeZone } from '@/lib/datetime';

export const COMMUNITY_NAME_MIN = 1;
export const COMMUNITY_NAME_MAX = 80;

const AREA_LOCATION = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/;

/** Collapses whitespace runs to one space and trims, like the server does for titles. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function characterCount(text: string): number {
  return Array.from(text).length;
}

/**
 * True for `UTC` and for IANA names the runtime knows in `Area/Location`
 * form. Abbreviations ("EST"), `posix/...` and `Factory` are rejected, as the
 * server does.
 */
export function isCommunityTimeZone(zone: unknown): zone is string {
  if (!isValidTimeZone(zone)) return false;
  if (zone === 'UTC') return true;
  return AREA_LOCATION.test(zone) && !/^(posix|right)\//i.test(zone) && zone !== 'Factory';
}

export const communityNameSchema = z
  .string()
  .transform(collapseWhitespace)
  .refine((name) => characterCount(name) >= COMMUNITY_NAME_MIN, {
    message: 'Enter a community name.',
  })
  .refine((name) => characterCount(name) <= COMMUNITY_NAME_MAX, {
    message: `Keep the name to ${COMMUNITY_NAME_MAX} characters.`,
  });

export const timeZoneSchema = z.string().refine(isCommunityTimeZone, {
  message: 'Choose a time zone from the list.',
});

/** Creator flow, screen 2. */
export const createCommunityFormSchema = z.object({
  name: communityNameSchema,
  timezone: timeZoneSchema,
  displayName: displayNameSchema,
});
export type CreateCommunityFormInput = z.input<typeof createCommunityFormSchema>;
export type CreateCommunityFormValues = z.output<typeof createCommunityFormSchema>;

/** Community settings (organizers). */
export const communitySettingsFormSchema = z.object({
  name: communityNameSchema,
  timezone: timeZoneSchema,
});
export type CommunitySettingsFormInput = z.input<typeof communitySettingsFormSchema>;
export type CommunitySettingsFormValues = z.output<typeof communitySettingsFormSchema>;

/** Note shown next to the time zone in settings. */
export const TIMEZONE_CHANGE_NOTE =
  'Existing trainings keep their own time zone. Statistics will group months and weeks using the new time zone.';

export const SHARED_NAME_NOTE = 'Your name is shared across all your communities.';
