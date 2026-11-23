import { describe, expect, it } from 'vitest';

import type { LegalFeatures } from '@/features/legal/constants';

import { aboutYouAvailable, aboutYouPromptStorageKey, parseSeen, promptState } from './prompt';

const OFF: LegalFeatures = { demographics: false, emergencyContact: false, workoutLogs: false, eventPosts: false, accountLinking: false };

describe('prompt storage', () => {
  it('is per user and made only of characters the secure store accepts', () => {
    const key = aboutYouPromptStorageKey('0b8e7c1e-1111-4222-8333-444455556666');
    expect(key).toBe('trainhive.about-you-seen.0b8e7c1e-1111-4222-8333-444455556666');
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(aboutYouPromptStorageKey('a')).not.toBe(aboutYouPromptStorageKey('b'));
  });

  it('reads only the exact stored marker as seen', () => {
    expect(parseSeen('1')).toBe(true);
    expect(parseSeen(null)).toBe(false);
    expect(parseSeen('true')).toBe(false);
  });
});

describe('prompt state', () => {
  it('shows the page once for someone who has not dealt with it', () => {
    expect(promptState({ available: true, seen: false })).toBe('show');
    expect(promptState({ available: true, seen: true })).toBe('done');
  });

  it('waits for the device read, and never pushes the page on someone when the read failed', () => {
    expect(promptState({ available: true, seen: undefined })).toBe('checking');
    expect(promptState({ available: true, seen: null })).toBe('done');
  });

  it('never shows the page when the features are not shipped', () => {
    expect(promptState({ available: false, seen: false })).toBe('done');
    expect(aboutYouAvailable(OFF)).toBe(false);
    expect(aboutYouAvailable({ ...OFF, demographics: true })).toBe(true);
    expect(aboutYouAvailable({ ...OFF, emergencyContact: true })).toBe(true);
    expect(aboutYouAvailable({ ...OFF, workoutLogs: true })).toBe(false);
  });
});
