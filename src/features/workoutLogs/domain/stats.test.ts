import { describe, expect, it } from 'vitest';

import type { CommunityWorkoutStats, MyWorkoutStats } from '@/lib/database.types';

import { communityStatLines, INSUFFICIENT_COMMUNITY_MESSAGE, personalStatLines } from './stats';

const mine: MyWorkoutStats = {
  community_id: null,
  from: null,
  to: null,
  sessions_logged: 4,
  running_sessions: 2,
  race_sessions: 0,
  strength_sessions: 2,
  total_distance_m: 25_500,
  total_duration_s: 7800,
  average_pace_s_per_km: 306,
  pace_sessions: 2,
  strength_volume_kg: 4200,
  strength_sets: 12,
};

const community: CommunityWorkoutStats = {
  community_id: 'c1',
  window: '30d',
  from: null,
  to: '2026-11-23T00:00:00Z',
  min_contributors: 20,
  insufficient_data: false,
  members_contributing: 10,
  sessions_logged: 25,
  total_distance_km: 120,
  total_duration_minutes: 640,
  average_pace_s_per_km: 330,
};

describe('personal numbers', () => {
  it('lists sessions, distance, time, pace and strength volume', () => {
    const { empty, lines } = personalStatLines(mine);
    expect(empty).toBe(false);
    expect(lines.map((line) => [line.label, line.value])).toEqual([
      ['Sessions logged', '4'],
      ['Total distance', '25.5 km'],
      ['Total time', '2 h 10 min'],
      ['Average pace', '5:06 /km'],
      ['Strength volume', '4200 kg'],
    ]);
  });

  it('shows a dash for what has no value and reports an empty history', () => {
    const lines = personalStatLines({ ...mine, total_distance_m: 0, average_pace_s_per_km: null, strength_volume_kg: 0 }).lines;
    expect(lines.map((line) => line.value)).toEqual(['4', '—', '2 h 10 min', '—', '—']);
    expect(personalStatLines({ ...mine, sessions_logged: 0 })).toEqual({ empty: true, lines: [] });
  });
});

describe('community numbers (approximate)', () => {
  it('every value says "about"', () => {
    const lines = communityStatLines(community);
    expect(lines.map((line) => line.value)).toEqual(['about 10', 'about 25', 'about 120 km', 'about 10 h 40 min', 'about 5:30 /km']);
  });

  it('a metric the server withheld is a dash, never "about null"', () => {
    const lines = communityStatLines({ ...community, total_distance_km: null, average_pace_s_per_km: null });
    expect(lines.map((line) => line.value)).toEqual(['about 10', 'about 25', '—', 'about 10 h 40 min', '—']);
  });

  it('shows no numbers when there is not enough data, with the agreed message', () => {
    const insufficient = { ...community, insufficient_data: true, members_contributing: null, sessions_logged: null };
    expect(communityStatLines(insufficient)).toEqual([]);
    expect(INSUFFICIENT_COMMUNITY_MESSAGE).toBe('Not enough members have logged yet (needs at least 20)');
  });
});
