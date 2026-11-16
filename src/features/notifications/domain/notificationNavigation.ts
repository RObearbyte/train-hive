/**
 * What happens when someone taps a notification: a small pure state machine.
 *
 * A tap may belong to another community than the active one, and on a cold
 * start it arrives before the memberships are known. The machine is driven
 * only by explicit inputs (tap events, the server's answer about the
 * notification's community, the current active community and membership list)
 * and answers with commands the hook carries out. There is no readiness flag
 * to flip by hand: every input runs through `step`, which decides again from
 * what it knows, so a tap navigates exactly once and never later at an
 * unrelated moment.
 *
 *   tap -> lookup (which community?) -> decide -> [switch ->] navigate
 *
 * Rules:
 * - the latest tap wins; answers to an older tap are ignored (`seq`);
 * - a tap whose community is the active one, unknown, or could not be looked
 *   up opens in the current community (the screen itself checks access);
 * - a tap for another community the user belongs to switches first and
 *   navigates once that community is active;
 * - a tap for a community the user is no longer a member of is dropped (it
 *   could only show something they cannot use), also when the membership
 *   disappears during the switch or the user moves elsewhere meanwhile;
 * - a notification id that was already handled is ignored.
 */

const MAX_REMEMBERED = 200;

export interface NavTap {
  /** Notification id, or the OS identifier when the payload had none; used to ignore repeats. */
  id: string | null;
  /** An allowlisted internal route (see `targetFromPushData`). */
  href: string;
  /** Server notification id, when the payload carried one. */
  notificationId: string | null;
}

export interface NavContext {
  /** The memberships and the active community are known. */
  ready: boolean;
  activeId: string | null;
  /** Every active membership of the user. */
  memberIds: readonly string[];
}

type Pending =
  | { phase: 'lookup'; seq: number; tap: NavTap }
  | { phase: 'decide'; seq: number; tap: NavTap; target: string | null }
  | { phase: 'switching'; seq: number; tap: NavTap; target: string; from: string | null };

export interface NavState {
  context: NavContext;
  pending: Pending | null;
  /** Sequence number of the latest tap. */
  seq: number;
  /** Recently handled ids, oldest first. */
  handled: readonly string[];
}

export type NavEvent =
  | { type: 'tap'; tap: NavTap }
  /** The community of the tapped notification; null when unknown or the lookup failed. */
  | { type: 'community-found'; seq: number; communityId: string | null }
  | { type: 'context'; context: NavContext }
  /** The screen that hosts the machine went away: forget the waiting tap. */
  | { type: 'reset' };

export type NavCommand =
  | { type: 'lookup'; seq: number; notificationId: string }
  | { type: 'switch'; communityId: string }
  | { type: 'navigate'; href: string; notificationId: string | null };

export interface NavResult {
  state: NavState;
  commands: NavCommand[];
}

export const INITIAL_NAV_CONTEXT: NavContext = { ready: false, activeId: null, memberIds: [] };

export function initialNavState(): NavState {
  return { context: INITIAL_NAV_CONTEXT, pending: null, seq: 0, handled: [] };
}

const same = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

const isMember = (context: NavContext, id: string): boolean => context.memberIds.some((member) => same(member, id));

function remember(handled: readonly string[], id: string): readonly string[] {
  const next = [...handled, id];
  return next.length > MAX_REMEMBERED ? next.slice(next.length - MAX_REMEMBERED) : next;
}

/** Decides what the waiting tap needs now, given everything known. */
function settle(state: NavState): NavResult {
  const { pending, context } = state;
  if (pending === null || pending.phase === 'lookup' || !context.ready) return { state, commands: [] };

  const done = (commands: NavCommand[]): NavResult => ({ state: { ...state, pending: null }, commands });
  const navigate = (): NavResult =>
    done([{ type: 'navigate', href: pending.tap.href, notificationId: pending.tap.notificationId }]);

  if (pending.phase === 'decide') {
    const { target } = pending;
    if (target === null || same(target, context.activeId)) return navigate();
    if (!isMember(context, target)) return done([]);
    return {
      state: { ...state, pending: { phase: 'switching', seq: pending.seq, tap: pending.tap, target, from: context.activeId } },
      commands: [{ type: 'switch', communityId: target }],
    };
  }

  // Switching: wait for the target to become the active community.
  if (!isMember(context, pending.target)) return done([]);
  if (same(context.activeId, pending.target)) return navigate();
  if (!same(context.activeId, pending.from)) return done([]); // the user moved somewhere else meanwhile
  return { state, commands: [] };
}

export function step(state: NavState, event: NavEvent): NavResult {
  switch (event.type) {
    case 'context':
      return settle({ ...state, context: event.context });

    case 'reset':
      return { state: { ...state, pending: null }, commands: [] };

    case 'tap': {
      const { tap } = event;
      if (tap.id !== null && state.handled.includes(tap.id)) return { state, commands: [] };
      const handled = tap.id === null ? state.handled : remember(state.handled, tap.id);
      const seq = state.seq + 1;
      if (tap.notificationId === null) {
        // Nothing to ask the server: it opens in the current community.
        return settle({ ...state, handled, seq, pending: { phase: 'decide', seq, tap, target: null } });
      }
      return {
        state: { ...state, handled, seq, pending: { phase: 'lookup', seq, tap } },
        commands: [{ type: 'lookup', seq, notificationId: tap.notificationId }],
      };
    }

    case 'community-found': {
      const { pending } = state;
      if (pending === null || pending.phase !== 'lookup' || pending.seq !== event.seq) {
        return { state, commands: [] }; // an older tap, or already handled
      }
      return settle({
        ...state,
        pending: { phase: 'decide', seq: pending.seq, tap: pending.tap, target: event.communityId },
      });
    }
  }
}
