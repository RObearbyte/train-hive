/**
 * The only file that talks to the device's notification stack
 * (`expo-notifications`, `expo-device`). Everything here is native-only: on
 * web and in Expo Go on Android the callers never reach it (see
 * `derivePushState`), so no native call is attempted where it cannot work.
 *
 * Docs: https://docs.expo.dev/versions/v58.0.0/sdk/notifications/
 */
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, IosAuthorizationStatus } from 'expo-notifications';
import { isRunningInExpoGo } from 'expo';
import { Linking, Platform } from 'react-native';

import type { PushPlatform } from '@/lib/database.types';

import type { PushEnvironment, PushPermission } from '../domain/pushState';

/** The Android channel the dispatcher targets (also the plugin's `defaultChannel`). */
export const ANDROID_CHANNEL_ID = 'default';

export type PermissionInfo = { permission: PushPermission; canAskAgain: boolean };

/** Reads the build's environment. */
export function readPushEnvironment(): PushEnvironment {
  return {
    platform: Platform.OS,
    isExpoGo: isRunningInExpoGo(),
    hasProjectId: readProjectId() !== null,
  };
}

/**
 * The EAS project id, from `extra.eas.projectId` or EAS's own config. Never
 * invented: without one the app shows "Push is not configured" and makes no
 * token request.
 */
export function readProjectId(): string | null {
  const fromExtra: unknown = Constants.expoConfig?.extra?.eas?.projectId;
  const fromEas: unknown = Constants.easConfig?.projectId;
  for (const candidate of [fromExtra, fromEas]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return null;
}

/** "Pixel 8" and the like, for the `device_label` column (at most 80 characters). */
export function deviceLabel(): string | null {
  const name = Device.modelName ?? Device.deviceName;
  if (!name) return null;
  const trimmed = name.trim();
  return trimmed === '' ? null : Array.from(trimmed).slice(0, 80).join('');
}

export function pushPlatform(): PushPlatform {
  return Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
}

function toPermissionInfo(settings: Notifications.NotificationPermissionsStatus): PermissionInfo {
  if (settings.granted || settings.ios?.status === IosAuthorizationStatus.PROVISIONAL) {
    return { permission: 'granted', canAskAgain: true };
  }
  const undetermined =
    settings.ios?.status === IosAuthorizationStatus.NOT_DETERMINED ||
    (settings.ios === undefined && settings.status === Notifications.PermissionStatus.UNDETERMINED);
  if (undetermined) return { permission: 'undetermined', canAskAgain: settings.canAskAgain };
  return { permission: 'denied', canAskAgain: settings.canAskAgain };
}

export async function readPermission(): Promise<PermissionInfo> {
  return toPermissionInfo(await Notifications.getPermissionsAsync());
}

/** Shows the system permission dialog (when the system still allows it). */
export async function requestPermission(): Promise<PermissionInfo> {
  // Android 13+ shows no dialog until a channel exists.
  await ensureAndroidChannel();
  return toPermissionInfo(
    await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    }),
  );
}

export async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
    name: 'TrainHive',
    importance: AndroidImportance.HIGH,
  });
}

/** Foreground pushes show as a banner too (on Android a silent one would not be shown at all). */
export function installForegroundHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/** This installation's Expo push token. Rejects when offline or the project id is wrong. */
export async function fetchExpoPushToken(projectId: string): Promise<string> {
  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  return token.data;
}

export function onPushTokenChanged(listener: () => void): () => void {
  const subscription = Notifications.addPushTokenListener(() => listener());
  return () => subscription.remove();
}

/** A notification arrived while the app is open. */
export function onNotificationReceived(listener: () => void): () => void {
  const subscription = Notifications.addNotificationReceivedListener(() => listener());
  return () => subscription.remove();
}

export type NotificationTap = {
  /** The notification's `data` payload (untrusted). */
  data: unknown;
  /** The OS identifier of this notification, used to ignore repeats. */
  identifier: string;
};

function toTap(response: Notifications.NotificationResponse): NotificationTap | null {
  if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return null;
  return {
    data: response.notification.request.content.data,
    identifier: response.notification.request.identifier,
  };
}

/** Taps while the app is running or backgrounded. */
export function onNotificationTap(listener: (tap: NotificationTap) => void): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const tap = toTap(response);
    if (tap) listener(tap);
  });
  return () => subscription.remove();
}

/** The tap that launched the app from a killed state, if any. */
export async function readLaunchTap(): Promise<NotificationTap | null> {
  const response = await Notifications.getLastNotificationResponseAsync();
  return response ? toTap(response) : null;
}

export async function clearLaunchTap(): Promise<void> {
  await Notifications.clearLastNotificationResponseAsync();
}

export function openSystemSettings(): Promise<void> {
  return Linking.openSettings();
}
