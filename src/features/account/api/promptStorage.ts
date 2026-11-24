import { authStorage } from '@/lib/authStorage';

import { SECURE_SEEN_VALUE, parseSecureSeen, securePromptStorageKey } from '../domain/securePrompt';

/** Whether this person already saw or skipped the first-time "Secure your account" page on this device. */
export async function readSecureSeen(userId: string): Promise<boolean> {
  return parseSecureSeen(await authStorage.getItem(securePromptStorageKey(userId)));
}

export async function writeSecureSeen(userId: string): Promise<void> {
  await authStorage.setItem(securePromptStorageKey(userId), SECURE_SEEN_VALUE);
}
