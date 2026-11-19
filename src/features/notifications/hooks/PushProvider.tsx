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
import { useQueryClient } from '@tanstack/react-query';
import { AppState } from 'react-native';

import { useSession } from '@/features/community/hooks/SessionProvider';
import { recordConsent } from '@/features/legal/api/consents';
import { consentKeys } from '@/features/legal/api/keys';
import { applyConsentEvent, isConsentCurrent } from '@/features/legal/domain/consentCache';
import { useMyConsents } from '@/features/legal/hooks/useConsents';
import { authStorage } from '@/lib/authStorage';
import type { MyConsents } from '@/lib/database.types';
import { toAppError, userMessage } from '@/lib/errors';
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
  PUSH_PROMPT_DISMISSED_KEY,
  derivePushState,
  isPushNativeAvailable,
  shouldOfferPrompt,
  type PushRegistration,
  type PushStateKind,
} from '../domain/pushState';

export type PushContextValue = {
  kind: PushStateKind;
  /** The in-context "Get notified" card should be shown. */
  showPrompt: boolean;
  /**
   * An explicit tap on "Enable notifications": records the push consent first, then asks the system
   * for permission (or opens settings when the system will not ask again).
   */
  enable: () => Promise<void>;
  /** Only the system permission step (the consent was just recorded, for example by the Privacy switch). */
  requestPermission: () => Promise<void>;
  /** Why "Enable" failed (friendly text), or null. */
  enableError: string | null;
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
  onConsentRequired: () => void,
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
    // The server says the consent is not current: read the consent again (the state then shows the
    // consent prompt). Nothing here retries by itself, so this cannot loop.
    if (toAppError(error).code === 'consent_required') onConsentRequired();
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
 * (`enable`), never at launch, and nothing is registered unless the member's
 * `push_notifications` consent is current on the server (withdrawing it in
 * Privacy settings stops registration and the server deletes the tokens).
 *
 * Mounted inside `(app)`, so the profile exists (`register_push_token` needs
 * it). Nothing here touches the native module on web or in Expo Go on
 * Android, where remote push cannot work.
 */
export function PushProvider({ children }: { children: ReactNode }) {
  const env = readPushEnvironment();
  const nativeAvailable = isPushNativeAvailable(env);
  const queryClient = useQueryClient();
  const { userId } = useSession();
  const { consents } = useMyConsents();
  const consent = isConsentCurrent(consents ?? undefined, 'push_notifications');
  const consentGranted = consent === true;

  const [permission, setPermission] = useState<PermissionInfo | null>(null);
  const [registration, setRegistration] = useState<PushRegistration>('idle');
  // null until the stored choice is read: treated as dismissed so the card never flashes.
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [enableError, setEnableError] = useState<string | null>(null);
  const queue = useRef<RegistrationQueue | null>(null);
  const refreshConsents = () => {
    void queryClient.invalidateQueries({ queryKey: consentKeys.all });
  };
  // The query client is stable for the life of the app, so capturing it in the queue is safe.
  queue.current ??= new RegistrationQueue(() =>
    registerDevice(setRegistration, () => {
      void queryClient.invalidateQueries({ queryKey: consentKeys.all });
    }),
  );
  const register = (key: string) => {
    void queue.current?.submit(key);
  };

  const kind = derivePushState({
    env,
    consent,
    permission: permission?.permission ?? null,
    canAskAgain: permission?.canAskAgain ?? true,
    registration,
  });

  useEffect(() => {
    let active = true;
    authStorage
      .getItem(PUSH_PROMPT_DISMISSED_KEY)
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

  // Register whenever permission AND consent are granted: on start, on return to the foreground, on
  // token change. Withdrawing the consent tears this down, so no further registration happens.
  useEffect(() => {
    if (!nativeAvailable || !granted || !consentGranted) return;
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
  }, [nativeAvailable, granted, consentGranted]);

  const requestPermissionStep = async () => {
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

  const enable = async () => {
    if (!nativeAvailable) return;
    setEnableError(null);
    if (consent !== true) {
      try {
        const event = await recordConsent('push_notifications');
        queryClient.setQueryData<MyConsents>(consentKeys.mine(userId), (current) =>
          current ? applyConsentEvent(current, event) : current,
        );
        refreshConsents();
      } catch (error) {
        reportError('push.recordConsent', error);
        const failure = toAppError(error);
        setEnableError(userMessage(failure.code, failure.field));
        return;
      }
    }
    await requestPermissionStep();
  };

  const dismissPrompt = () => {
    setDismissed(true);
    authStorage.setItem(PUSH_PROMPT_DISMISSED_KEY, '1').catch((error: unknown) => {
      reportError('push.saveDismissed', error);
    });
  };

  const value: PushContextValue = {
    kind,
    showPrompt: shouldOfferPrompt(kind, dismissed !== false),
    enable,
    requestPermission: requestPermissionStep,
    enableError,
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
