/**
 * "Delete my account": the steps of the flow, how the server's blockers are
 * read, the typed confirmation, and what happens on this device afterwards.
 * Pure TypeScript with the effects passed in, so the order and the failure
 * rules are unit tested (`deletion.test.ts`).
 */
import type { DeletionBlocker, MyDeletionBlockers } from '@/lib/database.types';
import { AppError, toAppError } from '@/lib/errors';
import { runLocalCleanup, type SignOutEffects } from '@/features/profile/domain/signOut';

/** The word the person types before the final button works. */
export const DELETE_CONFIRM_WORD = 'DELETE';

/** Case-insensitive after trim; nothing else (no extra words) is accepted. */
export function isDeleteConfirmed(typed: string): boolean {
  return typed.trim().toUpperCase() === DELETE_CONFIRM_WORD;
}

export const ACCOUNT_DELETED_NOTICE = 'Your account was deleted.';

export type DeletionStep = 'checking' | 'blocked' | 'explain' | 'confirm';

export type DeletionState = { step: DeletionStep; blockers: MyDeletionBlockers | null };

export type DeletionEvent =
  | { type: 'blockers_loaded'; blockers: MyDeletionBlockers }
  | { type: 'next' }
  | { type: 'back' }
  /** `delete_my_account` answered `last_organizer` (the situation changed since the check). */
  | { type: 'blocked_by_server'; communities: DeletionBlocker[] }
  | { type: 'reset' };

export const INITIAL_DELETION_STATE: DeletionState = { step: 'checking', blockers: null };

export function deletionReducer(state: DeletionState, event: DeletionEvent): DeletionState {
  switch (event.type) {
    case 'reset':
      return INITIAL_DELETION_STATE;
    case 'blockers_loaded':
      return {
        step: event.blockers.last_organizer.length > 0 ? 'blocked' : 'explain',
        blockers: event.blockers,
      };
    case 'next':
      return state.step === 'explain' ? { ...state, step: 'confirm' } : state;
    case 'back':
      return state.step === 'confirm' ? { ...state, step: 'explain' } : state;
    case 'blocked_by_server': {
      const current = state.blockers;
      const communities = event.communities.length > 0 ? event.communities : (current?.last_organizer ?? []);
      return {
        step: 'blocked',
        blockers: {
          can_delete: false,
          last_organizer: communities,
          deleted_with_account: current?.deleted_with_account ?? [],
        },
      };
    }
  }
}

/** The final button works only on the last step, with the word typed, and not while a request runs. */
export function canSubmitDeletion(state: DeletionState, typed: string, pending: boolean): boolean {
  return state.step === 'confirm' && !pending && isDeleteConfirmed(typed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseBlocker(value: unknown): DeletionBlocker | null {
  if (!isRecord(value)) return null;
  const { community_id: id, name, active_members: members } = value;
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  return { community_id: id, name, active_members: typeof members === 'number' ? members : 0 };
}

/**
 * Reads `my_deletion_blockers`. A malformed answer is an error, never "no
 * blockers": that would let the flow continue on a guess.
 */
export function parseBlockers(json: unknown): MyDeletionBlockers {
  if (!isRecord(json) || !Array.isArray(json.last_organizer) || !Array.isArray(json.deleted_with_account)) {
    throw new AppError('unknown', { message: 'my_deletion_blockers returned an unexpected answer.' });
  }
  const lastOrganizer: DeletionBlocker[] = [];
  for (const item of json.last_organizer as unknown[]) {
    const parsed = parseBlocker(item);
    if (parsed === null) throw new AppError('unknown', { message: 'my_deletion_blockers returned an unexpected row.' });
    lastOrganizer.push(parsed);
  }
  const deletedWith: { community_id: string; name: string }[] = [];
  for (const item of json.deleted_with_account as unknown[]) {
    const parsed = parseBlocker(item);
    if (parsed === null) throw new AppError('unknown', { message: 'my_deletion_blockers returned an unexpected row.' });
    deletedWith.push({ community_id: parsed.community_id, name: parsed.name });
  }
  return { can_delete: lastOrganizer.length === 0, last_organizer: lastOrganizer, deleted_with_account: deletedWith };
}

/**
 * The communities in the `details` of a `last_organizer` error from
 * `delete_my_account` (JSON `{"communities":[...]}`). Empty when the error
 * carries no readable details: the caller then keeps what it already knows.
 */
export function parseDeletionBlockedDetail(error: unknown): DeletionBlocker[] {
  const original = error instanceof AppError ? error.original : error;
  const details = isRecord(original) && typeof original.details === 'string' ? original.details : null;
  if (details === null) return [];
  try {
    const parsed: unknown = JSON.parse(details);
    if (!isRecord(parsed) || !Array.isArray(parsed.communities)) return [];
    const out: DeletionBlocker[] = [];
    for (const item of parsed.communities as unknown[]) {
      const blocker = parseBlocker(item);
      if (blocker) out.push(blocker);
    }
    return out;
  } catch {
    return [];
  }
}

export type DeleteOutcome =
  /** The server deleted the account (or it was already gone): clean up this device. */
  | { kind: 'deleted' }
  | { kind: 'blocked'; communities: DeletionBlocker[] }
  /** Nothing happened that we know of: stay on screen and offer a retry. */
  | { kind: 'network' }
  | { kind: 'failed'; error: AppError };

/** What a failed `delete_my_account` means. `not_authenticated` = the account no longer exists. */
export function classifyDeleteError(error: unknown): DeleteOutcome {
  const appError = toAppError(error);
  if (appError.code === 'not_authenticated') return { kind: 'deleted' };
  if (appError.code === 'last_organizer') {
    return { kind: 'blocked', communities: parseDeletionBlockedDetail(error) };
  }
  if (appError.code === 'network_error') return { kind: 'network' };
  return { kind: 'failed', error: appError };
}

/** Blocking text for one community. `active_members` counts the person too. */
export function blockerSentence(blocker: DeletionBlocker): string {
  const others = Math.max(blocker.active_members - 1, 0);
  const who = others === 1 ? '1 other member' : `${others} other members`;
  return `You are the only organizer of ${blocker.name}, which still has ${who}.`;
}

export const BLOCKED_ADVICE =
  'Make another member an organizer first. A community is deleted together with your account only when you are its last member.';

export type AccountDeletedEffects = Pick<
  SignOutEffects,
  'removeStored' | 'removeExportedFiles' | 'clearQueryCache' | 'resetInMemoryState' | 'report'
> & {
  /** Remembers the one-time notice for the welcome screen. */
  setNotice: (message: string) => void;
  /** Ends the session on this device only (the server account is gone, so no server call is needed). */
  signOutLocal: () => Promise<void>;
};

/**
 * After the server deleted the account: the same local cleanup as signing
 * out. The notice is set first (the screens unmount as the session ends), a
 * failing local sign-out is reported and never stops the rest. Returns the
 * number of failed steps.
 */
export async function runAccountDeletedCleanup(
  effects: AccountDeletedEffects,
  input: { userId: string | null; authStorageKey: string },
): Promise<number> {
  effects.setNotice(ACCOUNT_DELETED_NOTICE);
  let warnings = 0;
  try {
    await effects.signOutLocal();
  } catch (error) {
    warnings += 1;
    effects.report('deleteAccount.signOutLocal', error);
  }
  return warnings + (await runLocalCleanup(effects, input));
}
