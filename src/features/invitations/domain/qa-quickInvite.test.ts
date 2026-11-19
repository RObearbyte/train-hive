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

  it('sends an absolute expiry 30 days after the DEVICE clock; a phone 40 days behind sends an expiry already in the past', () => {
    expect(quickInviteRequest(new Date('2026-11-19T10:00:00.000Z'))).toEqual({ expiresAt: '2026-12-19T10:00:00.000Z', maxRedemptions: 1 });
    expect(Date.parse(quickInviteRequest(new Date('2026-10-10T10:00:00.000Z')).expiresAt as string)).toBeLessThan(Date.parse('2026-11-19T10:00:00.000Z'));
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
