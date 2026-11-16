import { authStorage } from '@/lib/authStorage';

import { activeCommunityStorageKey, parseStoredCommunityId } from '../domain/activeCommunity';

/** The community this user last selected on this device, or null. Stored next to the session (never AsyncStorage). */
export async function readActiveCommunityId(userId: string): Promise<string | null> {
  return parseStoredCommunityId(await authStorage.getItem(activeCommunityStorageKey(userId)));
}

export async function writeActiveCommunityId(userId: string, communityId: string): Promise<void> {
  await authStorage.setItem(activeCommunityStorageKey(userId), communityId);
}
