/** What a Realtime change on the notification tables can make stale. */
export type ActivityTopic = 'announcements' | 'notifications';

/** Which topics a change to a table invalidates; unknown tables invalidate nothing. */
export function activityTopicsForTable(table: string): ActivityTopic[] {
  switch (table) {
    case 'announcements':
      return ['announcements'];
    case 'notifications':
      return ['notifications'];
    default:
      return [];
  }
}
