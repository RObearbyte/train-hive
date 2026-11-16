/**
 * A user who is removed from the community they are looking at is moved to
 * another one automatically. This says so, once, instead of switching
 * silently. Pure: compares what the app knew before with what it knows now.
 */
import type { MyCommunity } from '@/lib/database.types';

export interface CommunitySnapshot {
  activeId: string | null;
  communities: readonly Pick<MyCommunity, 'community_id' | 'name'>[];
}

/**
 * The notice to show, or null. Only when the previously active community has
 * disappeared from my list and another one is now active; a switch the user
 * made themselves (the old one still in the list), leaving every community, or
 * a list that is not loaded never produces one.
 */
export function removalNotice(previous: CommunitySnapshot, next: CommunitySnapshot): string | null {
  if (previous.activeId === null || next.activeId === null || next.activeId === previous.activeId) return null;
  const was = previous.communities.find((item) => item.community_id === previous.activeId);
  if (!was) return null;
  if (next.communities.some((item) => item.community_id === was.community_id)) return null;
  const now = next.communities.find((item) => item.community_id === next.activeId);
  if (!now) return null;
  return `You're no longer a member of ${was.name}; switched to ${now.name}.`;
}
