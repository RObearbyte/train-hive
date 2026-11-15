/**
 * Wording for the Activity tab. Times are shown in the community's zone, never
 * the device's, and never imply the client publishes anything.
 */
import type { Announcement, AnnouncementStatus } from '@/lib/database.types';
import { formatDateTime, formatSessionWhen, isValidTimeZone, zoneCityName } from '@/lib/datetime';

export const ANNOUNCEMENT_STATUS_LABEL: Record<AnnouncementStatus, string> = {
  scheduled: 'Scheduled',
  published: 'Published',
  cancelled: 'Cancelled',
};

function zoneOrUtc(zone: string): string {
  return isValidTimeZone(zone) ? zone : 'UTC';
}

/** "Will be published at Sat 14 Nov, 09:00 (Europe/Bucharest)". */
export function scheduledNote(
  announcement: Pick<Announcement, 'scheduled_for'>,
  zone: string,
): string {
  if (announcement.scheduled_for === null) return 'Not scheduled.';
  const safeZone = zoneOrUtc(zone);
  return `Will be published at ${formatDateTime(announcement.scheduled_for, safeZone)} (${safeZone})`;
}

/** "Today, 09:00" for a published announcement; '' while it has no publish time. */
export function publishedWhen(
  announcement: Pick<Announcement, 'published_at'>,
  zone: string,
  now: Date,
): string {
  if (announcement.published_at === null) return '';
  return formatSessionWhen(announcement.published_at, zoneOrUtc(zone), now);
}

/** "Bucharest time" for helper text under the scheduling fields. */
export function zoneHelper(zone: string): string {
  const safeZone = zoneOrUtc(zone);
  return `Times are in ${zoneCityName(safeZone)} time (${safeZone}).`;
}

/** First line(s) of a body for a list row. */
export function bodyPreview(body: string, max = 120): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** Scheduled first (soonest first), then cancelled (newest first): the organizer's management list. */
export function sortManaged(list: readonly Announcement[]): Announcement[] {
  const scheduled = list
    .filter((item) => item.status === 'scheduled')
    .sort((a, b) => (a.scheduled_for ?? '').localeCompare(b.scheduled_for ?? ''));
  const cancelled = list
    .filter((item) => item.status === 'cancelled')
    .sort((a, b) => (b.cancelled_at ?? '').localeCompare(a.cancelled_at ?? ''));
  return [...scheduled, ...cancelled];
}
