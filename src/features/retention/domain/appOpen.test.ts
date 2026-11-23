import { describe, expect, it } from 'vitest';

import type { AppOpenResult } from '@/lib/database.types';

import {
  APP_OPEN_MIN_INTERVAL_MS,
  daysUntil,
  inactivityNoticeMessage,
  parseAppOpenResult,
  shouldRecordAppOpen,
} from './appOpen';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function result(overrides: Partial<AppOpenResult> = {}): AppOpenResult {
  return { inactivity_erasure_enabled: true, inactive_after_months: 24, notice_days: 30, notice: null, ...overrides };
}

describe('shouldRecordAppOpen', () => {
  it('records the first open', () => {
    expect(shouldRecordAppOpen(null, NOW)).toBe(true);
  });

  it('waits one hour between calls', () => {
    expect(shouldRecordAppOpen(NOW - 59 * 60 * 1000, NOW)).toBe(false);
    expect(shouldRecordAppOpen(NOW - APP_OPEN_MIN_INTERVAL_MS, NOW)).toBe(true);
    expect(shouldRecordAppOpen(NOW - 5 * 60 * 60 * 1000, NOW)).toBe(true);
  });

  it('is not blocked by a clock that moved backwards', () => {
    expect(shouldRecordAppOpen(NOW + 3 * 60 * 60 * 1000, NOW)).toBe(true);
  });
});

describe('parseAppOpenResult', () => {
  it('accepts a result without and with a notice', () => {
    expect(parseAppOpenResult(result())).not.toBeNull();
    const withNotice = result({ notice: { noticed_at: '2026-11-01T00:00:00Z', erase_after: '2026-12-01T00:00:00Z' } });
    expect(parseAppOpenResult(withNotice)).toEqual(withNotice);
  });

  it('rejects other shapes', () => {
    for (const value of [
      null,
      undefined,
      'x',
      1,
      [],
      {},
      { inactivity_erasure_enabled: 'yes', notice: null },
      { inactivity_erasure_enabled: true },
    ]) {
      expect(parseAppOpenResult(value)).toBeNull();
    }
    expect(
      parseAppOpenResult({ inactivity_erasure_enabled: true, notice: { noticed_at: 'nope', erase_after: 'nope' } }),
    ).toBeNull();
    expect(parseAppOpenResult({ inactivity_erasure_enabled: true, notice: 'x' })).toBeNull();
  });
});

describe('daysUntil', () => {
  it('rounds up to whole days and never goes below zero', () => {
    expect(daysUntil(new Date(NOW + 10 * DAY).toISOString(), NOW)).toBe(10);
    expect(daysUntil(new Date(NOW + 10 * DAY - 1000).toISOString(), NOW)).toBe(10);
    expect(daysUntil(new Date(NOW + 1000).toISOString(), NOW)).toBe(1);
    expect(daysUntil(new Date(NOW - DAY).toISOString(), NOW)).toBe(0);
    expect(daysUntil('garbage', NOW)).toBe(0);
  });
});

describe('inactivityNoticeMessage', () => {
  const notice = (days: number) => ({
    noticed_at: new Date(NOW - DAY).toISOString(),
    erase_after: new Date(NOW + days * DAY).toISOString(),
  });

  it('is null without a pending notice', () => {
    expect(inactivityNoticeMessage(result(), NOW)).toBeNull();
  });

  it('says in how many days the account would have been deleted and that opening the app keeps it', () => {
    expect(inactivityNoticeMessage(result({ notice: notice(12) }), NOW)).toBe(
      'Your account was inactive for a long time and would be deleted in 12 days. Opening the app keeps it.',
    );
    expect(inactivityNoticeMessage(result({ notice: notice(1) }), NOW)).toMatch(/in 1 day\./);
  });

  it('does not show a negative or zero count', () => {
    expect(inactivityNoticeMessage(result({ notice: notice(-2) }), NOW)).toMatch(/deleted soon\./);
  });
});
