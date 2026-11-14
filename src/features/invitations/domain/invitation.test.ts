import { describe, expect, it } from 'vitest';

import {
  invitationState,
  remainingUses,
  remainingUsesText,
} from '@/features/invitations/domain/invitation';
import type { InvitationCode } from '@/lib/database.types';

const NOW = new Date('2026-11-14T10:00:00Z');

function makeInvitation(overrides: Partial<InvitationCode> = {}): InvitationCode {
  return {
    id: 'invitation-1',
    community_id: 'community-1',
    code: 'K7MQ9XW2',
    role: 'member',
    created_by: 'user-1',
    expires_at: null,
    max_redemptions: null,
    redemption_count: 0,
    revoked_at: null,
    created_at: '2026-11-01T10:00:00+00:00',
    ...overrides,
  };
}

describe('invitationState', () => {
  it('is active with no expiry and no limit', () => {
    expect(invitationState(makeInvitation(), NOW)).toBe('active');
    expect(invitationState(makeInvitation({ redemption_count: 500 }), NOW)).toBe('active');
  });

  it('is active before the expiry and expired from the expiry on', () => {
    const invitation = makeInvitation({ expires_at: '2026-11-14T10:00:00+00:00' });
    expect(invitationState(invitation, new Date('2026-11-14T09:59:59.999Z'))).toBe('active');
    expect(invitationState(invitation, NOW)).toBe('expired');
    expect(invitationState(invitation, new Date('2026-11-15T00:00:00Z'))).toBe('expired');
  });

  it('is exhausted once the redemptions reach the maximum', () => {
    expect(invitationState(makeInvitation({ max_redemptions: 3, redemption_count: 2 }), NOW)).toBe(
      'active',
    );
    expect(invitationState(makeInvitation({ max_redemptions: 3, redemption_count: 3 }), NOW)).toBe(
      'exhausted',
    );
    expect(invitationState(makeInvitation({ max_redemptions: 3, redemption_count: 4 }), NOW)).toBe(
      'exhausted',
    );
    expect(invitationState(makeInvitation({ max_redemptions: 1, redemption_count: 1 }), NOW)).toBe(
      'exhausted',
    );
  });

  it('is revoked when revoked_at is set', () => {
    expect(invitationState(makeInvitation({ revoked_at: '2026-11-10T10:00:00+00:00' }), NOW)).toBe(
      'revoked',
    );
  });

  it('prefers revoked, then expired, then exhausted', () => {
    const everything = makeInvitation({
      revoked_at: '2026-11-10T10:00:00+00:00',
      expires_at: '2026-11-12T10:00:00+00:00',
      max_redemptions: 1,
      redemption_count: 1,
    });
    expect(invitationState(everything, NOW)).toBe('revoked');
    expect(invitationState({ ...everything, revoked_at: null }, NOW)).toBe('expired');
    expect(invitationState({ ...everything, revoked_at: null, expires_at: null }, NOW)).toBe(
      'exhausted',
    );
  });

  it('uses the injected now', () => {
    const invitation = makeInvitation({ expires_at: '2030-01-01T00:00:00+00:00' });
    expect(invitationState(invitation, NOW)).toBe('active');
    expect(invitationState(invitation, new Date('2030-01-01T00:00:00Z'))).toBe('expired');
  });
});

describe('remainingUses', () => {
  it('is null without a limit', () => {
    expect(remainingUses(makeInvitation({ redemption_count: 7 }))).toBeNull();
  });

  it('counts down and never goes negative', () => {
    expect(remainingUses(makeInvitation({ max_redemptions: 5, redemption_count: 0 }))).toBe(5);
    expect(remainingUses(makeInvitation({ max_redemptions: 5, redemption_count: 4 }))).toBe(1);
    expect(remainingUses(makeInvitation({ max_redemptions: 5, redemption_count: 5 }))).toBe(0);
    expect(remainingUses(makeInvitation({ max_redemptions: 5, redemption_count: 6 }))).toBe(0);
  });

  it('has singular and plural text', () => {
    expect(remainingUsesText(makeInvitation())).toBe('Unlimited uses');
    expect(remainingUsesText(makeInvitation({ max_redemptions: 5, redemption_count: 2 }))).toBe(
      '3 uses left',
    );
    expect(remainingUsesText(makeInvitation({ max_redemptions: 5, redemption_count: 4 }))).toBe(
      '1 use left',
    );
    expect(remainingUsesText(makeInvitation({ max_redemptions: 5, redemption_count: 5 }))).toBe(
      'No uses left',
    );
  });
});
