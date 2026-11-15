import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { AppState } from 'react-native';

import { authStorage } from '@/lib/authStorage';
import { reportError } from '@/lib/logger';

import { registerPushToken } from '../api/pushTokens';
import {
  deviceLabel,
  ensureAndroidChannel,
  fetchExpoPushToken,
  installForegroundHandler,
  onPushTokenChanged,
  openSystemSettings,
  pushPlatform,
  readPermission,
  readProjectId,
  readPushEnvironment,
  requestPermission,
  type PermissionInfo,
} from '../api/pushNative';
import { RegistrationQueue } from '../domain/registrationQueue';
import {
  derivePushState,
  shouldOfferPrompt,
  type PushRegistration,
  type PushStateKind,
} from '../domain/pushState';

const DISMISSED_KEY = 'trainhive-push-prompt-dismissed';

export type PushContextValue = {
  kind: PushStateKind;
  /** The in-context "Get notified" card should be shown. */
  showPrompt: boolean;
  /** Ask the system for permission (or open settings when the system will not ask again). */
  enable: () => Promise<void>;
  /** "Not now": hides the card for good (settings keeps offering it). */
  dismissPrompt: () => void;
  /** Try registering this device again after a failure. */
  retry: () => void;
  openSettings: () => void;
};

const PushContext = createContext<PushContextValue | null>(null);

/**
 * One registration run: fetches this installation's Expo token and registers
 * it. Never throws; resolves to whether it succeeded. Runs are serialised by
 * a `RegistrationQueue`, which keeps the latest request that arrived
 * meanwhile (a token change must not be dropped).
 */
async function registerDevice(
  setRegistration: Dispatch<SetStateAction<PushRegistration>>,
): Promise<boolean> {
  const projectId = readProjectId();
  if (projectId === null) return true;
  try {
    await ensureAndroidChannel();
    const token = await fetchExpoPushToken(projectId);
    await registerPushToken(token, pushPlatform(), deviceLabel());
    setRegistration('registered');
    return true;
  } catch (error) {
    reportError('push.register', error);
    setRegistration('failed');
    return false;
  }
}

async function loadPermission(
  setPermission: Dispatch<SetStateAction<PermissionInfo | null>>,
): Promise<void> {
  try {
    setPermission(await readPermission());
  } catch (error) {
    reportError('push.readPermission', error);
  }
}

/**
 * Owns the device's push state for the signed-in area: reads the permission,
 * registers the Expo push token with the server (on start, on return to the
 * foreground and whenever the token changes), and installs the foreground
 * banner handler. Permission is only ever requested from a user action
 * (`enable`), never at launch.
 *
 * Mounted inside `(app)`, so the profile exists (`register_push_token` needs
 * it). Nothing here touches the native module on web or in Expo Go on
 * Android, where remote push cannot work.
 */
export function PushProvider({ children }: { children: ReactNode }) {
  const env = readPushEnvironment();
  const nativeAvailable =
    (env.platform === 'ios' || env.platform === 'android') &&
    !(env.platform === 'android' && env.isExpoGo) &&
    env.hasProjectId;

  const [permission, setPermission] = useState<PermissionInfo | null>(null);
  const [registration, setRegistration] = useState<PushRegistration>('idle');
  // null until the stored choice is read: treated as dismissed so the card never flashes.
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const queue = useRef<RegistrationQueue | null>(null);
  queue.current ??= new RegistrationQueue(() => registerDevice(setRegistration));
  const register = (key: string) => {
    void queue.current?.submit(key);
  };

  const kind = derivePushState({
    env,
    permission: permission?.permission ?? null,
    canAskAgain: permission?.canAskAgain ?? true,
    registration,
  });

  useEffect(() => {
    let active = true;
    authStorage
      .getItem(DISMISSED_KEY)
      .then((value) => {
        if (active) setDismissed(value === '1');
      })
      .catch((error: unknown) => {
        reportError('push.readDismissed', error);
        if (active) setDismissed(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // Handler, channel and the current permission.
  useEffect(() => {
    if (!nativeAvailable) return;
    installForegroundHandler();
    void loadPermission(setPermission);
    const appState = AppState.addEventListener('change', (state) => {
      // The user may have changed the permission in system settings meanwhile.
      if (state === 'active') void loadPermission(setPermission);
    });
    return () => appState.remove();
  }, [nativeAvailable]);

  const granted = permission?.permission === 'granted';

  // Register whenever permission is granted: on start, on return to the foreground, on token change.
  useEffect(() => {
    if (!nativeAvailable || !granted) return;
    const submit = (key: string) => {
      void queue.current?.submit(key);
    };
    submit('start');
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') submit('foreground');
    });
    const stopTokenListener = onPushTokenChanged((deviceToken) => {
      submit(`token:${deviceToken}`);
    });
    return () => {
      appState.remove();
      stopTokenListener();
    };
  }, [nativeAvailable, granted]);

  const enable = async () => {
    if (!nativeAvailable) return;
    try {
      const current = await readPermission();
      if (current.permission === 'denied' && !current.canAskAgain) {
        await openSystemSettings();
        return;
      }
      setPermission(await requestPermission());
    } catch (error) {
      reportError('push.enable', error);
    }
  };

  const dismissPrompt = () => {
    setDismissed(true);
    authStorage.setItem(DISMISSED_KEY, '1').catch((error: unknown) => {
      reportError('push.saveDismissed', error);
    });
  };

  const value: PushContextValue = {
    kind,
    showPrompt: shouldOfferPrompt(kind, dismissed !== false),
    enable,
    dismissPrompt,
    retry: () => register('retry'),
    openSettings: () => {
      openSystemSettings().catch((error: unknown) => reportError('push.openSettings', error));
    },
  };

  return <PushContext value={value}>{children}</PushContext>;
}

export function usePush(): PushContextValue {
  const context = use(PushContext);
  if (!context) throw new Error('usePush must be used inside PushProvider.');
  return context;
}
