import { describe, expect, it } from 'vitest';

import { AppError } from '@/lib/errors';

import { mapCreatorError } from './creatorErrors';
import { baselineFrom, hasSettingsChanges, resolveConflict } from './settingsBaseline';

const row = { name: 'Alpha', timezone: 'Europe/Berlin', updated_at: '2026-11-20T10:00:00.123+00:00' };

describe('settings baseline', () => {
  it('is taken from the loaded row, updated_at as the server sent it', () => {
    expect(baselineFrom(row)).toEqual({ updatedAt: row.updated_at, name: 'Alpha', timezone: 'Europe/Berlin' });
  });

  it('has no timestamp when the row carries none', () => {
    expect(baselineFrom({ name: 'A', timezone: 'UTC' }).updatedAt).toBeNull();
  });

  it('detects changes against the baseline only', () => {
    const baseline = baselineFrom(row);
    expect(hasSettingsChanges({ name: 'Alpha', timezone: 'Europe/Berlin' }, baseline)).toBe(false);
    expect(hasSettingsChanges({ name: 'Beta', timezone: 'Europe/Berlin' }, baseline)).toBe(true);
    expect(hasSettingsChanges({ name: 'Alpha', timezone: 'UTC' }, baseline)).toBe(true);
  });

  it('after a conflict the baseline is the latest row and the typed values are kept apart', () => {
    const latest = { name: 'Gamma', timezone: 'UTC', updated_at: '2026-11-20T11:00:00.456+00:00' };
    const result = resolveConflict(latest, { name: 'Beta', timezone: 'Europe/Berlin' });
    expect(result.baseline.updatedAt).toBe(latest.updated_at);
    expect(result.typedDiffers).toBe(true);
    expect(resolveConflict(latest, { name: 'Gamma', timezone: 'UTC' }).typedDiffers).toBe(false);
  });
});

describe('stale_data mapping', () => {
  it('is a warning banner with the friendly text', () => {
    const view = mapCreatorError(new AppError('stale_data'));
    expect(view.target).toBe('banner');
    expect(view.tone).toBe('warning');
    expect(view.message).toBe(
      'Someone else changed these community settings while you were editing. Review the latest values and try again.',
    );
  });
});
