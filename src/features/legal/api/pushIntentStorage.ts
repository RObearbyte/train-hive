import { authStorage } from '@/lib/authStorage';

/**
 * "I want push notifications", ticked on the first-launch screen before any account exists.
 * It is only a note on this device: nothing is recorded on the server (and the system
 * permission is not asked) until the signed-in app starts and acts on it once.
 */
export const PUSH_INTENT_STORAGE_KEY = 'trainhive-push-intent';

export async function readPushIntent(): Promise<boolean> {
  return (await authStorage.getItem(PUSH_INTENT_STORAGE_KEY)) === '1';
}

export async function writePushIntent(): Promise<void> {
  await authStorage.setItem(PUSH_INTENT_STORAGE_KEY, '1');
}

export async function clearPushIntent(): Promise<void> {
  await authStorage.removeItem(PUSH_INTENT_STORAGE_KEY);
}
