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
  [/^\/trainings$/, 'Trainings'],
  [/^\/trainings\/new$/, 'New training'],
  [/^\/trainings\/[^/]+\/edit$/, 'Edit training'],
  [/^\/trainings\/[^/]+\/attendance$/, 'Attendance'],
  [/^\/trainings\/[^/]+$/, 'Training'],
  [/^\/activity$/, 'Activity'],
  [/^\/announcements\/new$/, 'New announcement'],
  [/^\/announcements\/[^/]+\/edit$/, 'Edit announcement'],
  [/^\/announcements\/[^/]+$/, 'Announcement'],
  [/^\/statistics$/, 'Statistics'],
  [/^\/statistics\/[^/]+$/, 'Member statistics'],
  [/^\/profile$/, 'Profile'],
  [/^\/invitations$/, 'Invitations'],
  [/^\/community-settings$/, 'Community settings'],
  [/^\/attendance-history$/, 'Attendance history'],
];

/** "Trainings · TrainHive". Unknown paths get the plain app name. */
export function titleForPath(pathname: string): string {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  for (const [pattern, title] of TITLES) {
    if (pattern.test(path)) return `${title} · ${APP_TITLE}`;
  }
  return APP_TITLE;
}
