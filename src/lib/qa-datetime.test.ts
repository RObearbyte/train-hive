/**
 * QA (M1-Q1 part 2): timezone sweeps beyond the developers' tests. Real
 * Intl data, no mocks. Every transition found in 2026 for a set of awkward
 * zones is walked in 15-minute steps; wall -> instant -> wall must be stable,
 * and relative day labels must flip exactly at the SESSION zone's midnight.
 */
import { tzOffset } from '@date-fns/tz';
import { describe, expect, it } from 'vitest';

import {
  calendarDaysFromNow,
  formatSessionWhen,
  relativeDayLabel,
  utcToWallTime,
  wallTimeToUtc,
} from '@/lib/datetime';

const ZONES = [
  'Europe/Bucharest',
  'America/New_York',
  'America/St_Johns',
  'Australia/Lord_Howe', // 30-minute DST shift
  'Pacific/Chatham', // +12:45 / +13:45
  'Asia/Kathmandu', // +5:45
  'Asia/Kolkata',
  'Africa/Casablanca', // negative DST during Ramadan
  'America/Sao_Paulo',
  'Pacific/Kiritimati', // +14
  'Pacific/Pago_Pago', // -11
  'UTC',
];

/** Instants in 2026 where the zone's offset differs from the previous day. */
function transitionsIn2026(zone: string): number[] {
  const out: number[] = [];
  const day = 86_400_000;
  let previous = tzOffset(zone, new Date('2025-12-31T00:00:00Z'));
  for (let t = new Date('2026-01-01T00:00:00Z').getTime(); t < new Date('2027-01-01T00:00:00Z').getTime(); t += day) {
    const offset = tzOffset(zone, new Date(t));
    if (offset !== previous) out.push(t);
    previous = offset;
  }
  return out;
}

describe('wall time -> instant -> wall time is stable around every 2026 transition', () => {
  it.each(ZONES)('%s', (zone) => {
    const problems: string[] = [];
    for (const day of transitionsIn2026(zone)) {
      for (let t = day - 36 * 3_600_000; t <= day + 12 * 3_600_000; t += 15 * 60_000) {
        const wall = utcToWallTime(new Date(t), zone);
        const back = utcToWallTime(wallTimeToUtc(wall.date, wall.time, zone), zone);
        if (back.date !== wall.date || back.time !== wall.time) {
          problems.push(`${new Date(t).toISOString()} shows ${wall.date} ${wall.time}, converts back to ${back.date} ${back.time}`);
        }
        // The first occurrence of a repeated time is chosen: never later than the instant shown.
        if (new Date(wallTimeToUtc(wall.date, wall.time, zone)).getTime() > t) {
          problems.push(`${new Date(t).toISOString()}: converted instant is later than the original`);
        }
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it('finds transitions for the DST zones (the sweep is not vacuous)', () => {
    expect(transitionsIn2026('Europe/Bucharest')).toHaveLength(2);
    expect(transitionsIn2026('Australia/Lord_Howe')).toHaveLength(2);
    expect(transitionsIn2026('Asia/Kolkata')).toHaveLength(0);
  });
});

describe('Today / Tomorrow are decided in the session zone at its midnight', () => {
  it.each(ZONES)('%s flips at local midnight, to the millisecond', (zone) => {
    // Local midnight that begins 2026-06-15 in this zone.
    const midnight = new Date(wallTimeToUtc('2026-06-15', '00:00', zone)).getTime();
    const session = new Date(midnight + 9 * 3_600_000); // 09:00 on the 15th, local (June: no transitions)
    const justBefore = new Date(midnight - 1);
    const atMidnight = new Date(midnight);
    expect(relativeDayLabel(session, zone, justBefore)).toBe('Tomorrow');
    expect(relativeDayLabel(session, zone, atMidnight)).toBe('Today');
    expect(relativeDayLabel(session, zone, new Date(midnight + 24 * 3_600_000 - 1))).toBe('Today');
    expect(relativeDayLabel(session, zone, new Date(midnight + 24 * 3_600_000))).toBe('Yesterday');
  });

  it('on the 23-hour and 25-hour days the label still changes once per calendar day', () => {
    const zone = 'Europe/Bucharest';
    for (const date of ['2026-03-29', '2026-10-25']) {
      const labels: string[] = [];
      const session = new Date(wallTimeToUtc(date, '20:00', zone));
      const start = new Date(wallTimeToUtc(date, '00:00', zone)).getTime() - 3_600_000;
      for (let t = start; t < start + 28 * 3_600_000; t += 15 * 60_000) {
        const label = relativeDayLabel(session, zone, new Date(t)) ?? 'other';
        if (labels[labels.length - 1] !== label) labels.push(label);
      }
      expect(labels, date).toEqual(['Tomorrow', 'Today', 'Yesterday']);
    }
  });

  it('a phone in another zone sees the session zone label, not its own', () => {
    // 23:30 on 14 Nov in Bucharest is 21:30 UTC, 16:30 in New York, 08:30 on the 15th in Auckland.
    const session = new Date('2026-11-14T21:30:00Z');
    const now = new Date('2026-11-14T10:00:00Z'); // noon on the 14th in Bucharest
    expect(formatSessionWhen(session, 'Europe/Bucharest', now)).toBe('Today, 23:30');
    expect(calendarDaysFromNow(session, 'Pacific/Auckland', now)).toBe(1); // read in Auckland instead
  });
});
