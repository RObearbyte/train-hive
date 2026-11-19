import { describe, expect, it } from 'vitest';

import { roleInCommunity } from '@/features/community/domain/sessionAccess';
import type { InvitationCode } from '@/lib/database.types';

import {
  FAB_CLEARANCE,
  FAB_SIZE,
  INITIAL_QUICK_INVITE,
  inviteFabVisible,
  QUICK_INVITE_CREATED_HINT,
  QUICK_INVITE_DEFAULTS,
  quickInviteReducer,
  quickInviteRequest,
  type QuickInviteEvent,
  type QuickInviteState,
} from './quickInvite';

import { createInvitationFailure } from './createInvitation';

const INVITATION = { id: 'i1', code: 'ABCDEFGH' } as unknown as InvitationCode;
const run = (events: QuickInviteEvent[], from: QuickInviteState = INITIAL_QUICK_INVITE) =>
  events.reduce(quickInviteReducer, from);

describe('quickInviteRequest', () => {
  it('defaults to 30 days and one use', () => {
    expect(QUICK_INVITE_DEFAULTS).toEqual({ expiry: '30d', maxUses: 1 });
    const now = new Date('2026-11-19T10:00:00.000Z');
    expect(quickInviteRequest(now)).toEqual({
      expiresAt: '2026-12-19T10:00:00.000Z',
      maxRedemptions: 1,
    });
  });
});

describe('inviteFabVisible', () => {
  const base = { isOrganizerOfActive: true, activeCommunityId: 'c1', keyboardVisible: false };
  it('shows for an organizer of the active community', () => {
    expect(inviteFabVisible(base)).toBe(true);
  });
  it('is hidden for members, without an active community and while the keyboard is open', () => {
    expect(inviteFabVisible({ ...base, isOrganizerOfActive: false })).toBe(false);
    expect(inviteFabVisible({ ...base, activeCommunityId: null })).toBe(false);
    expect(inviteFabVisible({ ...base, keyboardVisible: true })).toBe(false);
  });
  it('follows the role in the ACTIVE community, not in another one', () => {
    const communities = [
      { community_id: 'c1', role: 'organizer' as const },
      { community_id: 'c2', role: 'member' as const },
    ];
    const visibleIn = (active: string) =>
      inviteFabVisible({
        isOrganizerOfActive: roleInCommunity(communities, active) === 'organizer',
        activeCommunityId: active,
        keyboardVisible: false,
      });
    expect(visibleIn('c1')).toBe(true);
    expect(visibleIn('c2')).toBe(false);
  });
  it('is a 56 px button with room below the content', () => {
    expect(FAB_SIZE).toBe(56);
    expect(FAB_CLEARANCE).toBeGreaterThan(FAB_SIZE);
  });
});

describe('quickInviteReducer', () => {
  it('goes idle -> creating -> created', () => {
    const creating = run([{ type: 'create' }]);
    expect(creating).toEqual({ phase: 'creating', attempt: 1 });
    expect(run([{ type: 'succeeded', attempt: 1, invitation: INVITATION }], creating)).toEqual({
      phase: 'created',
      attempt: 1,
      invitation: INVITATION,
    });
  });

  it('ignores a second tap while creating (one request at a time)', () => {
    const creating = run([{ type: 'create' }]);
    expect(quickInviteReducer(creating, { type: 'create' })).toBe(creating);
  });

  it('shows an error and allows a retry', () => {
    const failed = run([
      { type: 'create' },
      { type: 'failed', attempt: 1, error: { code: 'network_error' } },
    ]);
    expect(failed).toEqual({ phase: 'error', attempt: 1, error: { code: 'network_error' } });
    expect(run([{ type: 'create' }], failed)).toEqual({ phase: 'creating', attempt: 2 });
  });

  it('creates another from a created code', () => {
    const created = run([
      { type: 'create' },
      { type: 'succeeded', attempt: 1, invitation: INVITATION },
    ]);
    expect(run([{ type: 'create' }], created)).toEqual({ phase: 'creating', attempt: 2 });
  });

  it('ignores answers for an older attempt or after closing', () => {
    const creating = run([{ type: 'create' }]);
    const closed = run([{ type: 'close' }], creating);
    expect(closed.phase).toBe('idle');
    expect(quickInviteReducer(closed, { type: 'succeeded', attempt: 1, invitation: INVITATION })).toBe(closed);
    const second = run([{ type: 'create' }], closed);
    expect(quickInviteReducer(second, { type: 'succeeded', attempt: 1, invitation: INVITATION })).toBe(second);
    expect(quickInviteReducer(second, { type: 'failed', attempt: 1, error: { code: 'unknown' } })).toBe(second);
  });

  it('ignores an answer when nothing is being created', () => {
    expect(
      quickInviteReducer(INITIAL_QUICK_INVITE, { type: 'succeeded', attempt: 0, invitation: INVITATION }),
    ).toBe(INITIAL_QUICK_INVITE);
  });
});

describe('quick invite messages', () => {
  it('the created state hints at the 30 day validity and where to revoke', () => {
    expect(QUICK_INVITE_CREATED_HINT).toBe(
      'This code stays valid for 30 days. You can see or revoke it in Invitations.',
    );
    expect(QUICK_INVITE_DEFAULTS.expiry).toBe('30d');
  });
  it('a refused expires_at reads as a device clock problem', () => {
    const state = run([
      { type: 'create' },
      { type: 'failed', attempt: 1, error: { code: 'validation_failed', field: 'expires_at' } },
    ]);
    if (state.phase !== 'error') throw new Error('expected error');
    expect(createInvitationFailure(state.error).message).toContain("Check this device's date and time");
  });
});
