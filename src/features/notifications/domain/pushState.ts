/**
 * What the push settings and prompt cards show, as a pure function of the
 * environment, the system permission and the registration progress.
 *
 * In-app notifications never depend on any of this: they are stored by the
 * server whatever the push state is.
 */

export type PushPermission = 'granted' | 'denied' | 'undetermined';
export type PushRegistration = 'idle' | 'registering' | 'registered' | 'failed';

export type PushEnvironment = {
  platform: 'ios' | 'android' | 'web' | 'windows' | 'macos';
  /** Running inside Expo Go (`isRunningInExpoGo()` from `expo`). */
  isExpoGo: boolean;
  /** An EAS project id is configured (`extra.eas.projectId` / `easConfig`). */
  hasProjectId: boolean;
};

export type PushStateInput = {
  env: PushEnvironment;
  /**
   * The member's `push_notifications` consent as the server reports it: true = current,
   * false = never given or withdrawn, null = not known yet. Nothing is registered without it.
   */
  consent: boolean | null;
  /** null until the system permission has been read. */
  permission: PushPermission | null;
  /** The system will still show its permission dialog. */
  canAskAgain: boolean;
  registration: PushRegistration;
};

export type PushStateKind =
  | 'unsupported_platform'
  | 'unsupported_expo_go'
  | 'not_configured'
  | 'checking'
  | 'consent_needed'
  | 'can_enable'
  | 'denied_can_ask'
  | 'denied_blocked'
  | 'registering'
  | 'registered'
  | 'registration_failed';

export function derivePushState(input: PushStateInput): PushStateKind {
  const { env } = input;
  if (env.platform !== 'ios' && env.platform !== 'android') return 'unsupported_platform';
  // Remote push was removed from Expo Go on Android (SDK 53+); iOS Expo Go still has it.
  if (env.platform === 'android' && env.isExpoGo) return 'unsupported_expo_go';
  if (!env.hasProjectId) return 'not_configured';
  if (input.permission === null || input.consent === null) return 'checking';
  // No consent (never given, or withdrawn): nothing is registered. The system permission is irrelevant until they agree.
  if (!input.consent) return input.permission === 'undetermined' ? 'can_enable' : 'consent_needed';
  if (input.permission === 'undetermined') return 'can_enable';
  if (input.permission === 'denied') {
    return input.canAskAgain ? 'denied_can_ask' : 'denied_blocked';
  }
  switch (input.registration) {
    case 'registered':
      return 'registered';
    case 'failed':
      return 'registration_failed';
    default:
      return 'registering';
  }
}

/**
 * The native notification stack may be used at all: a phone or tablet build (not web, not Expo Go on
 * Android) with a push project.
 */
export function isPushNativeAvailable(env: PushEnvironment): boolean {
  return (
    (env.platform === 'ios' || env.platform === 'android') &&
    !(env.platform === 'android' && env.isExpoGo) &&
    env.hasProjectId
  );
}

/** Stored next to the session: the member chose "Not now" on the in-context card. */
export const PUSH_PROMPT_DISMISSED_KEY = 'trainhive-push-prompt-dismissed';

/** The in-context "Get notified" card is shown: not yet decided, not dismissed. */
export function shouldOfferPrompt(kind: PushStateKind, dismissed: boolean): boolean {
  return kind === 'can_enable' && !dismissed;
}

export type PushAction = 'enable' | 'open_settings' | 'retry';

export type PushStateView = {
  title: string;
  description: string;
  tone: 'info' | 'success' | 'warning' | 'error';
  action: PushAction | null;
  actionLabel: string | null;
};

const VIEWS: Record<PushStateKind, PushStateView> = {
  unsupported_platform: {
    title: 'Push notifications are available in the mobile app',
    description:
      'Announcements and notifications still appear here, in the Activity tab.',
    tone: 'info',
    action: null,
    actionLabel: null,
  },
  unsupported_expo_go: {
    title: 'Push needs a development build',
    description:
      'Android push notifications do not work inside Expo Go. Install a development build of TrainHive to receive them. Your notifications are still saved in the Activity tab.',
    tone: 'info',
    action: null,
    actionLabel: null,
  },
  not_configured: {
    title: 'Push is not configured yet',
    description:
      'This build has no push project set up, so the app cannot register this device. Your notifications are still saved in the Activity tab.',
    tone: 'warning',
    action: null,
    actionLabel: null,
  },
  checking: {
    title: 'Checking notification permission',
    description: 'One moment.',
    tone: 'info',
    action: null,
    actionLabel: null,
  },
  consent_needed: {
    title: 'Push notifications are off',
    description:
      'You have not allowed TrainHive to send push notifications. Turn them on to get reminders on this device. Everything still appears in the Activity tab.',
    tone: 'info',
    action: 'enable',
    actionLabel: 'Turn on notifications',
  },
  can_enable: {
    title: 'Push notifications are off',
    description: 'Get notified when trainings are confirmed or cancelled, and for announcements.',
    tone: 'info',
    action: 'enable',
    actionLabel: 'Enable notifications',
  },
  denied_can_ask: {
    title: 'Push notifications are off',
    description:
      'Notifications are not allowed for TrainHive on this device. You can still read everything in the Activity tab.',
    tone: 'warning',
    action: 'enable',
    actionLabel: 'Enable notifications',
  },
  denied_blocked: {
    title: 'Notifications are blocked in system settings',
    description:
      'To get push notifications, allow notifications for TrainHive in your device settings. You can still read everything in the Activity tab.',
    tone: 'warning',
    action: 'open_settings',
    actionLabel: 'Open system settings',
  },
  registering: {
    title: 'Setting up this device',
    description: 'Connecting this device so it can receive notifications.',
    tone: 'info',
    action: null,
    actionLabel: null,
  },
  registered: {
    title: 'This device receives push notifications',
    description: 'Choose below which kinds you want.',
    tone: 'success',
    action: null,
    actionLabel: null,
  },
  registration_failed: {
    title: 'Could not set up push notifications',
    description:
      'This device could not be registered. Check your connection and try again. Your notifications are still saved in the Activity tab.',
    tone: 'error',
    action: 'retry',
    actionLabel: 'Try again',
  },
};

export function pushStateView(kind: PushStateKind): PushStateView {
  return VIEWS[kind];
}
