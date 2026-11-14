/**
 * Display name rule from the contract: trimmed, 2–40 characters
 * (`invalid_display_name` on the server).
 */
import { z } from 'zod';

export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 40;

/** Counts characters the way Postgres `char_length` does (code points, not UTF-16 units). */
function characterCount(text: string): number {
  return Array.from(text).length;
}

/** Parses to the trimmed name. */
export const displayNameSchema = z
  .string()
  .trim()
  .refine((name) => characterCount(name) >= DISPLAY_NAME_MIN, {
    message: `Enter at least ${DISPLAY_NAME_MIN} characters.`,
  })
  .refine((name) => characterCount(name) <= DISPLAY_NAME_MAX, {
    message: `Keep your name to ${DISPLAY_NAME_MAX} characters.`,
  });

/** Schema for a form with a single `displayName` field. */
export const displayNameFormSchema = z.object({ displayName: displayNameSchema });

export type DisplayNameFormValues = z.infer<typeof displayNameFormSchema>;
