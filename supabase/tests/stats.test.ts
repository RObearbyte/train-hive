import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { recordAttendance, finalizeAttendance, confirmedSession } from './attendance-helpers';
import { admin, closeDb, resetData } from './helpers';
import {
  communityStats,
  history,
  memberStats,
  myStats,
  referenceSeason,
  SeasonBuilder,
  summary,
  type MemberStats,
} from './stats-helpers';

/**
 * M4-B1: the statistics functions against docs/STATS_DEFINITIONS.md, on the reference season of
 * stats-helpers.ts (expected numbers derived by hand in the comments).
 */

beforeEach(resetData);
afterAll(closeDb);

const COUNTS = [
  'eligible',
  'attended',
  'absent',
  'not_recorded',
  'recorded',
  'attendance_rate',
  'confirmed_rsvps',
  'missed',
  'rsvp_going_present',
  'rsvp_going_recorded',
  'rsvp_reliability',
  'walk_ins',
] as const;

function counts(stats: MemberStats): Record<(typeof COUNTS)[number], number | null> {
  return Object.fromEntries(COUNTS.map((key) => [key, stats[key]])) as Record<(typeof COUNTS)[number], number | null>;
}

describe('member statistics (reference season, 30 days: S1, S2, S8, S3)', () => {
  it('computes every member metric exactly as defined', async () => {
    const { communityId, people } = await referenceSeason();
    const { O, A, B, W, L, N } = people;

    // A: S1 present, S2 present, S8 no RSVP / no record, S3 present.
    expect(counts(await myStats(A, communityId))).toEqual({
      eligible: 4, attended: 3, absent: 0, not_recorded: 1, recorded: 3, attendance_rate: 75,
      confirmed_rsvps: 3, missed: 0, rsvp_going_present: 3, rsvp_going_recorded: 3, rsvp_reliability: 100,
      walk_ins: 0,
    });
    // B: going everywhere; S1 absent, S2 unrecorded row, S8 unrecorded row, S3 absent.
    // Unrecorded is neither absent nor a miss, and stays out of the reliability denominator.
    expect(counts(await myStats(B, communityId))).toEqual({
      eligible: 4, attended: 0, absent: 2, not_recorded: 2, recorded: 2, attendance_rate: 0,
      confirmed_rsvps: 4, missed: 2, rsvp_going_present: 0, rsvp_going_recorded: 2, rsvp_reliability: 0,
      walk_ins: 0,
    });
    // W: two walk-ins (attended, not RSVP successes), S2 not_going without a record, S8 nothing.
    expect(counts(await myStats(W, communityId))).toEqual({
      eligible: 4, attended: 2, absent: 0, not_recorded: 2, recorded: 2, attendance_rate: 50,
      confirmed_rsvps: 0, missed: 0, rsvp_going_present: 0, rsvp_going_recorded: 0, rsvp_reliability: null,
      walk_ins: 2,
    });
    // L joined 10 days ago: only S3 (5 days ago) is in E.
    expect(counts(await myStats(L, communityId))).toEqual({
      eligible: 1, attended: 1, absent: 0, not_recorded: 0, recorded: 1, attendance_rate: 100,
      confirmed_rsvps: 1, missed: 0, rsvp_going_present: 1, rsvp_going_recorded: 1, rsvp_reliability: 100,
      walk_ins: 0,
    });
    // N joined one hour after S3 started and was added as a walk-in: S3 is not in N's E.
    expect(counts(await myStats(N, communityId))).toEqual({
      eligible: 0, attended: 0, absent: 0, not_recorded: 0, recorded: 0, attendance_rate: null,
      confirmed_rsvps: 0, missed: 0, rsvp_going_present: 0, rsvp_going_recorded: 0, rsvp_reliability: null,
      walk_ins: 0,
    });
    // The organizer is a member too: S1 going present.
    expect(counts(await myStats(O, communityId))).toMatchObject({ eligible: 4, attended: 1, attendance_rate: 25, rsvp_reliability: 100 });
  });

  it('cancelled and non-finalized sessions never count; windows use starts_at', async () => {
    const { communityId, people } = await referenceSeason();
    // 7 days: S3 only (S4/S5 cancelled, S6 confirmed but not finalized are all excluded).
    expect(counts(await myStats(people.A, communityId, '7d'))).toMatchObject({ eligible: 1, attended: 1, confirmed_rsvps: 1 });
    // 90 days and all time add S7 (40 days ago).
    for (const window of ['90d', 'all'] as const) {
      expect(counts(await myStats(people.A, communityId, window))).toMatchObject({ eligible: 5, attended: 4, attendance_rate: 80 });
      // B: S7 present, so 1 of 5 attended and 1 of 3 recorded going RSVPs: 33.3.
      expect(counts(await myStats(people.B, communityId, window))).toMatchObject({
        eligible: 5, attended: 1, absent: 2, not_recorded: 2, attendance_rate: 20, rsvp_reliability: 33.3, missed: 2,
      });
    }
  });

  it('returns the documented envelope and monthly participation inside the window', async () => {
    const { communityId, people } = await referenceSeason();
    const stats = await myStats(people.A, communityId, '30d');
    expect(stats).toMatchObject({
      window: '30d', timezone: 'Europe/Bucharest', community_id: communityId, user_id: people.A,
      membership_status: 'active', role: 'member',
    });
    const { rows } = await admin.query<{ t: Date }>('select now() as t');
    // `to` is the server's now() of the call; `from` exactly 720 hours before it.
    expect(new Date(stats.to).getTime() - new Date(stats.from!).getTime()).toBe(720 * 3_600_000);
    expect(new Date(stats.to).getTime()).toBeLessThanOrEqual(rows[0].t.getTime());
    expect(stats.generated_at).toBeTruthy();

    // Months of the window in Bucharest, contiguous, empty months listed (not omitted).
    expect(stats.monthly.length).toBeGreaterThanOrEqual(1);
    expect(stats.monthly.reduce((n, m) => n + m.eligible, 0)).toBe(stats.eligible);
    expect(stats.monthly.reduce((n, m) => n + m.attended, 0)).toBe(stats.attended);
    for (let i = 1; i < stats.monthly.length; i += 1) {
      expect(stats.monthly[i].from).toBe(stats.monthly[i - 1].to);
    }
    for (const month of stats.monthly) {
      expect(month.period).toMatch(/^\d{4}-\d{2}$/);
      if (month.eligible === 0) expect(month.attendance_rate).toBeNull();
    }
    const { rows: local } = await admin.query<{ first: string; last: string }>(
      `select to_char((now() - interval '720 hours') at time zone 'Europe/Bucharest', 'YYYY-MM') as first,
              to_char(now() at time zone 'Europe/Bucharest', 'YYYY-MM') as last`,
    );
    expect(stats.monthly[0].period).toBe(local[0].first);
    expect(stats.monthly.at(-1)!.period).toBe(local[0].last);

    // 'all' has no lower bound.
    const all = await myStats(people.A, communityId, 'all');
    expect(all.from).toBeNull();
  });

  it('a removed member keeps a history organizers can read, but no own access', async () => {
    const { communityId, people } = await referenceSeason();
    const removed = await memberStats(people.O, communityId, people.R, '30d');
    expect(removed).toMatchObject({ membership_status: 'removed', eligible: 4, attended: 1, rsvp_reliability: 100 });
    await expect(myStats(people.R, communityId)).rejects.toMatchObject({ code: 'P0001', message: 'not_a_member' });
  });

  it('organizers read exactly what the member reads', async () => {
    const { communityId, people } = await referenceSeason();
    for (const id of [people.A, people.B, people.W, people.L, people.N, people.O]) {
      for (const window of ['7d', '30d', '90d', 'all'] as const) {
        const own = await myStats(id, communityId, window);
        const seen = await memberStats(people.O, communityId, id, window);
        expect(counts(seen)).toEqual(counts(own));
        expect(seen.monthly.map((m) => [m.period, m.eligible, m.attended])).toEqual(
          own.monthly.map((m) => [m.period, m.eligible, m.attended]),
        );
      }
    }
  });
});

describe('community statistics (reference season)', () => {
  it('computes every organizer metric exactly as defined (30 days)', async () => {
    const { communityId, people, sessions } = await referenceSeason();
    const stats = await communityStats(people.O, communityId, '30d');
    expect(stats).toMatchObject({
      window: '30d',
      timezone: 'Europe/Bucharest',
      completed_trainings: 4,
      // S1: A, R, O, W; S2: A; S8: none; S3: A, L, W, N.
      total_attendances: 9,
      // S8 was never marked: excluded from the average and reported.
      incomplete_sessions: 1,
      average_attendees_sessions: 3,
      average_attendees: 3,
      // going_count 4 + 2 + 1 + 3 over 4 sessions.
      rsvp_going_total: 10,
      average_rsvp_participation: 2.5,
      // going and present 3 + 1 + 0 + 2, going with a recorded outcome 4 + 1 + 0 + 3.
      rsvp_going_present: 6,
      rsvp_going_recorded: 8,
      rsvp_conversion: 75,
      // O, A, B, W, L, N (R removed).
      active_members: 6,
      // O, A, W, L: N's only attendance was before N joined, R is removed.
      members_attended: 4,
      cancelled_insufficient_participation: 1,
      cancelled_by_organizer: 1,
      trend_unit: 'week',
    });
    // Ties (S3 and S1, 4 each): newer first.
    expect(stats.top_sessions.map((s) => [s.session_id, s.present])).toEqual([
      [sessions.S3, 4],
      [sessions.S1, 4],
      [sessions.S2, 1],
      [sessions.S8, 0],
    ]);
    expect(stats.top_sessions[0]).toMatchObject({ title: 'S3', min_participants: 1, going_count: 3 });
  });

  it('weekly trend for 7/30 days, monthly for 90 days / all time, empty buckets included', async () => {
    const { communityId, people } = await referenceSeason();
    for (const window of ['7d', '30d', '90d', 'all'] as const) {
      const stats = await communityStats(people.O, communityId, window);
      expect(stats.trend_unit).toBe(window === '7d' || window === '30d' ? 'week' : 'month');
      expect(stats.trend.reduce((n, b) => n + b.sessions, 0)).toBe(stats.completed_trainings);
      expect(stats.trend.reduce((n, b) => n + b.present, 0)).toBe(stats.total_attendances);
      for (let i = 1; i < stats.trend.length; i += 1) expect(stats.trend[i].from).toBe(stats.trend[i - 1].to);
      for (const bucket of stats.trend) {
        if (bucket.sessions - bucket.incomplete_sessions === 0) expect(bucket.average_attendees).toBeNull();
        expect(bucket.period).toMatch(window === '7d' || window === '30d' ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}$/);
      }
    }
    const month = await communityStats(people.O, communityId, '7d');
    // 7 days: at least the week of now-7d and the current one may coincide; never more than 2.
    expect(month.trend.length).toBeGreaterThanOrEqual(1);
    expect(month.trend.length).toBeLessThanOrEqual(2);
    // 90 days: S7 included now.
    const ninety = await communityStats(people.O, communityId, '90d');
    expect(ninety).toMatchObject({ completed_trainings: 5, total_attendances: 11, rsvp_conversion: 80, average_attendees: 2.8 });
  });

  it('zero sessions, zero eligible sessions and zero going RSVPs give nulls, never errors', async () => {
    const season = await SeasonBuilder.create();
    const O = await season.person({ role: 'organizer' });
    const M = await season.person();
    const empty = await communityStats(O, season.communityId, 'all');
    expect(empty).toMatchObject({
      completed_trainings: 0, total_attendances: 0, average_attendees: null, incomplete_sessions: 0,
      average_rsvp_participation: null, rsvp_conversion: null, members_attended: 0, active_members: 2,
      trend: [], top_sessions: [],
    });
    expect(counts(await myStats(M, season.communityId, 'all'))).toMatchObject({
      eligible: 0, attendance_rate: null, rsvp_reliability: null,
    });
    expect((await myStats(M, season.communityId, 'all')).monthly).toEqual([]);

    // One finalized session where nobody was going and nobody was marked.
    await season.session({ hoursAgo: 30 });
    const one = await communityStats(O, season.communityId, '7d');
    expect(one).toMatchObject({
      completed_trainings: 1, total_attendances: 0, incomplete_sessions: 1, average_attendees_sessions: 0,
      average_attendees: null, average_rsvp_participation: 0, rsvp_conversion: null,
    });
    expect(counts(await myStats(M, season.communityId, '7d'))).toMatchObject({
      eligible: 1, attended: 0, not_recorded: 1, attendance_rate: 0, confirmed_rsvps: 0, rsvp_reliability: null,
    });
  });

  it('rates round half up to one decimal and return the counts beside them', async () => {
    const season = await SeasonBuilder.create();
    const O = await season.person({ role: 'organizer' });
    const M = await season.person();
    // 16 eligible sessions, 1 attended: 6.25 % -> 6.3 (half-even would give 6.2).
    for (let i = 0; i < 16; i += 1) {
      const s = await season.session({ hoursAgo: 30 + i * 24 });
      if (i === 0) await season.going(s, M, 'present');
      else await season.rsvp(s, M, 'not_going');
    }
    expect(counts(await myStats(M, season.communityId, '30d'))).toMatchObject({ eligible: 16, attended: 1, attendance_rate: 6.3 });
    // 2 of 3: 66.7; 1 of 3: 33.3.
    const s2 = await SeasonBuilder.create();
    const P = await s2.person();
    for (const outcome of ['present', 'present', 'absent'] as const) {
      await s2.going(await s2.session({ hoursAgo: 40 }), P, outcome);
    }
    expect(counts(await myStats(P, s2.communityId, '7d'))).toMatchObject({ attendance_rate: 66.7, rsvp_reliability: 66.7, missed: 1 });
    // Average attendees 9 / 4 = 2.25 -> 2.3.
    const s3 = await SeasonBuilder.create();
    const O3 = await s3.person({ role: 'organizer' });
    const runners = [];
    for (let i = 0; i < 3; i += 1) runners.push(await s3.person({ name: `Runner ${i}` }));
    const plan = [3, 2, 2, 2];
    for (const [i, present] of plan.entries()) {
      const s = await s3.session({ hoursAgo: 30 + i });
      for (let j = 0; j < present; j += 1) await s3.going(s, runners[j], 'present');
    }
    expect(await communityStats(O3, s3.communityId, '7d')).toMatchObject({ total_attendances: 9, average_attendees: 2.3 });
  });
});

describe('consistency between member, summary and community functions', () => {
  it('sums over members equal the community totals for every window', async () => {
    const { communityId, people } = await referenceSeason();
    for (const window of ['7d', '30d', '90d', 'all'] as const) {
      const community = await communityStats(people.O, communityId, window);
      const list = await summary(people.O, communityId, window);
      const removed = await memberStats(people.O, communityId, people.R, window);
      // Present records of people who were not eligible for that session (N at S3).
      const { rows } = await admin.query<{ n: number }>(
        `select count(*)::int as n from private.stats_rows($1, private.stats_window_start($2, now()), now()) r
         where not r.eligible and r.attendance = 'present'`,
        [communityId, window],
      );
      const sum = (key: 'attended' | 'rsvp_going_present' | 'rsvp_going_recorded') =>
        list.members.reduce((n, m) => n + m[key], 0) + removed[key];

      expect(sum('attended') + rows[0].n, window).toBe(community.total_attendances);
      expect(sum('rsvp_going_present'), window).toBe(community.rsvp_going_present);
      expect(sum('rsvp_going_recorded'), window).toBe(community.rsvp_going_recorded);
      expect(list.members.filter((m) => m.attended > 0).length, window).toBe(community.members_attended);
      expect(list.total_members, window).toBe(community.active_members);

      // Each summary line equals that member's own statistics.
      for (const line of list.members) {
        const own = await myStats(line.user_id, communityId, window);
        expect(line, `${window} ${line.display_name}`).toMatchObject({
          eligible: own.eligible, attended: own.attended, absent: own.absent, not_recorded: own.not_recorded,
          attendance_rate: own.attendance_rate, confirmed_rsvps: own.confirmed_rsvps, missed: own.missed,
          rsvp_going_present: own.rsvp_going_present, rsvp_going_recorded: own.rsvp_going_recorded,
          rsvp_reliability: own.rsvp_reliability, walk_ins: own.walk_ins,
        });
      }
    }
  });

  it('the summary lists active members only, ordered by name', async () => {
    const { communityId, people } = await referenceSeason();
    const list = await summary(people.O, communityId, '30d');
    expect(list).toMatchObject({ window: '30d', total_members: 6, truncated: false });
    expect(list.members.map((m) => m.display_name)).toEqual([
      'Ana Always', 'Bogdan Busy', 'Liviu Late', 'Nora New', 'Olga Organizer', 'Wanda Walkin',
    ]);
    expect(list.members.find((m) => m.user_id === people.R)).toBeUndefined();
    expect(list.members.find((m) => m.user_id === people.O)).toMatchObject({ role: 'organizer' });
    expect(list.members.find((m) => m.user_id === people.N)).toMatchObject({ eligible: 0, attendance_rate: null });
  });
});

describe('live data: corrections, moved sessions, the real lifecycle', () => {
  it('a correction after finalization changes the numbers immediately (present <-> absent <-> unrecorded)', async () => {
    const { communityId, people, sessions } = await referenceSeason();
    const { O, B } = people;
    const before = await myStats(B, communityId);
    expect(counts(before)).toMatchObject({ attended: 0, absent: 2, not_recorded: 2, missed: 2, rsvp_going_recorded: 2 });

    // S2 is completed: corrections go through the real RPC.
    await recordAttendance(O, sessions.S2, B, 'absent', 'Checked the sheet');
    expect(counts(await myStats(B, communityId))).toMatchObject({ absent: 3, not_recorded: 1, missed: 3, rsvp_going_recorded: 3, rsvp_reliability: 0 });

    await recordAttendance(O, sessions.S2, B, 'present');
    expect(counts(await myStats(B, communityId))).toMatchObject({
      attended: 1, absent: 2, not_recorded: 1, attendance_rate: 25, missed: 2, rsvp_going_present: 1, rsvp_reliability: 33.3,
    });
    expect(await communityStats(O, communityId)).toMatchObject({ total_attendances: 10, rsvp_going_present: 7, rsvp_going_recorded: 9 });

    await recordAttendance(O, sessions.S2, B, 'unrecorded');
    expect(counts(await myStats(B, communityId))).toEqual(counts(before));
    expect(await communityStats(O, communityId)).toMatchObject({ total_attendances: 9, rsvp_conversion: 75 });
  });

  it('a session moved across a window boundary moves with its current starts_at', async () => {
    const { communityId, people, sessions } = await referenceSeason();
    // S1 (20 days ago) moved to 31 days ago: leaves the 30-day window, stays in 90 days.
    await admin.query("update public.training_sessions set starts_at = now() - interval '744 hours', ends_at = now() - interval '743 hours', rsvp_deadline = now() - interval '746 hours' where id = $1", [sessions.S1]);
    expect(counts(await myStats(people.A, communityId, '30d'))).toMatchObject({ eligible: 3, attended: 2 });
    expect(counts(await myStats(people.A, communityId, '90d'))).toMatchObject({ eligible: 5, attended: 4 });
    expect(await communityStats(people.O, communityId, '30d')).toMatchObject({ completed_trainings: 3, total_attendances: 5 });
    // S7 (40 days ago) moved to 6 days ago: enters 7 days.
    await admin.query("update public.training_sessions set starts_at = now() - interval '144 hours', ends_at = now() - interval '143 hours', rsvp_deadline = now() - interval '146 hours' where id = $1", [sessions.S7]);
    expect(counts(await myStats(people.A, communityId, '7d'))).toMatchObject({ eligible: 2, attended: 2 });
    // L joined 10 days ago, before S7's new start: S7 is now in L's E (no record: unrecorded).
    expect(counts(await myStats(people.L, communityId, '7d'))).toMatchObject({ eligible: 2, attended: 1, not_recorded: 1 });
  });

  it('a session that went through the real RPC lifecycle counts once finalized, not before', async () => {
    const { communityId, organizerId, memberIds, session } = await confirmedSession(2, 2);
    // makeEnded moved the start 2 hours into the past, before the fixture's memberships began:
    // the members joined before the training in real life.
    await admin.query("update public.memberships set joined_at = now() - interval '1 day' where community_id = $1", [communityId]);
    await recordAttendance(organizerId, session.id, memberIds[0], 'present');
    await recordAttendance(organizerId, session.id, memberIds[1], 'absent');
    // Confirmed, marked, not finalized: excluded.
    expect(counts(await myStats(memberIds[0], communityId, '7d'))).toMatchObject({ eligible: 0 });
    expect(await communityStats(organizerId, communityId, '7d')).toMatchObject({ completed_trainings: 0 });

    await finalizeAttendance(organizerId, session.id);
    expect(counts(await myStats(memberIds[0], communityId, '7d'))).toMatchObject({ eligible: 1, attended: 1, rsvp_reliability: 100 });
    expect(counts(await myStats(memberIds[1], communityId, '7d'))).toMatchObject({ eligible: 1, absent: 1, missed: 1, rsvp_reliability: 0 });
    // The organizer did not RSVP and has no record: eligible, not recorded.
    expect(counts(await myStats(organizerId, communityId, '7d'))).toMatchObject({ eligible: 1, not_recorded: 1, attendance_rate: 0 });
    expect(await communityStats(organizerId, communityId, '7d')).toMatchObject({
      completed_trainings: 1, total_attendances: 1, rsvp_going_total: 2, rsvp_conversion: 50, members_attended: 1,
    });
  });
});

describe('attendance history', () => {
  it('lists E newest first with RSVP and outcome; excludes cancelled, unfinalized and pre-join sessions', async () => {
    const { communityId, people, sessions } = await referenceSeason();
    const page = await history(people.W, communityId, 'all');
    expect(page).toMatchObject({ window: 'all', from: null, has_more: false, next_before: null });
    expect(page.items.map((i) => [i.session_id, i.rsvp_response, i.outcome, i.is_walk_in])).toEqual([
      [sessions.S3, 'no_response', 'present', true],
      [sessions.S8, 'no_response', 'unrecorded', false],
      [sessions.S2, 'not_going', 'unrecorded', false],
      [sessions.S1, 'no_response', 'present', true],
      [sessions.S7, 'no_response', 'unrecorded', false],
    ]);
    expect(page.items[0]).toMatchObject({ title: 'S3', location_name: 'Park', timezone: 'Europe/Bucharest', activity_type: 'other' });

    const b = await history(people.B, communityId, '30d');
    expect(b.items.map((i) => i.outcome)).toEqual(['absent', 'unrecorded', 'unrecorded', 'absent']);
    // L: only S3; N: nothing.
    expect((await history(people.L, communityId, 'all')).items.map((i) => i.session_id)).toEqual([sessions.S3]);
    expect((await history(people.N, communityId, 'all')).items).toEqual([]);
    // Default limit is 50.
    expect((await history(people.A, communityId, 'all')).items).toHaveLength(5);
  });

  it('keyset pagination never skips or repeats sessions, including sessions sharing a start', async () => {
    const season = await SeasonBuilder.create();
    const M = await season.person();
    // Starts (hours ago): 10, 20, 20, 20, 30, 40, 50; the three at 20 h are the same instant.
    const { rows: clock } = await admin.query<{ t: Date }>("select date_trunc('second', now()) as t");
    for (const hoursAgo of [10, 20, 20, 20, 30, 40, 50]) {
      await season.session({ at: new Date(clock[0].t.getTime() - hoursAgo * 3_600_000).toISOString() });
    }
    const { rows } = await admin.query<{ id: string }>(
      'select id from public.training_sessions where community_id = $1 order by starts_at desc, id desc',
      [season.communityId],
    );
    const expected = rows.map((r) => r.id);

    for (const limit of [1, 2, 3, 100]) {
      const seen: string[] = [];
      let before: string | null = null;
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await history(M, season.communityId, 'all', limit, before);
        seen.push(...page.items.map((i) => i.session_id));
        if (!page.has_more) {
          expect(page.next_before).toBeNull();
          break;
        }
        expect(page.items.length).toBeGreaterThan(0);
        before = page.next_before;
      }
      expect(seen, `limit ${limit}`).toEqual(expected);
    }
    // A page of 1 that meets three sessions at the same start returns the whole group.
    const first = await history(M, season.communityId, 'all', 1, null);
    const second = await history(M, season.communityId, 'all', 1, first.next_before);
    expect(second.items).toHaveLength(3);
    // Limit 2 stops before the tie group instead of splitting it.
    expect((await history(M, season.communityId, 'all', 2, null)).items).toHaveLength(1);
  });
});
