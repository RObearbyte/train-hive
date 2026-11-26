/** Browser tab titles for the web build. Pure. */
export const APP_TITLE = 'TrainHive';

const TITLES: [RegExp, string][] = [
  [/^\/?$/, 'Home'],
  [/^\/welcome$/, 'Welcome'],
  [/^\/join$/, 'Join a community'],
  [/^\/(code|add-community\/join-code)$/, 'Join a community'],
  [/^\/(name|add-community\/join-name)$/, 'Your name'],
  [/^\/(creator-code|add-community\/creator-code)$/, 'Creator code'],
  [/^\/(create-community|add-community\/create-community)$/, 'Create a community'],
  [/^\/trainings$/, 'Events'],
  [/^\/trainings\/new$/, 'New event'],
  [/^\/trainings\/[^/]+\/edit$/, 'Edit event'],
  [/^\/trainings\/[^/]+\/attendance$/, 'Attendance'],
  [/^\/trainings\/[^/]+$/, 'Event'],
  [/^\/communications$/, 'Communications'],
  [/^\/(activity|notifications)$/, 'Notifications'],
  [/^\/announcements$/, 'Announcements'],
  [/^\/announcements\/new$/, 'New announcement'],
  [/^\/announcements\/[^/]+\/edit$/, 'Edit announcement'],
  [/^\/announcements\/[^/]+$/, 'Announcement'],
  [/^\/statistics$/, 'Statistics'],
  [/^\/statistics\/[^/]+$/, 'Member statistics'],
  [/^\/profile$/, 'Profile'],
  [/^\/community$/, 'Community'],
  [/^\/invitations$/, 'Invitations'],
  [/^\/community-settings$/, 'Community settings'],
  [/^\/members$/, 'Members'],
  [/^\/attendance-history$/, 'Attendance history'],
  [/^\/privacy$/, 'Privacy'],
  [/^\/secure-account$/, 'Secure your account'],
  [/^\/my-workouts$/, 'My workouts'],
  [/^\/personal-bests$/, 'Personal bests'],
  [/^\/consent$/, 'Before you start'],
  [/^\/legal\/privacy$/, 'Privacy Notice'],
  [/^\/legal\/terms$/, 'Terms of Use'],
];

/** "Events · TrainHive". Unknown paths get the plain app name. */
export function titleForPath(pathname: string): string {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  for (const [pattern, title] of TITLES) {
    if (pattern.test(path)) return `${title} · ${APP_TITLE}`;
  }
  return APP_TITLE;
}
