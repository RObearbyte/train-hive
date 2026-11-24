import type { EventFeedUnread } from '@/lib/database.types';

/** The discussion chip on event cards. Display only; the server counts posts and unread. */
export type DiscussionChip = {
  /** Unread messages get the accent style. */
  unread: boolean;
  /** "3 new", "99+ new" or the post count "5". */
  text: string;
  /** Spoken label: "Discussion, 3 new messages". */
  label: string;
};

const CAP = 99;

function capped(count: number): string {
  return count > CAP ? `${CAP}+` : String(count);
}

function whole(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * What to show on an event card. `null` (no chip) when the row is missing
 * (no posts, or the unread query failed / is not loaded) or has no posts.
 */
export function discussionChip(
  row: Pick<EventFeedUnread, 'post_count' | 'unread_count'> | null,
): DiscussionChip | null {
  if (row === null) return null;
  const posts = whole(row.post_count);
  const unread = whole(row.unread_count);
  if (posts <= 0 && unread <= 0) return null;
  if (unread > 0) {
    return {
      unread: true,
      text: `${capped(unread)} new`,
      label: `Discussion, ${unread} new ${unread === 1 ? 'message' : 'messages'}`,
    };
  }
  return {
    unread: false,
    text: capped(posts),
    label: `Discussion, ${posts} ${posts === 1 ? 'message' : 'messages'}`,
  };
}
