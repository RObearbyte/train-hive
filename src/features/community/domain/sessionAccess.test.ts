import { describe, expect, it } from 'vitest';

import { isOrganizerOf, roleInCommunity } from './sessionAccess';

const A = '0f0f0f0f-0000-4000-8000-00000000000a';
const B = '0f0f0f0f-0000-4000-8000-00000000000b';
const C = '0f0f0f0f-0000-4000-8000-00000000000c';

// Organizer of A, member of B, not in C.
const mine = [
  { community_id: A, role: 'organizer' as const },
  { community_id: B, role: 'member' as const },
];

describe('roleInCommunity / isOrganizerOf', () => {
  it('looks the role up for the community of the record, whichever one is active', () => {
    expect(roleInCommunity(mine, A)).toBe('organizer');
    expect(roleInCommunity(mine, B)).toBe('member');
    expect(isOrganizerOf(mine, A)).toBe(true);
    // Organizer of A opening B's training: no organizer controls.
    expect(isOrganizerOf(mine, B)).toBe(false);
  });

  it('is the other way round for organizer of B and member of A', () => {
    const other = [
      { community_id: A, role: 'member' as const },
      { community_id: B, role: 'organizer' as const },
    ];
    expect(isOrganizerOf(other, B)).toBe(true);
    expect(isOrganizerOf(other, A)).toBe(false);
  });

  it('a community I do not belong to gives no role (the screen shows no access)', () => {
    expect(roleInCommunity(mine, C)).toBeNull();
    expect(isOrganizerOf(mine, C)).toBe(false);
    expect(roleInCommunity([], A)).toBeNull();
    expect(roleInCommunity(mine, null)).toBeNull();
    expect(roleInCommunity(mine, undefined)).toBeNull();
  });

  it('compares ids case-insensitively', () => {
    expect(roleInCommunity(mine, A.toUpperCase())).toBe('organizer');
  });
});

describe('attendance route access (the community of the training decides)', () => {
  it('lets the organizer of that community in even when another community is active', () => {
    const sessionOfB = { community_id: B };
    const asOrganizerOfB = [
      { community_id: A, role: 'member' as const },
      { community_id: B, role: 'organizer' as const },
    ];
    expect(isOrganizerOf(asOrganizerOfB, sessionOfB.community_id)).toBe(true);
  });

  it('refuses an organizer of another community and a stranger', () => {
    expect(isOrganizerOf(mine, B)).toBe(false);
    expect(isOrganizerOf(mine, C)).toBe(false);
    expect(isOrganizerOf([], A)).toBe(false);
  });
});
