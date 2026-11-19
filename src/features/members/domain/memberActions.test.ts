import { describe, expect, it } from 'vitest';

import type { MyCommunity } from '@/lib/database.types';
import { toAppError } from '@/lib/errors';

import {
  ACTION_LABELS,
  actionConfirmation,
  availableActions,
  leaveErrorMessage,
  leaveNeedsHandover,
  memberActionErrorMessage,
  rosterName,
  splitRoster,
  withoutCommunity,
  type RosterEntry,
} from './memberActions';

function entry(id: string, overrides: Partial<RosterEntry> = {}): RosterEntry {
  return {
    membershipId: `m-${id}`,
    userId: id,
    displayName: id.toUpperCase(),
    role: 'member',
    status: 'active',
    joinedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const raised = (message: string) => toAppError({ code: 'P0001', message });

describe('rosterName', () => {
  it('shows the name, or a neutral fallback', () => {
    expect(rosterName(entry('a', { displayName: 'Ana' }))).toBe('Ana');
    expect(rosterName(entry('a', { displayName: null }))).toBe('Member');
    expect(rosterName(entry('a', { displayName: '  ' }))).toBe('Member');
    expect(rosterName(entry('a', { displayName: null, status: 'removed' }))).toBe('Former member');
  });
});

describe('splitRoster', () => {
  it('sorts active members by name and puts removed ones apart, newest joiner first', () => {
    const { active, former } = splitRoster([
      entry('c', { displayName: 'cara' }),
      entry('a', { displayName: 'Ana', role: 'organizer' }),
      entry('b', { displayName: 'Ben' }),
      entry('x', { displayName: null, status: 'removed', joinedAt: '2026-02-01T00:00:00Z' }),
      entry('y', { displayName: null, status: 'removed', joinedAt: '2026-03-01T00:00:00Z' }),
    ]);
    expect(active.map((e) => e.userId)).toEqual(['a', 'b', 'c']);
    expect(former.map((e) => e.userId)).toEqual(['y', 'x']);
  });

  it('does not mutate its input and handles an empty roster', () => {
    const input = [entry('b'), entry('a')];
    splitRoster(input);
    expect(input.map((e) => e.userId)).toEqual(['b', 'a']);
    expect(splitRoster([])).toEqual({ active: [], former: [] });
  });
});

describe('availableActions', () => {
  it('offers promote and remove for a member, demote and remove for an organizer', () => {
    expect(availableActions(entry('b'), 'me')).toEqual(['make_organizer', 'remove']);
    expect(availableActions(entry('b', { role: 'organizer' }), 'me')).toEqual(['make_member', 'remove']);
  });

  it('offers nothing on oneself', () => {
    expect(availableActions(entry('me', { role: 'organizer' }), 'me')).toEqual([]);
  });

  it('offers nothing for removed people', () => {
    expect(availableActions(entry('b', { status: 'removed' }), 'me')).toEqual([]);
  });

  it('still offers actions while my own id is unknown (the server refuses self-actions)', () => {
    expect(availableActions(entry('b'), null)).toHaveLength(2);
  });

  it('has a label for every action', () => {
    expect(Object.values(ACTION_LABELS)).toEqual(['Make organizer', 'Make member', 'Remove from community']);
  });
});

describe('actionConfirmation', () => {
  it('names the person and the community, and marks only removal as destructive', () => {
    const promote = actionConfirmation('make_organizer', 'Ben', 'Alpha');
    const demote = actionConfirmation('make_member', 'Ben', 'Alpha');
    const remove = actionConfirmation('remove', 'Ben', 'Alpha');
    expect(promote.title).toContain('Ben');
    expect(promote.destructive).toBe(false);
    expect(demote.destructive).toBe(false);
    expect(remove.destructive).toBe(true);
    expect(remove.message).toMatch(/loses access/);
    expect(remove.message).toMatch(/released/);
    expect(remove.message).toMatch(/history stays/);
    expect(remove.message).toMatch(/cannot rejoin/);
  });
});

describe('error messages', () => {
  it('maps every documented organizer-tool error to friendly text', () => {
    expect(memberActionErrorMessage(raised('last_organizer'))).toBe(
      'A community needs at least one organizer. Make another member an organizer first.',
    );
    expect(memberActionErrorMessage(raised('cannot_change_own_role'))).toMatch(/own role/);
    expect(memberActionErrorMessage(raised('cannot_remove_self'))).toMatch(/Leave this community/);
    expect(memberActionErrorMessage(raised('forbidden'))).toBe('Only an organizer can do that.');
    expect(memberActionErrorMessage(raised('not_found'))).toMatch(/could not find/i);
    expect(memberActionErrorMessage(new Error('Network request failed'))).toMatch(/no connection/i);
  });

  it('points a last organizer who leaves to the Members screen', () => {
    expect(leaveErrorMessage(raised('last_organizer'))).toMatch(/Members screen/);
    expect(leaveNeedsHandover(raised('last_organizer'))).toBe(true);
    expect(leaveNeedsHandover(raised('not_a_member'))).toBe(false);
    expect(leaveErrorMessage(raised('not_a_member'))).toMatch(/not a member/i);
  });
});

describe('withoutCommunity', () => {
  const community = (id: string): MyCommunity => ({
    community_id: id,
    membership_id: `m-${id}`,
    name: id,
    timezone: 'UTC',
    role: 'member',
    joined_at: '2026-01-01T00:00:00Z',
  });

  it('drops the community that was left, whatever the id case', () => {
    expect(withoutCommunity([community('AA'), community('bb')], 'aa').map((c) => c.community_id)).toEqual(['bb']);
    expect(withoutCommunity([community('aa')], 'aa')).toEqual([]);
    expect(withoutCommunity([community('aa')], 'zz')).toHaveLength(1);
  });
});
