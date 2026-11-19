import { authStorage } from '@/lib/authStorage';

import {
  ACCEPTANCE_STORAGE_KEY,
  parseLocalAcceptance,
  serializeLocalAcceptance,
  type LocalAcceptance,
} from '../domain/acceptance';

/** The acknowledgement stored on this device, or null (also for malformed data). Stored next to the session. */
export async function readLocalAcceptance(): Promise<LocalAcceptance | null> {
  return parseLocalAcceptance(await authStorage.getItem(ACCEPTANCE_STORAGE_KEY));
}

export async function writeLocalAcceptance(acceptance: LocalAcceptance): Promise<void> {
  await authStorage.setItem(ACCEPTANCE_STORAGE_KEY, serializeLocalAcceptance(acceptance));
}

export async function clearLocalAcceptance(): Promise<void> {
  await authStorage.removeItem(ACCEPTANCE_STORAGE_KEY);
}
