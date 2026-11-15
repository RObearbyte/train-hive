import type { StatisticsWindow } from '@/lib/database.types';

export const DEFAULT_WINDOW: StatisticsWindow = '30d';

export const WINDOW_OPTIONS: readonly {
  value: StatisticsWindow;
  label: string;
  accessibilityLabel: string;
}[] = [
  { value: '7d', label: '7 days', accessibilityLabel: 'Last 7 days' },
  { value: '30d', label: '30 days', accessibilityLabel: 'Last 30 days' },
  { value: '90d', label: '90 days', accessibilityLabel: 'Last 90 days' },
  { value: 'all', label: 'All time', accessibilityLabel: 'All time' },
];

export function isStatisticsWindow(value: unknown): value is StatisticsWindow {
  return value === '7d' || value === '30d' || value === '90d' || value === 'all';
}

/** "the last 30 days" / "all time", for sentences. */
export function windowPhrase(window: StatisticsWindow): string {
  switch (window) {
    case '7d':
      return 'the last 7 days';
    case '30d':
      return 'the last 30 days';
    case '90d':
      return 'the last 90 days';
    case 'all':
      return 'all time';
  }
}

/**
 * The selected filter, remembered while the app runs (switching tabs or
 * opening a member keeps it). Deliberately in memory only.
 */
export type WindowStore = {
  get: () => StatisticsWindow;
  set: (value: StatisticsWindow) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createWindowStore(initial: StatisticsWindow = DEFAULT_WINDOW): WindowStore {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (value) => {
      if (!isStatisticsWindow(value) || value === current) return;
      current = value;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const windowStore = createWindowStore();
