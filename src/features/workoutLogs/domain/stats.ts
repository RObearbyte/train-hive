/**
 * Display helpers for the workout statistics cards (personal and community). Pure.
 * Community values are APPROXIMATE (rounded by the server): they are always shown as "about ...".
 */
import type { CommunityWorkoutStats, MyWorkoutStats } from '@/lib/database.types';

import { formatDuration, formatKm, formatPace, formatWeight } from './workoutLog';

export const DASH = '—';

export const INSUFFICIENT_COMMUNITY_MESSAGE = 'Not enough members have logged yet (needs at least 20)';

export type StatLine = { key: string; label: string; value: string };

/** Personal numbers. Empty statistics (no log yet) are reported with `empty: true`. */
export function personalStatLines(stats: MyWorkoutStats): { empty: boolean; lines: StatLine[] } {
  if (stats.sessions_logged === 0) return { empty: true, lines: [] };
  const lines: StatLine[] = [
    { key: 'sessions', label: 'Sessions logged', value: String(stats.sessions_logged) },
    {
      key: 'distance',
      label: 'Total distance',
      value: stats.total_distance_m > 0 ? `${formatKm(stats.total_distance_m)} km` : DASH,
    },
    {
      key: 'time',
      label: 'Total time',
      value: stats.total_duration_s > 0 ? formatDuration(stats.total_duration_s) : DASH,
    },
    { key: 'pace', label: 'Average pace', value: formatPace(stats.average_pace_s_per_km) },
    {
      key: 'volume',
      label: 'Strength volume',
      value: stats.strength_volume_kg > 0 ? `${formatWeight(stats.strength_volume_kg)} kg` : DASH,
    },
  ];
  return { empty: false, lines };
}

const approx = (text: string) => `about ${text}`;

/** Community numbers as approximate text; a metric the server withheld is the dash. */
export function communityStatLines(stats: CommunityWorkoutStats): StatLine[] {
  if (stats.insufficient_data) return [];
  const pick = (value: number | null, show: (n: number) => string): string =>
    value === null ? DASH : approx(show(value));
  return [
    { key: 'members', label: 'Members who logged', value: pick(stats.members_contributing, (n) => String(n)) },
    { key: 'sessions', label: 'Sessions logged', value: pick(stats.sessions_logged, (n) => String(n)) },
    { key: 'distance', label: 'Total distance', value: pick(stats.total_distance_km, (n) => `${n} km`) },
    {
      key: 'time',
      label: 'Total time',
      value: pick(stats.total_duration_minutes, (n) => formatDuration(n * 60)),
    },
    { key: 'pace', label: 'Average pace', value: pick(stats.average_pace_s_per_km, (n) => formatPace(n)) },
  ];
}

export const COMMUNITY_NOTE =
  'Rounded totals from members who chose to log workouts. Nobody is named, individual logs are never shown, and nothing appears until at least 20 members have contributed.';
