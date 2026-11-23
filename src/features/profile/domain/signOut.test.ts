import { describe, expect, it } from 'vitest';

import { aboutYouPromptStorageKey } from '@/features/aboutYou/domain/prompt';
import { activeCommunityStorageKey } from '@/features/community/domain/activeCommunity';
import { ACCEPTANCE_STORAGE_KEY } from '@/features/legal/domain/acceptance';
import { PUSH_PROMPT_DISMISSED_KEY } from '@/features/notifications/domain/pushState';

import { SIGN_OUT_MESSAGE, runSignOut, storedKeysToClear, type SignOutEffects } from './signOut';

const USER = '0b8e7c1e-1111-4222-8333-444455556666';
const INPUT = { userId: USER, authStorageKey: 'trainhive-auth' };

function recorder(overrides: Partial<SignOutEffects> = {}) {
  const calls: string[] = [];
  const reported: string[] = [];
  const effects: SignOutEffects = {
    unregisterDevice: async () => {
      calls.push('unregisterDevice');
    },
    signOut: async () => {
      calls.push('signOut');
    },
    removeStored: async (key) => {
      calls.push(`remove:${key}`);
    },
    removeExportedFiles: async () => {
      calls.push('removeExportedFiles');
    },
    clearQueryCache: () => {
      calls.push('clearQueryCache');
    },
    resetInMemoryState: () => {
      calls.push('resetInMemoryState');
    },
    report: (context) => {
      reported.push(context);
    },
    ...overrides,
  };
  return { effects, calls, reported };
}

describe('sign-out confirmation text', () => {
  it('says what the person loses, in the words the product requires', () => {
    expect(SIGN_OUT_MESSAGE).toBe(
      'You will lose access to this account on this device. TrainHive accounts are anonymous: without a login there is no way to get it back.',
    );
  });
});

describe('storedKeysToClear', () => {
  it('covers the session, the first-launch acknowledgement, the push prompt choice, the active community and the About-you note', () => {
    expect(storedKeysToClear(INPUT)).toEqual([
      'trainhive-auth',
      ACCEPTANCE_STORAGE_KEY,
      PUSH_PROMPT_DISMISSED_KEY,
      activeCommunityStorageKey(USER),
      aboutYouPromptStorageKey(USER),
    ]);
  });

  it('skips the per-user key when there is no user', () => {
    expect(storedKeysToClear({ userId: null, authStorageKey: 'k' })).toHaveLength(3);
  });
});

describe('runSignOut', () => {
  it('unregisters the device, signs out, then clears storage, cache and memory, in that order', async () => {
    const { effects, calls } = recorder();
    const result = await runSignOut(effects, INPUT);
    expect(result).toEqual({ ok: true, warnings: 0 });
    expect(calls).toEqual([
      'unregisterDevice',
      'signOut',
      'remove:trainhive-auth',
      `remove:${ACCEPTANCE_STORAGE_KEY}`,
      `remove:${PUSH_PROMPT_DISMISSED_KEY}`,
      `remove:${activeCommunityStorageKey(USER)}`,
      `remove:${aboutYouPromptStorageKey(USER)}`,
      'removeExportedFiles',
      'clearQueryCache',
      'resetInMemoryState',
    ]);
  });

  it('a failing sign-out clears NOTHING: the person is still signed in and can retry', async () => {
    const failure = new Error('network request failed');
    const { effects, calls } = recorder({
      signOut: async () => {
        calls.push('signOut');
        throw failure;
      },
    });
    const result = await runSignOut(effects, INPUT);
    expect(result).toEqual({ ok: false, error: failure });
    expect(calls).toEqual(['unregisterDevice', 'signOut']);
  });

  it('a failing push unregistration is reported but never blocks the sign-out', async () => {
    const { effects, calls, reported } = recorder({
      unregisterDevice: async () => {
        throw new Error('offline');
      },
    });
    const result = await runSignOut(effects, INPUT);
    expect(result.ok).toBe(true);
    expect(reported).toEqual(['signOut.unregisterDevice']);
    expect(calls).toContain('signOut');
    expect(calls).toContain('clearQueryCache');
  });

  it('a cleanup failure is counted and reported and the remaining steps still run', async () => {
    const { effects, calls, reported } = recorder({
      removeStored: async (key) => {
        if (key === 'trainhive-auth') throw new Error('storage unavailable');
        calls.push(`remove:${key}`);
      },
    });
    const result = await runSignOut(effects, INPUT);
    expect(result).toEqual({ ok: true, warnings: 1 });
    expect(reported).toEqual(['signOut.removeStored']);
    expect(calls).toContain(`remove:${ACCEPTANCE_STORAGE_KEY}`);
    expect(calls.slice(-2)).toEqual(['clearQueryCache', 'resetInMemoryState']);
  });

  it('a failing export-file removal is counted and reported, and never blocks the rest or the sign-out', async () => {
    const { effects, calls, reported } = recorder({
      removeExportedFiles: async () => {
        throw new Error('cache not readable');
      },
    });
    const result = await runSignOut(effects, INPUT);
    expect(result).toEqual({ ok: true, warnings: 1 });
    expect(reported).toEqual(['signOut.removeExportedFiles']);
    expect(calls.slice(-2)).toEqual(['clearQueryCache', 'resetInMemoryState']);
  });

  it('a failing sign-out leaves the exported file alone (the person is still signed in)', async () => {
    const { effects, calls } = recorder({
      signOut: async () => {
        throw new Error('offline');
      },
    });
    await runSignOut(effects, INPUT);
    expect(calls).not.toContain('removeExportedFiles');
  });

  it('a throwing cache or memory reset does not stop the other one', async () => {
    const { effects, calls, reported } = recorder({
      clearQueryCache: () => {
        throw new Error('boom');
      },
    });
    const result = await runSignOut(effects, INPUT);
    expect(result).toEqual({ ok: true, warnings: 1 });
    expect(reported).toEqual(['signOut.cleanup']);
    expect(calls.at(-1)).toBe('resetInMemoryState');
  });

  it('reports no personal data: only a context label per problem', async () => {
    const { effects, reported } = recorder({
      unregisterDevice: async () => {
        throw new Error(`token for ${USER}`);
      },
    });
    await runSignOut(effects, INPUT);
    expect(reported.join(' ')).not.toContain(USER);
  });
});
