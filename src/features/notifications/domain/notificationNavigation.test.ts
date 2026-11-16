import { describe, expect, it } from 'vitest';

import {
  initialNavState,
  step,
  type NavCommand,
  type NavContext,
  type NavEvent,
  type NavState,
  type NavTap,
} from './notificationNavigation';

const A = '0f0f0f0f-0000-4000-8000-00000000000a';
const B = '0f0f0f0f-0000-4000-8000-00000000000b';
const C = '0f0f0f0f-0000-4000-8000-00000000000c';

const ready = (activeId: string, memberIds: string[]): NavContext => ({ ready: true, activeId, memberIds });
const tapFor = (n: string, href = `/announcements/${n}`): NavTap => ({ id: n, href, notificationId: n });

/** Feeds events in order, collecting every command. */
function drive(events: NavEvent[], from: NavState = initialNavState()) {
  let state = from;
  const commands: NavCommand[] = [];
  for (const event of events) {
    const result = step(state, event);
    state = result.state;
    commands.push(...result.commands);
  }
  return { state, commands };
}

const navigations = (commands: NavCommand[]) => commands.filter((c) => c.type === 'navigate');

describe('notification navigation state machine', () => {
  it('community already active: looks the community up, then navigates once', () => {
    const { state, commands } = drive([
      { type: 'context', context: ready(A, [A, B]) },
      { type: 'tap', tap: tapFor('n1') },
      { type: 'community-found', seq: 1, communityId: A },
    ]);
    expect(commands).toEqual([
      { type: 'lookup', seq: 1, notificationId: 'n1' },
      { type: 'navigate', href: '/announcements/n1', notificationId: 'n1' },
    ]);
    expect(state.pending).toBeNull();
  });

  it('another community the user belongs to: switches, navigates when it is active, and only then', () => {
    const first = drive([
      { type: 'context', context: ready(A, [A, B]) },
      { type: 'tap', tap: tapFor('n1') },
      { type: 'community-found', seq: 1, communityId: B },
    ]);
    expect(first.commands.map((c) => c.type)).toEqual(['lookup', 'switch']);
    expect(first.commands[1]).toEqual({ type: 'switch', communityId: B });

    // Same inputs again while the switch is still settling: nothing happens.
    const waiting = drive([{ type: 'context', context: ready(A, [A, B]) }], first.state);
    expect(waiting.commands).toEqual([]);

    const arrived = drive([{ type: 'context', context: ready(B, [A, B]) }], waiting.state);
    expect(arrived.commands).toEqual([{ type: 'navigate', href: '/announcements/n1', notificationId: 'n1' }]);
    expect(arrived.state.pending).toBeNull();

    // Later, unrelated context changes never navigate again.
    const later = drive(
      [
        { type: 'context', context: { ready: false, activeId: null, memberIds: [] } },
        { type: 'context', context: ready(B, [A, B]) },
        { type: 'context', context: ready(A, [A, B]) },
      ],
      arrived.state,
    );
    expect(later.commands).toEqual([]);
  });

  it('works the same when the target community is cached (it is active in the very next context)', () => {
    const first = drive([
      { type: 'context', context: ready(A, [A, B]) },
      { type: 'tap', tap: tapFor('n1') },
      { type: 'community-found', seq: 1, communityId: B },
    ]);
    const arrived = drive([{ type: 'context', context: ready(B, [A, B]) }], first.state);
    expect(navigations(arrived.commands)).toHaveLength(1);
    // A repeated identical context does not deliver a second time.
    const again = drive([{ type: 'context', context: ready(B, [A, B]) }], arrived.state);
    expect(again.commands).toEqual([]);
  });

  it('cold start: a tap before the memberships are known waits, then follows the same rules', () => {
    const early = drive([
      { type: 'tap', tap: tapFor('n1') },
      { type: 'community-found', seq: 1, communityId: B },
    ]);
    expect(early.commands.map((c) => c.type)).toEqual(['lookup']);
    expect(early.state.pending?.phase).toBe('decide');

    const loaded = drive([{ type: 'context', context: ready(A, [A, B]) }], early.state);
    expect(loaded.commands).toEqual([{ type: 'switch', communityId: B }]);
    const arrived = drive([{ type: 'context', context: ready(B, [A, B]) }], loaded.state);
    expect(navigations(arrived.commands)).toHaveLength(1);
  });

  it('cold start: the answer may arrive after the memberships', () => {
    const { commands } = drive([
      { type: 'tap', tap: tapFor('n1') },
      { type: 'context', context: ready(A, [A, B]) },
      { type: 'community-found', seq: 1, communityId: A },
    ]);
    expect(navigations(commands)).toHaveLength(1);
  });

  it('a community the user is not a member of: the tap is dropped, nothing navigates, and the machine stays usable', () => {
    const dropped = drive([
      { type: 'context', context: ready(A, [A, B]) },
      { type: 'tap', tap: tapFor('n1') },
      { type: 'community-found', seq: 1, communityId: C },
    ]);
    expect(dropped.commands.map((c) => c.type)).toEqual(['lookup']);
    expect(dropped.state.pending).toBeNull();

    const next = drive(
      [
        { type: 'tap', tap: tapFor('n2') },
        { type: 'community-found', seq: 2, communityId: A },
      ],
      dropped.state,
    );
    expect(navigations(next.commands)).toHaveLength(1);
  });

  it('the switch fails because the target membership disappears: dropped, never navigates later', () => {
    const switching = drive([
      { type: 'context', context: ready(A, [A, B]) },
      { type: 'tap', tap: tapFor('n1') },
      { type: 'community-found', seq: 1, communityId: B },
    ]);
    const removed = drive([{ type: 'context', context: ready(A, [A]) }], switching.state);
    expect(removed.commands).toEqual([]);
    expect(removed.state.pending).toBeNull();
    const later = drive([{ type: 'context', context: ready(B, [A, B]) }], removed.state);
    expect(later.commands).toEqual([]);
  });

  it('the user moves to a third community while the switch is settling: dropped', () => {
    const switching = drive([
      { type: 'context', context: ready(A, [A, B, C]) },
      { type: 'tap', tap: tapFor('n1') },
      { type: 'community-found', seq: 1, communityId: B },
    ]);
    const moved = drive([{ type: 'context', context: ready(C, [A, B, C]) }], switching.state);
    expect(moved.commands).toEqual([]);
    expect(moved.state.pending).toBeNull();
  });

  it('rapid second tap: the latest wins, and the answer to the first tap is ignored', () => {
    const { commands, state } = drive([
      { type: 'context', context: ready(A, [A, B, C]) },
      { type: 'tap', tap: tapFor('n1') },
      { type: 'tap', tap: tapFor('n2') },
      { type: 'community-found', seq: 1, communityId: B }, // late answer for n1
      { type: 'community-found', seq: 2, communityId: A },
    ]);
    expect(navigations(commands)).toEqual([{ type: 'navigate', href: '/announcements/n2', notificationId: 'n2' }]);
    expect(commands.some((c) => c.type === 'switch')).toBe(false);
    expect(state.pending).toBeNull();
  });

  it('a second tap during a switch replaces it', () => {
    const switching = drive([
      { type: 'context', context: ready(A, [A, B, C]) },
      { type: 'tap', tap: tapFor('n1') },
      { type: 'community-found', seq: 1, communityId: B },
    ]);
    const second = drive(
      [
        { type: 'tap', tap: tapFor('n2') },
        { type: 'community-found', seq: 2, communityId: C },
        { type: 'context', context: ready(C, [A, B, C]) },
      ],
      switching.state,
    );
    expect(navigations(second.commands)).toEqual([{ type: 'navigate', href: '/announcements/n2', notificationId: 'n2' }]);
  });

  it('a failed lookup opens the tap in the current community', () => {
    const { commands } = drive([
      { type: 'context', context: ready(A, [A, B]) },
      { type: 'tap', tap: tapFor('n1') },
      { type: 'community-found', seq: 1, communityId: null },
    ]);
    expect(navigations(commands)).toHaveLength(1);
  });

  it('a tap without a notification id needs no lookup', () => {
    const tap: NavTap = { id: 'os-1', href: '/activity', notificationId: null };
    const { commands } = drive([{ type: 'context', context: ready(A, [A]) }, { type: 'tap', tap }]);
    expect(commands).toEqual([{ type: 'navigate', href: '/activity', notificationId: null }]);
  });

  it('a repeat of a handled notification is ignored, from the launch tap and the listener alike', () => {
    const { commands } = drive([
      { type: 'context', context: ready(A, [A]) },
      { type: 'tap', tap: tapFor('n1') },
      { type: 'tap', tap: tapFor('n1') },
      { type: 'community-found', seq: 1, communityId: A },
      { type: 'tap', tap: tapFor('n1') },
    ]);
    expect(commands.filter((c) => c.type === 'lookup')).toHaveLength(1);
    expect(navigations(commands)).toHaveLength(1);
  });

  it('taps without any id are never deduplicated', () => {
    const tap: NavTap = { id: null, href: '/activity', notificationId: null };
    const { commands } = drive([{ type: 'context', context: ready(A, [A]) }, { type: 'tap', tap }, { type: 'tap', tap }]);
    expect(navigations(commands)).toHaveLength(2);
  });

  it('remembers handled ids only up to a bound', () => {
    let state = drive([{ type: 'context', context: ready(A, [A]) }]).state;
    for (let i = 0; i < 250; i += 1) {
      state = drive([{ type: 'tap', tap: { id: `id-${i}`, href: '/activity', notificationId: null } }], state).state;
    }
    const recent = drive([{ type: 'tap', tap: { id: 'id-249', href: '/activity', notificationId: null } }], state);
    expect(recent.commands).toEqual([]);
    const old = drive([{ type: 'tap', tap: { id: 'id-0', href: '/activity', notificationId: null } }], state);
    expect(navigations(old.commands)).toHaveLength(1);
  });

  it('reset forgets a waiting tap but not the sequence, so a late answer is ignored', () => {
    const waiting = drive([{ type: 'tap', tap: tapFor('n1') }]);
    const reset = drive([{ type: 'reset' }], waiting.state);
    const late = drive(
      [
        { type: 'community-found', seq: 1, communityId: A },
        { type: 'context', context: ready(A, [A]) },
      ],
      reset.state,
    );
    expect(late.commands).toEqual([]);
    expect(reset.state.seq).toBe(1);
  });

  it('compares community ids case-insensitively', () => {
    const { commands } = drive([
      { type: 'context', context: ready(A.toUpperCase(), [A.toUpperCase()]) },
      { type: 'tap', tap: tapFor('n1') },
      { type: 'community-found', seq: 1, communityId: A },
    ]);
    expect(navigations(commands)).toHaveLength(1);
    expect(commands.some((c) => c.type === 'switch')).toBe(false);
  });
});
