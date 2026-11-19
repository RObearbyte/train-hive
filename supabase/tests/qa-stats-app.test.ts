import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { barsFor, countScale, rateScale } from '@/features/statistics/domain/chart';
import { MEMBER_LIST_NOTE, NOT_RECORDED_NOTE, RATE_NOTE } from '@/features/statistics/domain/copy';
import { formatCount, formatDecimal, formatPercent, ofCount, smallRsvpSampleLabel, smallSampleLabel } from '@/features/statistics/domain/format';
import { axisLabels, parsePeriod } from '@/features/statistics/domain/periods';
import {
  flattenHistory,
  memberLine,
  memberRowLabel,
  monthlySummary,
  outcomeLabel,
  rsvpLabel,
  trendSummary,
  visibleTopSessions,
} from '@/features/statistics/domain/summaries';

import { admin, closeDb, resetData } from './helpers';
import { prng, type Window } from './qa-stats-reference';
import { BASE, buildWorld } from './qa-stats-world';
import { communityStats, history, memberStats, myStats, SeasonBuilder, summary, type History } from './stats-helpers';

/**
 * M4-Q1: the app's presentation code fed with real payloads from the database (no mocks).
 * Everything the screens would print for random seasons must be free of NaN, Infinity, null and
 * undefined; the TypeScript payload types must list exactly the keys the SQL returns; the
 * history pages, flattened the way the hook does, must be the whole list.
 */

beforeEach(resetData);
afterAll(closeDb);

const WINDOWS: Window[] = ['7d', '30d', '90d', 'all'];
const BAD_TEXT = /NaN|Infinity|undefined|null|\[object/;

/** Field names of an exported type in src/lib/database.types.ts (nested one-line fields only). */
function typeKeys(name: string, source = readFileSync(path.resolve(__dirname, '../../src/lib/database.types.ts'), 'utf8')): string[] {
  const start = source.indexOf(`export type ${name} =`);
  if (start < 0) throw new Error(`type ${name} not found`);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?:\/\*\*|export )/);
  const body = rest.slice(0, end < 0 ? undefined : end);
  const keys = new Set<string>();
  for (const m of body.matchAll(/^ {2,4}([a-z_]+)\??:/gm)) keys.add(m[1]);
  return [...keys].sort();
}

const keysOf = (value: object) => Object.keys(value).sort();

describe('payload types match the SQL payloads exactly', () => {
  it('every key the database returns is declared, and every declared key is returned', async () => {
    const season = await SeasonBuilder.create('Europe/Bucharest');
    const org = await season.person({ role: 'organizer', name: 'Org' });
    const m = await season.person({ name: 'Mem' });
    for (let i = 1; i <= 3; i += 1) {
      const s = await season.session({ hoursAgo: i * 24, title: `S${i}` });
      await season.going(s, m, 'present');
      await season.going(s, org, 'present');
    }
    const envelope = typeKeys('StatisticsEnvelope');
    const member = await myStats(m, season.communityId, '30d');
    expect(keysOf(member)).toEqual([...new Set([...envelope, ...typeKeys('MemberStatisticsCounts'), 'timezone', 'community_id', 'user_id', 'membership_status', 'role', 'joined_at', 'monthly'])].sort());
    expect(keysOf(member.monthly[0])).toEqual(typeKeys('MonthlyParticipation'));
    const page = await history(m, season.communityId, '30d', 10);
    expect(keysOf(page)).toEqual([...new Set([...envelope, 'items', 'has_more', 'next_before'])].sort());
    expect(keysOf(page.items[0])).toEqual(typeKeys('AttendanceHistoryItem'));
    const community = await communityStats(org, season.communityId, '30d');
    expect(keysOf(community)).toEqual([...new Set([...envelope, ...typeKeys('CommunityStatistics').filter((k) => !envelope.includes(k))])].sort());
    expect(keysOf(community.trend[0])).toEqual(typeKeys('AttendanceTrendBucket'));
    expect(keysOf(community.top_sessions[0])).toEqual(typeKeys('TopSession'));
    const list = await summary(org, season.communityId, '30d');
    expect(keysOf(list)).toEqual([...new Set([...envelope, 'community_id', 'total_members', 'truncated', 'members'])].sort());
    expect(keysOf(list.members[0])).toEqual([...new Set([...typeKeys('MemberStatisticsCounts'), 'user_id', 'display_name', 'role', 'joined_at'])].sort().filter((k) => k !== 'recorded'));
    expect(keysOf(await memberStats(org, season.communityId, m, '30d'))).toEqual(keysOf(member));
  });
});

describe('what the screens print, from real data', () => {
  it('no text derived from a real payload contains NaN, Infinity, null or undefined; buckets and labels line up', async () => {
    const bad: string[] = [];
    const check = (where: string, text: string) => {
      if (BAD_TEXT.test(text) || text.trim() === '') bad.push(`${where}: "${text}"`);
    };
    for (let seed = 201; seed <= 212; seed += 1) {
      await resetData();
      const world = await buildWorld(seed, Date.now() - 3000, false);
      const c = world.season.communityId;
      for (const w of WINDOWS) {
        const label = `seed ${seed} ${w}`;
        const stats = await communityStats(world.organizer.id, c, w);
        const unit = stats.trend_unit;
        const averages = stats.trend.map((b) => b.average_attendees);
        check(`${label} trend`, trendSummary(stats.trend, unit));
        const labels = axisLabels(stats.trend.map((b) => b.period), unit);
        if (labels.length !== stats.trend.length) bad.push(`${label}: axis labels ${labels.length} vs buckets ${stats.trend.length}`);
        for (const [i, b] of stats.trend.entries()) {
          if (parsePeriod(b.period) === null) bad.push(`${label}: period ${b.period} not parseable`);
          if (unit === 'month' && parsePeriod(b.period)?.day !== null) bad.push(`${label}: month period with a day`);
          if (unit === 'week' && parsePeriod(b.period)?.day === null) bad.push(`${label}: week period without a day`);
          check(`${label} axis ${i}`, labels[i]);
        }
        const scale = countScale(averages);
        for (const bar of barsFor(averages, scale)) {
          if (bar.ratio < 0 || bar.ratio > 1 || Number.isNaN(bar.ratio)) bad.push(`${label}: bar ratio ${bar.ratio}`);
        }
        for (const text of [formatCount(stats.completed_trainings), formatCount(stats.total_attendances), formatDecimal(stats.average_attendees), formatDecimal(stats.average_rsvp_participation), formatPercent(stats.rsvp_conversion), formatCount(stats.active_members), formatCount(stats.members_attended), formatCount(stats.cancelled_insufficient_participation), formatCount(stats.cancelled_by_organizer)]) {
          check(`${label} overview`, text);
        }
        for (const t of visibleTopSessions(stats.top_sessions)) if (t.present <= 0) bad.push(`${label}: a top session with nobody present is shown`);
        if (stats.rsvp_going_recorded > 0) check(`${label} conversion`, ofCount(stats.rsvp_going_present, stats.rsvp_going_recorded, 'recorded going RSVPs'));

        const list = await summary(world.organizer.id, c, w);
        for (const row of list.members) {
          check(`${label} row`, memberRowLabel(row));
          check(`${label} line`, memberLine(row));
          const sample = smallSampleLabel(row.eligible);
          if (row.eligible >= 1 && row.eligible < 3 && !sample) bad.push(`${label}: no small-sample label for ${row.eligible}`);
          if (row.eligible >= 3 && sample) bad.push(`${label}: small-sample label for ${row.eligible}`);
        }

        for (const person of world.model.people.filter((p) => p.status === 'active').slice(0, 4)) {
          const mine = await myStats(person.id, c, w);
          check(`${label} monthly`, monthlySummary(mine.monthly));
          check(`${label} rate`, formatPercent(mine.attendance_rate));
          check(`${label} reliability`, formatPercent(mine.rsvp_reliability));
          check(`${label} detail`, ofCount(mine.attended, mine.eligible));
          const months = axisLabels(mine.monthly.map((m) => m.period), 'month');
          if (months.length !== mine.monthly.length) bad.push(`${label}: monthly labels`);
          const rates = mine.monthly.map((m) => (m.eligible > 0 ? m.attendance_rate : null));
          for (const bar of barsFor(rates, rateScale())) if (bar.ratio < 0 || bar.ratio > 1) bad.push(`${label}: rate bar ${bar.ratio}`);

          // History: pages of 20 as the hook loads them, flattened like the hook does.
          const pages: History[] = [];
          let before: string | null = null;
          for (let guard = 0; guard < 20; guard += 1) {
            const page: History = await history(person.id, c, w, 20, before);
            pages.push(page);
            if (!page.has_more) break;
            before = page.next_before;
          }
          const flat = flattenHistory(pages);
          if (flat.length !== mine.eligible) bad.push(`${label}: history has ${flat.length} items, statistics say ${mine.eligible}`);
          if (pages.reduce((n, p) => n + p.items.length, 0) !== flat.length) bad.push(`${label}: flattenHistory dropped items`);
          if (flat.filter((i) => i.outcome === 'present').length !== mine.attended) bad.push(`${label}: history present count differs`);
          if (flat.filter((i) => i.outcome === 'absent').length !== mine.absent) bad.push(`${label}: history absent count differs`);
          for (const item of flat) {
            check(`${label} outcome`, outcomeLabel(item.outcome));
            if (item.rsvp_response !== 'no_response' && rsvpLabel(item.rsvp_response) === null) bad.push(`${label}: rsvp label missing`);
          }
        }
      }
    }
    expect(bad.slice(0, 20)).toEqual([]);
  }, 300_000);

  it('a real not recorded outcome is labelled "Not recorded", never styled as an absence', async () => {
    const season = await SeasonBuilder.create('UTC');
    const m = await season.person({ joinedAt: '2020-01-01T00:00:00Z' });
    const s1 = await season.session({ hoursAgo: 10 });
    const s2 = await season.session({ hoursAgo: 20 });
    await season.going(s1, m, 'unrecorded');
    await season.rsvp(s2, m, 'going');
    const page = await history(m, season.communityId, '7d', 10);
    expect(page.items.map((i) => outcomeLabel(i.outcome))).toEqual(['Not recorded', 'Not recorded']);
  });
});

describe('copy against the definitions', () => {
  it('the rate note names the denominator: every finalized eligible event', () => {
    // "Event" is the app's vocabulary since P1 (a training is one kind of event).
    expect(RATE_NOTE).toMatch(/all finalized events/i);
  });

  // Q5-1 (resolved by owner decision D2): the attendance rate keeps Not recorded trainings in the
  // denominator (spec formula: attended / eligible), so the copy must say exactly that instead of
  // promising the rate ignores them.
  it('Q5-1 resolved: the copy says Not recorded is not an absence but is included in the rate', async () => {
    expect(NOT_RECORDED_NOTE).toMatch(/not counted as an absence/);
    expect(NOT_RECORDED_NOTE).toMatch(/included when the rate is calculated/);
    expect(MEMBER_LIST_NOTE).toMatch(/included in that total/);
    const season = await SeasonBuilder.create('UTC');
    const marked = await season.person({ joinedAt: '2020-01-01T00:00:00Z' });
    const s1 = await season.session({ hoursAgo: 10 });
    const s2 = await season.session({ hoursAgo: 20 });
    await season.going(s1, marked, 'present');
    await season.going(s2, marked, 'unrecorded');
    const stats = await myStats(marked, season.communityId, '7d');
    expect(stats.absent).toBe(0);
    expect(stats.not_recorded).toBe(1);
    expect(stats.attendance_rate).toBe(50);
  });

  // Q5-2 (fixed): the community card "RSVP to attendance" counts going RSVPs (people), so its small-sample label says RSVPs.
  it('Q5-2 fixed: the small-sample label of the community conversion names RSVPs, not trainings', async () => {
    const season = await SeasonBuilder.create('UTC');
    const org = await season.person({ role: 'organizer' });
    const other = await season.person({ name: 'Other Runner' });
    const s = await season.session({ hoursAgo: 10 });
    await season.going(s, org, 'present');
    await season.going(s, other, 'present');
    const stats = await communityStats(org, season.communityId, '7d');
    expect(stats).toMatchObject({ completed_trainings: 1, rsvp_going_recorded: 2 });
    expect(smallRsvpSampleLabel(stats.rsvp_going_recorded)).toBe('based on 2 RSVPs');
  });

  // Q5-4 (fixed by get_member_attendance_history, stats-member-history.test.ts): STATS_DEFINITIONS (member statistics, "Historical attendance") makes the history of a member
  // visible to that member AND to organizers, but the only history function is get_my_attendance_history
  // (own identity). The organizer's member screen has no history (MemberDetailScreen.tsx header comment).
  it('Q5-4 fixed: an organizer can read the attendance history of a member', async () => {
    const { rows } = await admin.query<{ name: string }>(
      "select proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname like '%attendance_history%' and proname = 'get_member_attendance_history'",
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  // Q5-5 (fixed: the type omits `recorded`): MemberStatisticsSummaryRow (database.types.ts) inherits `recorded` from MemberStatisticsCounts,
  // but list_member_statistics_summary lines do not carry it (the contract lists none). A reader of the type gets undefined
  // typed as number. The app does not read it today.
  it('Q5-5 fixed: the summary row type declares only keys the SQL returns', async () => {
    const season = await SeasonBuilder.create('UTC');
    const org = await season.person({ role: 'organizer' });
    const list = await summary(org, season.communityId, '30d');
    const declared = [...new Set([...typeKeys('MemberStatisticsCounts'), ...typeKeys('MemberStatisticsSummaryRow')])].filter((k) => k !== 'recorded').sort();
    const source = readFileSync(path.resolve(__dirname, '../../src/lib/database.types.ts'), 'utf8');
    expect(source).toMatch(/export type MemberStatisticsSummaryRow = Omit<MemberStatisticsCounts, 'recorded'>/);
    expect(keysOf(list.members[0])).toEqual(declared);
  });

  it('every period the server can send has a spoken label (no raw period string leaks into speech)', async () => {
    const season = await SeasonBuilder.create('Pacific/Auckland');
    const org = await season.person({ role: 'organizer' });
    await season.session({ at: new Date(BASE - 3 * 86_400_000).toISOString() });
    const stats = await communityStats(org, season.communityId, 'all');
    const text = trendSummary(stats.trend, stats.trend_unit);
    for (const b of stats.trend) expect(text).not.toContain(b.period);
  });
});

describe('seeded fuzz of the formatters with hostile numbers', () => {
  it('nothing prints NaN, Infinity or undefined for any numeric input, however odd', () => {
    const rand = prng(99);
    const odd = [Number.NaN, Infinity, -Infinity, -0, -1, 0.04, 0.05, 99.95, 100.04, 1e15, 1e-9, Number.MIN_VALUE, null, undefined];
    for (let i = 0; i < 400; i += 1) odd.push((rand() - 0.2) * 10 ** Math.floor(rand() * 8));
    for (const v of odd) {
      for (const text of [formatPercent(v as number), formatDecimal(v as number), formatCount(v as number)]) {
        expect(text, String(v)).not.toMatch(BAD_TEXT);
        expect(text.length).toBeGreaterThan(0);
      }
    }
    expect(formatCount(-3)).toBe('0');
    expect(formatPercent(99.95)).toBe('100%');
  });
});
