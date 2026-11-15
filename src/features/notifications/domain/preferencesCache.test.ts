import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { activityKeys } from '../api/keys';
import {
  DEFAULT_PREFS,
  applyOptimisticPrefs,
  rollbackPrefs,
  type NotificationPrefs,
} from './preferencesCache';

const KEY = activityKeys.preferences('me');

function setup(prefs: NotificationPrefs = DEFAULT_PREFS) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(KEY, prefs);
  return queryClient;
}
const read = (qc: QueryClient) => qc.getQueryData<NotificationPrefs>(KEY)!;

describe('optimistic preferences', () => {
  it('shows the change at once and rolls it back on error', () => {
    const qc = setup();
    const snapshot = applyOptimisticPrefs(qc, 'me', { announcements: false });
    expect(read(qc).announcements).toBe(false);
    rollbackPrefs(qc, snapshot);
    expect(read(qc)).toEqual(DEFAULT_PREFS);
  });

  it('rolls back only its own field when two toggles overlap', () => {
    const qc = setup();
    const first = applyOptimisticPrefs(qc, 'me', { announcements: false });
    applyOptimisticPrefs(qc, 'me', { training_reminders: false });
    rollbackPrefs(qc, first);
    expect(read(qc)).toEqual({ ...DEFAULT_PREFS, training_reminders: false });
  });

  it('does not undo a value a refetch has since set', () => {
    const qc = setup();
    const snapshot = applyOptimisticPrefs(qc, 'me', { push_enabled: false });
    qc.setQueryData(KEY, { ...DEFAULT_PREFS, push_enabled: true });
    rollbackPrefs(qc, snapshot);
    expect(read(qc).push_enabled).toBe(true);
  });

  it('is a no-op without cached preferences', () => {
    const qc = new QueryClient();
    const snapshot = applyOptimisticPrefs(qc, 'me', { push_enabled: false });
    expect(qc.getQueryData(KEY)).toBeUndefined();
    rollbackPrefs(qc, snapshot);
    expect(qc.getQueryData(KEY)).toBeUndefined();
  });
});
