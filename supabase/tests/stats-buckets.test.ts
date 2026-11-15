import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, resetData } from './helpers';
import { communityPayloadAt, memberPayloadAt, SeasonBuilder } from './stats-helpers';

/**
 * M4-B1: window edges and calendar buckets. The private payload builders take the clock as a
 * parameter (the public RPCs pass now()), so these tests pin it to fixed instants and check
 * exact edges, DST changes and the year boundary in the community's time zone.
 */

beforeEach(resetData);
afterAll(closeDb);

const iso = (value: string) => new Date(value).toISOString();
const plus = (at: string, ms: number) => new Date(new Date(at).getTime() + ms).toISOString();
const HOUR = 3_600_000;

describe('window edges (starts_at in [now - N x 24 h, now], both ends inclusive)', () => {
  it('includes a session exactly at either edge and excludes it one millisecond outside', async () => {
    const season = await SeasonBuilder.create('UTC');
    const M = await season.person({ joinedAt: '2025-01-01T00:00:00Z' });
    const at = '2025-06-15T10:00:00.000Z';
    const s = await season.session({ at });
    await season.going(s, M, 'present');

    for (const [window, hours] of [['7d', 168], ['30d', 720], ['90d', 2160]] as const) {
      expect((await memberPayloadAt(season.communityId, M, window, plus(at, hours * HOUR))).eligible, window).toBe(1);
      expect((await memberPayloadAt(season.communityId, M, window, plus(at, hours * HOUR + 1))).eligible, window).toBe(0);
      expect((await memberPayloadAt(season.communityId, M, window, at)).eligible, window).toBe(1);
      expect((await memberPayloadAt(season.communityId, M, window, plus(at, -1))).eligible, window).toBe(0);
      const community = await communityPayloadAt(season.communityId, window, plus(at, hours * HOUR));
      expect(community.completed_trainings, window).toBe(1);
      expect(iso(community.from!)).toBe(at);
    }
    expect((await memberPayloadAt(season.communityId, M, 'all', '2030-01-01T00:00:00Z')).eligible).toBe(1);
  });

  it('a membership that starts exactly at the session start is eligible; one millisecond later is not', async () => {
    const season = await SeasonBuilder.create('UTC');
    const at = '2025-06-15T10:00:00.000Z';
    const onTime = await season.person({ joinedAt: at });
    const late = await season.person({ joinedAt: plus(at, 1) });
    await season.session({ at });
    expect((await memberPayloadAt(season.communityId, onTime, 'all', '2025-07-01T00:00:00Z')).eligible).toBe(1);
    expect((await memberPayloadAt(season.communityId, late, 'all', '2025-07-01T00:00:00Z')).eligible).toBe(0);
  });
});

describe('monthly buckets in the community time zone', () => {
  it('Europe/Bucharest: both DST changes and the year boundary, empty months listed', async () => {
    const season = await SeasonBuilder.create('Europe/Bucharest');
    const M = await season.person({ joinedAt: '2025-01-01T00:00:00Z' });
    // Local times in the comments. DST 2025: starts 30 March, ends 26 October.
    const sessions = [
      '2025-03-31T20:30:00Z', // 31 Mar 23:30 EEST -> 2025-03
      '2025-03-31T21:30:00Z', //  1 Apr 00:30 EEST -> 2025-04
      '2025-10-31T21:30:00Z', // 31 Oct 23:30 EET  -> 2025-10
      '2025-10-31T22:30:00Z', //  1 Nov 00:30 EET  -> 2025-11
      '2025-12-31T21:30:00Z', // 31 Dec 23:30 EET  -> 2025-12
      '2025-12-31T22:30:00Z', //  1 Jan 00:30 EET  -> 2026-01
    ];
    for (const [i, at] of sessions.entries()) {
      const s = await season.session({ at });
      await season.going(s, M, i % 2 === 0 ? 'present' : 'absent');
    }
    const now = '2026-02-15T12:00:00Z';
    const stats = await memberPayloadAt(season.communityId, M, 'all', now);
    // From the month of the earliest session to the month of now.
    expect(stats.monthly.map((m) => m.period)).toEqual([
      '2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10',
      '2025-11', '2025-12', '2026-01', '2026-02',
    ]);
    const byPeriod = Object.fromEntries(stats.monthly.map((m) => [m.period, m]));
    expect(byPeriod['2025-03']).toMatchObject({ eligible: 1, attended: 1, attendance_rate: 100 });
    expect(byPeriod['2025-04']).toMatchObject({ eligible: 1, attended: 0, attendance_rate: 0 });
    expect(byPeriod['2025-05']).toMatchObject({ eligible: 0, attended: 0, attendance_rate: null });
    expect(byPeriod['2025-10']).toMatchObject({ eligible: 1, attended: 1 });
    expect(byPeriod['2025-11']).toMatchObject({ eligible: 1, attended: 0 });
    expect(byPeriod['2025-12']).toMatchObject({ eligible: 1, attended: 1 });
    expect(byPeriod['2026-01']).toMatchObject({ eligible: 1, attended: 0 });
    expect(byPeriod['2026-02']).toMatchObject({ eligible: 0, attendance_rate: null });
    // Bucket instants follow the offset in force at each local midnight.
    expect([iso(byPeriod['2025-03'].from), iso(byPeriod['2025-03'].to)]).toEqual(['2025-02-28T22:00:00.000Z', '2025-03-31T21:00:00.000Z']);
    expect([iso(byPeriod['2025-10'].from), iso(byPeriod['2025-10'].to)]).toEqual(['2025-09-30T21:00:00.000Z', '2025-10-31T22:00:00.000Z']);
    expect(iso(byPeriod['2026-01'].from)).toBe('2025-12-31T22:00:00.000Z');

    const community = await communityPayloadAt(season.communityId, 'all', now);
    expect(community.trend_unit).toBe('month');
    expect(community.trend.map((b) => [b.period, b.sessions])).toEqual(
      stats.monthly.map((m) => [m.period, m.eligible]),
    );
    expect(community.trend.find((b) => b.period === '2025-05')).toMatchObject({ sessions: 0, present: 0, average_attendees: null });
    // 90 days back from now: from mid-November, so November to February.
    const ninety = await communityPayloadAt(season.communityId, '90d', now);
    expect(ninety.trend.map((b) => [b.period, b.sessions])).toEqual([
      ['2025-11', 0], ['2025-12', 1], ['2026-01', 1], ['2026-02', 0],
    ]);
  });

  it('America/New_York: the year boundary falls on the local date, not the UTC one', async () => {
    const season = await SeasonBuilder.create('America/New_York');
    const M = await season.person({ joinedAt: '2025-01-01T00:00:00Z' });
    await season.going(await season.session({ at: '2026-01-01T03:00:00Z' }), M, 'present'); // 31 Dec 22:00 EST
    await season.going(await season.session({ at: '2026-01-01T05:30:00Z' }), M, 'absent'); //   1 Jan 00:30 EST
    const stats = await memberPayloadAt(season.communityId, M, 'all', '2026-01-20T12:00:00Z');
    expect(stats.monthly.map((m) => [m.period, m.eligible, m.attended])).toEqual([
      ['2025-12', 1, 1],
      ['2026-01', 1, 0],
    ]);
    expect(iso(stats.monthly[0].from)).toBe('2025-12-01T05:00:00.000Z');
    expect(iso(stats.monthly[1].from)).toBe('2026-01-01T05:00:00.000Z');
    expect(stats.timezone).toBe('America/New_York');
  });
});

describe('weekly buckets (Monday-based) in the community time zone', () => {
  it('Europe/Bucharest: the week of the DST end is 169 hours long and keeps Sunday night', async () => {
    const season = await SeasonBuilder.create('Europe/Bucharest');
    const M = await season.person({ joinedAt: '2025-01-01T00:00:00Z' });
    await season.going(await season.session({ at: '2025-10-26T21:30:00Z' }), M, 'present'); // Sun 26 Oct 23:30 EET
    await season.going(await season.session({ at: '2025-10-26T22:30:00Z' }), M, 'present'); // Mon 27 Oct 00:30 EET
    const stats = await communityPayloadAt(season.communityId, '30d', '2025-11-05T12:00:00Z');
    expect(stats.trend_unit).toBe('week');
    expect(stats.trend.map((b) => [b.period, b.sessions, b.present])).toEqual([
      ['2025-10-06', 0, 0],
      ['2025-10-13', 0, 0],
      ['2025-10-20', 1, 1],
      ['2025-10-27', 1, 1],
      ['2025-11-03', 0, 0],
    ]);
    const dstWeek = stats.trend[2];
    expect([iso(dstWeek.from), iso(dstWeek.to)]).toEqual(['2025-10-19T21:00:00.000Z', '2025-10-26T22:00:00.000Z']);
    expect(new Date(dstWeek.to).getTime() - new Date(dstWeek.from).getTime()).toBe(169 * HOUR);
    expect(stats.trend[0].average_attendees).toBeNull();
    expect(dstWeek.average_attendees).toBe(1);
  });

  it('America/New_York: weeks around the November DST change', async () => {
    const season = await SeasonBuilder.create('America/New_York');
    const M = await season.person({ joinedAt: '2025-01-01T00:00:00Z' });
    await season.going(await season.session({ at: '2025-11-03T04:30:00Z' }), M, 'present'); // Sun 2 Nov 23:30 EST
    await season.going(await season.session({ at: '2025-11-03T05:30:00Z' }), M, 'unrecorded'); // Mon 3 Nov 00:30 EST
    const stats = await communityPayloadAt(season.communityId, '30d', '2025-11-12T12:00:00Z');
    expect(stats.trend.map((b) => [b.period, b.sessions, b.present, b.incomplete_sessions])).toEqual([
      ['2025-10-13', 0, 0, 0],
      ['2025-10-20', 0, 0, 0],
      ['2025-10-27', 1, 1, 0],
      ['2025-11-03', 1, 0, 1],
      ['2025-11-10', 0, 0, 0],
    ]);
    expect([iso(stats.trend[2].from), iso(stats.trend[2].to)]).toEqual(['2025-10-27T04:00:00.000Z', '2025-11-03T05:00:00.000Z']);
    // The only session of that week was never marked: excluded from its average.
    expect(stats.trend[3].average_attendees).toBeNull();
    const week = await communityPayloadAt(season.communityId, '7d', '2025-11-05T12:00:00Z');
    expect(week.trend.map((b) => b.period)).toEqual(['2025-10-27', '2025-11-03']);
  });
});
