import { fetchExpoPushToken, readProjectId, readPushEnvironment } from './pushNative';
import { unregisterPushToken } from './pushTokens';
import { isPushNativeAvailable } from '../domain/pushState';

/**
 * Stops pushes for this installation before signing out: removes its push token
 * from the account on the server (the account cannot be recovered afterwards, so
 * a leftover token would keep delivering its notifications to this device).
 * Does nothing where push cannot work (web, Expo Go on Android, no project id).
 * Throws on failure; the caller treats it as best effort.
 */
export async function unregisterThisDevice(): Promise<void> {
  if (!isPushNativeAvailable(readPushEnvironment())) return;
  const projectId = readProjectId();
  if (projectId === null) return;
  await unregisterPushToken(await fetchExpoPushToken(projectId));
}
