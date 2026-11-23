import { describe, expect, it } from 'vitest';

import { INITIAL_QUICK_INVITE, inviteFabVisible, quickInviteReducer, quickInviteRequest } from './quickInvite';

const invitation = { code: 'ABCD2345' } as never;

describe('Q8 quick invite', () => {
  it('visible only for an organizer of the ACTIVE community, never with the keyboard open', () => {
    expect(inviteFabVisible({ isOrganizerOfActive: true, activeCommunityId: 'a', keyboardVisible: false })).toBe(true);
    expect(inviteFabVisible({ isOrganizerOfActive: false, activeCommunityId: 'b', keyboardVisible: false })).toBe(false);
    expect(inviteFabVisible({ isOrganizerOfActive: true, activeCommunityId: null, keyboardVisible: false })).toBe(false);
    expect(inviteFabVisible({ isOrganizerOfActive: true, activeCommunityId: 'a', keyboardVisible: true })).toBe(false);
  });

  it('O1 fixed: sends a 30-day DURATION, so a phone whose clock is 40 days behind gets the same request', () => {
    expect(quickInviteRequest()).toEqual({ expiresInHours: 720, maxRedemptions: 1 });
    expect(quickInviteRequest).toHaveLength(0); // no clock argument at all
  });

  it('double tap, close during creation and a late answer: only the current attempt is shown', () => {
    let s = quickInviteReducer(INITIAL_QUICK_INVITE, { type: 'create' });
    expect(quickInviteReducer(s, { type: 'create' })).toBe(s);
    const first = s.attempt;
    s = quickInviteReducer(s, { type: 'close' });
    expect(s.phase).toBe('idle');
    expect(quickInviteReducer(s, { type: 'succeeded', attempt: first, invitation })).toBe(s);
    s = quickInviteReducer(s, { type: 'create' });
    const second = s.attempt;
    expect(quickInviteReducer(s, { type: 'succeeded', attempt: first, invitation })).toBe(s);
    expect(quickInviteReducer(s, { type: 'succeeded', attempt: second, invitation }).phase).toBe('created');
    const failed = quickInviteReducer(s, { type: 'failed', attempt: second, error: { code: 'forbidden' } });
    expect(quickInviteReducer(failed, { type: 'create' }).phase).toBe('creating');
  });
});
