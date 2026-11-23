import { authStorage } from '@/lib/authStorage';

import { ABOUT_YOU_SEEN_VALUE, aboutYouPromptStorageKey, parseSeen } from '../domain/prompt';

/** Whether this person already saw or skipped the first-time About-you page on this device. */
export async function readAboutYouSeen(userId: string): Promise<boolean> {
  return parseSeen(await authStorage.getItem(aboutYouPromptStorageKey(userId)));
}

export async function writeAboutYouSeen(userId: string): Promise<void> {
  await authStorage.setItem(aboutYouPromptStorageKey(userId), ABOUT_YOU_SEEN_VALUE);
}
