import type { Href } from 'expo-router';

/**
 * Announcement routes. Built from an id we hold, never from push data (that
 * goes through the deep-link allowlist). Cast because expo-router's generated
 * route types only learn a new dynamic route when the dev server regenerates
 * them.
 */
export const announcementHref = (id: string) => `/announcements/${id}` as Href;
export const announcementEditHref = (id: string) => `/announcements/${id}/edit` as Href;
/** The list of all announcements (Home feed: "See all announcements"). */
export const announcementsListHref = '/announcements' as Href;

/** The discussion of an event (also the target of the `event_post` / `event_reply` deep link). */
export const eventFeedHref = (sessionId: string) => `/events/${sessionId}/feed` as Href;

/** The workout log of an event (also the target of the `workout_log_prompt` deep link). */
export const workoutLogHref = (sessionId: string) => `/events/${sessionId}/log` as Href;
/** The member's own list of logged workouts. */
export const myWorkoutsHref = '/my-workouts' as Href;
/** The member's own personal bests (running bests and confirmed lift records). */
export const personalBestsHref = '/personal-bests' as Href;
