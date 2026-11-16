import { describe, expect, it } from 'vitest';

import {
  derivePushState,
  pushStateView,
  shouldOfferPrompt,
  type PushEnvironment,
  type PushPermission,
  type PushRegistration,
  type PushStateKind,
} from './pushState';

const ANDROID: PushEnvironment = { platform: 'android', isExpoGo: false, hasProjectId: true };

function state(
  env: Partial<PushEnvironment>,
  permission: PushPermission | null,
  options: { canAskAgain?: boolean; registration?: PushRegistration } = {},
): PushStateKind {
  return derivePushState({
    env: { ...ANDROID, ...env },
    permission,
    canAskAgain: options.canAskAgain ?? true,
    registration: options.registration ?? 'idle',
  });
}

describe('derivePushState', () => {
  it('web and desktop never register', () => {
    expect(state({ platform: 'web' }, 'granted')).toBe('unsupported_platform');
    expect(state({ platform: 'windows' }, null)).toBe('unsupported_platform');
  });

  it('Expo Go on Android needs a development build, whatever the permission', () => {
    for (const permission of ['granted', 'denied', 'undetermined', null] as const) {
      expect(state({ isExpoGo: true }, permission)).toBe('unsupported_expo_go');
    }
  });

  it('Expo Go on iOS is not blocked', () => {
    expect(state({ platform: 'ios', isExpoGo: true }, 'undetermined')).toBe('can_enable');
  });

  it('without a project id it is "not configured" before anything else about permission', () => {
    expect(state({ hasProjectId: false }, 'granted')).toBe('not_configured');
    expect(state({ hasProjectId: false }, null)).toBe('not_configured');
  });

  it('walks permission and registration', () => {
    expect(state({}, null)).toBe('checking');
    expect(state({}, 'undetermined')).toBe('can_enable');
    expect(state({}, 'denied', { canAskAgain: true })).toBe('denied_can_ask');
    expect(state({}, 'denied', { canAskAgain: false })).toBe('denied_blocked');
    expect(state({}, 'granted', { registration: 'idle' })).toBe('registering');
    expect(state({}, 'granted', { registration: 'registering' })).toBe('registering');
    expect(state({}, 'granted', { registration: 'registered' })).toBe('registered');
    expect(state({}, 'granted', { registration: 'failed' })).toBe('registration_failed');
  });
});

describe('shouldOfferPrompt', () => {
  it('only offers while undecided and not dismissed', () => {
    expect(shouldOfferPrompt('can_enable', false)).toBe(true);
    expect(shouldOfferPrompt('can_enable', true)).toBe(false);
    for (const kind of ['denied_can_ask', 'denied_blocked', 'registered', 'unsupported_expo_go'] as const) {
      expect(shouldOfferPrompt(kind, false)).toBe(false);
    }
  });
});

describe('pushStateView', () => {
  it('gives every state an action that matches what can be done', () => {
    expect(pushStateView('unsupported_platform').title).toBe('Push notifications are available in the mobile app');
    expect(pushStateView('unsupported_platform').description).toMatch(/still appear here/);
    expect(pushStateView('unsupported_platform').action).toBeNull();
    expect(pushStateView('can_enable').action).toBe('enable');
    expect(pushStateView('denied_blocked').action).toBe('open_settings');
    expect(pushStateView('registration_failed').action).toBe('retry');
    expect(pushStateView('unsupported_expo_go').title).toBe('Push needs a development build');
    expect(pushStateView('unsupported_expo_go').action).toBeNull();
    expect(pushStateView('not_configured').title).toMatch(/not configured/i);
  });
});
