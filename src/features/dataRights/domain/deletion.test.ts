import { describe, expect, it } from 'vitest';

import type { MyDeletionBlockers } from '@/lib/database.types';
import { AppError, toAppError } from '@/lib/errors';
import { ACCEPTANCE_STORAGE_KEY } from '@/features/legal/domain/acceptance';

import {
  ACCOUNT_DELETED_NOTICE,
  INITIAL_DELETION_STATE,
  blockerSentence,
  canSubmitDeletion,
  classifyDeleteError,
  deletionReducer,
  isDeleteConfirmed,
  parseBlockers,
  parseDeletionBlockedDetail,
  runAccountDeletedCleanup,
  type DeletionState,
} from './deletion';

const COMMUNITY = { community_id: 'c1', name: 'Alpha Pack', active_members: 3 };

function blockers(overrides: Partial<MyDeletionBlockers> = {}): MyDeletionBlockers {
  return { can_delete: true, last_organizer: [], deleted_with_account: [], ...overrides };
}

const raised = (message: string, details?: string) => ({ code: 'P0001', message, details });

describe('typed confirmation', () => {
  it('accepts DELETE in any case, trimmed', () => {
    for (const typed of ['DELETE', 'delete', ' Delete ', '\tdElEtE\n']) expect(isDeleteConfirmed(typed)).toBe(true);
  });

  it('refuses everything else', () => {
    for (const typed of ['', 'DELET', 'DELETE ME', 'del ete', 'delete!', 'șterge']) expect(isDeleteConfirmed(typed)).toBe(false);
  });
});

describe('deletion steps', () => {
  it('starts checking, then goes to the explanation when nothing blocks', () => {
    const state = deletionReducer(INITIAL_DELETION_STATE, { type: 'blockers_loaded', blockers: blockers() });
    expect(state.step).toBe('explain');
  });

  it('is blocked while the person is the last organizer of a community with members', () => {
    const state = deletionReducer(INITIAL_DELETION_STATE, {
      type: 'blockers_loaded',
      blockers: blockers({ can_delete: false, last_organizer: [COMMUNITY] }),
    });
    expect(state.step).toBe('blocked');
    expect(deletionReducer(state, { type: 'next' })).toBe(state);
  });

  it('moves explain -> confirm -> explain, and ignores next / back elsewhere', () => {
    let state: DeletionState = deletionReducer(INITIAL_DELETION_STATE, { type: 'blockers_loaded', blockers: blockers() });
    state = deletionReducer(state, { type: 'next' });
    expect(state.step).toBe('confirm');
    expect(deletionReducer(state, { type: 'next' })).toBe(state);
    state = deletionReducer(state, { type: 'back' });
    expect(state.step).toBe('explain');
    expect(deletionReducer(state, { type: 'back' })).toBe(state);
    expect(deletionReducer(INITIAL_DELETION_STATE, { type: 'next' })).toBe(INITIAL_DELETION_STATE);
  });

  it('turns blocked when the server says so at the last moment, keeping what it knew', () => {
    const confirm: DeletionState = {
      step: 'confirm',
      blockers: blockers({ deleted_with_account: [{ community_id: 'c9', name: 'Solo' }] }),
    };
    const state = deletionReducer(confirm, { type: 'blocked_by_server', communities: [COMMUNITY] });
    expect(state.step).toBe('blocked');
    expect(state.blockers?.last_organizer).toEqual([COMMUNITY]);
    expect(state.blockers?.deleted_with_account).toHaveLength(1);
    expect(state.blockers?.can_delete).toBe(false);
  });

  it('reset starts over', () => {
    expect(deletionReducer({ step: 'confirm', blockers: blockers() }, { type: 'reset' })).toBe(INITIAL_DELETION_STATE);
  });

  it('enables the final button only on the confirm step, with the word typed, when idle', () => {
    const confirm: DeletionState = { step: 'confirm', blockers: blockers() };
    expect(canSubmitDeletion(confirm, 'delete', false)).toBe(true);
    expect(canSubmitDeletion(confirm, 'delete', true)).toBe(false);
    expect(canSubmitDeletion(confirm, 'nope', false)).toBe(false);
    expect(canSubmitDeletion({ step: 'explain', blockers: blockers() }, 'delete', false)).toBe(false);
    expect(canSubmitDeletion({ step: 'blocked', blockers: blockers() }, 'delete', false)).toBe(false);
  });
});

describe('parseBlockers', () => {
  it('reads the server answer', () => {
    const parsed = parseBlockers({
      can_delete: false,
      last_organizer: [COMMUNITY],
      deleted_with_account: [{ community_id: 'c2', name: 'Solo' }],
    });
    expect(parsed.last_organizer).toEqual([COMMUNITY]);
    expect(parsed.deleted_with_account).toEqual([{ community_id: 'c2', name: 'Solo' }]);
    expect(parsed.can_delete).toBe(false);
  });

  it('never reads a malformed answer as "nothing blocks"', () => {
    expect(() => parseBlockers(null)).toThrow(AppError);
    expect(() => parseBlockers({ can_delete: true })).toThrow(AppError);
    expect(() => parseBlockers({ last_organizer: [{ name: 'x' }], deleted_with_account: [] })).toThrow(AppError);
    expect(() => parseBlockers({ last_organizer: [], deleted_with_account: [42] })).toThrow(AppError);
  });
});

describe('parseDeletionBlockedDetail', () => {
  it('reads the JSON in the error details', () => {
    const details = JSON.stringify({ communities: [COMMUNITY] });
    expect(parseDeletionBlockedDetail(raised('last_organizer', details))).toEqual([COMMUNITY]);
    expect(parseDeletionBlockedDetail(toAppError(raised('last_organizer', details)))).toEqual([COMMUNITY]);
  });

  it('gives an empty list for missing or broken details', () => {
    expect(parseDeletionBlockedDetail(raised('last_organizer'))).toEqual([]);
    expect(parseDeletionBlockedDetail(raised('last_organizer', 'not json'))).toEqual([]);
    expect(parseDeletionBlockedDetail(raised('last_organizer', '{"communities":"x"}'))).toEqual([]);
    expect(parseDeletionBlockedDetail('oops')).toEqual([]);
  });

  it('skips unreadable entries', () => {
    const details = JSON.stringify({ communities: [COMMUNITY, { nope: true }] });
    expect(parseDeletionBlockedDetail(raised('last_organizer', details))).toEqual([COMMUNITY]);
  });
});

describe('classifyDeleteError', () => {
  it('treats not_authenticated as already deleted', () => {
    expect(classifyDeleteError(raised('not_authenticated'))).toEqual({ kind: 'deleted' });
  });

  it('carries the communities of last_organizer', () => {
    const details = JSON.stringify({ communities: [COMMUNITY] });
    expect(classifyDeleteError(raised('last_organizer', details))).toEqual({ kind: 'blocked', communities: [COMMUNITY] });
  });

  it('keeps the person on screen for network errors', () => {
    expect(classifyDeleteError(new Error('Network request failed'))).toEqual({ kind: 'network' });
  });

  it('reports anything else', () => {
    const outcome = classifyDeleteError(new Error('boom'));
    expect(outcome.kind).toBe('failed');
  });
});

describe('blockerSentence', () => {
  it('names the community and counts the other members', () => {
    expect(blockerSentence(COMMUNITY)).toBe('You are the only organizer of Alpha Pack, which still has 2 other members.');
    expect(blockerSentence({ ...COMMUNITY, active_members: 2 })).toContain('1 other member.');
  });
});

describe('runAccountDeletedCleanup', () => {
  function setup(options: { failSignOut?: boolean; failRemove?: string } = {}) {
    const calls: string[] = [];
    const effects = {
      setNotice: (message: string) => calls.push(`notice:${message}`),
      signOutLocal: async () => {
        calls.push('signOutLocal');
        if (options.failSignOut) throw new Error('boom');
      },
      removeStored: async (key: string) => {
        calls.push(`remove:${key}`);
        if (key === options.failRemove) throw new Error('storage');
      },
      removeExportedFiles: async () => {
        calls.push('removeExportedFiles');
      },
      clearQueryCache: () => calls.push('clearQueryCache'),
      resetInMemoryState: () => calls.push('resetInMemoryState'),
      report: (context: string) => calls.push(`report:${context}`),
    };
    return { calls, effects };
  }
  const input = { userId: 'u1', authStorageKey: 'auth-key' };

  it('sets the notice first, then signs out locally, then clears everything the sign-out clears', async () => {
    const { calls, effects } = setup();
    const warnings = await runAccountDeletedCleanup(effects, input);
    expect(warnings).toBe(0);
    expect(calls[0]).toBe(`notice:${ACCOUNT_DELETED_NOTICE}`);
    expect(calls[1]).toBe('signOutLocal');
    expect(calls).toContain('remove:auth-key');
    expect(calls).toContain(`remove:${ACCEPTANCE_STORAGE_KEY}`);
    expect(calls).toContain('remove:trainhive.active-community.u1');
    expect(calls).toContain('removeExportedFiles');
    expect(calls.slice(-2)).toEqual(['clearQueryCache', 'resetInMemoryState']);
  });

  it('keeps going when the local sign-out or a storage removal fails', async () => {
    const { calls, effects } = setup({ failSignOut: true, failRemove: 'auth-key' });
    const warnings = await runAccountDeletedCleanup(effects, input);
    expect(warnings).toBe(2);
    expect(calls).toContain('report:deleteAccount.signOutLocal');
    expect(calls).toContain('report:signOut.removeStored');
    expect(calls).toContain('clearQueryCache');
    expect(calls).toContain('resetInMemoryState');
  });
});
