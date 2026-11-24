import { describe, expect, it } from 'vitest';

import type { LegalFeatures } from '@/features/legal/constants';

import { parseSecureSeen, secureAccountAvailable, securePromptStorageKey } from './securePrompt';

const OFF: LegalFeatures = { demographics: false, emergencyContact: false, workoutLogs: false, eventPosts: false, accountLinking: false };

describe('secure-account note', () => {
  it('is per user and made only of characters the secure store accepts', () => {
    const key = securePromptStorageKey('0b8e7c1e-1111-4222-8333-444455556666');
    expect(key).toBe('trainhive.secure-account-seen.0b8e7c1e-1111-4222-8333-444455556666');
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(securePromptStorageKey('a')).not.toBe(securePromptStorageKey('b'));
  });
  it('reads only the exact marker as seen', () => {
    expect(parseSecureSeen('1')).toBe(true);
    expect(parseSecureSeen(null)).toBe(false);
    expect(parseSecureSeen('true')).toBe(false);
  });
  it('is available only while email linking ships', () => {
    expect(secureAccountAvailable(OFF)).toBe(false);
    expect(secureAccountAvailable({ ...OFF, accountLinking: true })).toBe(true);
  });
});
