/**
 * The Home feed: what is next, what is coming up and the latest announcements.
 * Pure. `now` is for display grouping only; the server decides everything
 * that matters (status, deadlines).
 *
 * Decisions:
 * - "Next up" is the first upcoming event that is not cancelled (as before).
 * - "Coming up" is the other upcoming events (cancelled ones included, so
 *   members still see the cancellation) that start within the next 30 days,
 *   at most 10, nearest first. When fewer than 3 fall in that window it is
 *   topped up with the following events, so a quiet month still shows
 *   something. "See all events" opens the Events tab for the rest.
 * - "Latest announcements" are the 3 most recently published ones.
 */
import type { Announcement, TrainingSession } from '@/lib/database.types';
import { nextSession, splitSessions } from '@/features/trainings/domain/status';

export const COMING_UP_DAYS = 30;
export const COMING_UP_MAX = 10;
export const COMING_UP_MIN = 3;
export const LATEST_ANNOUNCEMENTS = 3;

const DAY_MS = 24 * 60 * 60_000;

export type HomeFeed = {
  nextUp: TrainingSession | null;
  comingUp: TrainingSession[];
  latestAnnouncements: Announcement[];
};

function publishedTime(item: Announcement): number {
  const time = item.published_at ? new Date(item.published_at).getTime() : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
}

export function buildHomeFeed(
  events: readonly TrainingSession[],
  announcements: readonly Announcement[],
  now: Date,
): HomeFeed {
  const { upcoming } = splitSessions(events, now);
  const nextUp = nextSession(events, now);
  const rest = upcoming.filter((session) => session.id !== nextUp?.id);

  const horizon = now.getTime() + COMING_UP_DAYS * DAY_MS;
  const inWindow = rest.filter((session) => new Date(session.starts_at).getTime() <= horizon);
  let comingUp = inWindow.slice(0, COMING_UP_MAX);
  if (comingUp.length < COMING_UP_MIN) comingUp = rest.slice(0, COMING_UP_MIN);

  const published = announcements
    .filter((item) => item.status === 'published')
    .sort((a, b) => publishedTime(b) - publishedTime(a) || (a.id < b.id ? -1 : 1));
  const latestAnnouncements = published.slice(0, LATEST_ANNOUNCEMENTS);

  return {
    nextUp,
    comingUp,
    latestAnnouncements,
  };
}
