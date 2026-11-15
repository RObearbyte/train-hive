import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { admin, closeDb, resetData } from './helpers';
import { communityRef, diff, memberRef, memberRows, type Person, type Window } from './qa-stats-reference';
import { BASE, buildWorld, iso, mutate, pick, type World } from './qa-stats-world';
import { communityStats, history, memberStats, myStats, summary, type History } from './stats-helpers';

/**
 * M4-Q1: independent recomputation. A reference implementation written from STATS_DEFINITIONS.md
 * and the contract (qa-stats-reference.ts) is compared, field by field, with every statistics
 * RPC over seeded random seasons: random members, sessions, RSVPs, records, walk-ins, late
 * joins, removals, cancellations, never-marked sheets, time zones, then corrections, moved
 * sessions, removals and a changed community time zone applied to the same data.
 *
 * "pinned": the private payload builders with a fixed clock (window edges are hit exactly).
 * "live": the public RPCs as a real caller with the database's now() (no session sits near an
 * edge, because the clock of the call is a few milliseconds after the one the season was built on).
 */

beforeEach(resetData);
afterAll(closeDb);

const WINDOWS: Window[] = ['7d', '30d', '90d', 'all'];

// Normalisation of actual payloads -----------------------------------------------------------

const INSTANT_KEYS = new Set(['from', 'to', 'starts_at']);
function norm(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => norm(v));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, norm(v, k)]));
  }
  return INSTANT_KEYS.has(key) && typeof value === 'string' ? Date.parse(value) : value;
}

// Comparison ----------------------------------------------------------------------------------

type Fetch = {
  community: (w: Window) => Promise<{ actual: unknown; at: number }>;
  summary: (w: Window) => Promise<unknown>;
  member: (p: Person, w: Window) => Promise<unknown>;
  history: (p: Person, w: Window, limit: number, before: string | null) => Promise<History>;
};

async function privateJson(sql: string, params: unknown[]): Promise<unknown> {
  const { rows } = await admin.query<{ r: unknown }>(sql, params);
  return rows[0].r;
}

function pinnedFetch(world: World): Fetch {
  const c = world.season.communityId;
  const at = iso(BASE);
  return {
    community: async (w) => ({
      actual: await privateJson('select private.stats_community_payload($1, $2, $3::timestamptz) as r', [c, w, at]),
      at: BASE,
    }),
    summary: (w) => privateJson('select private.stats_summary_payload($1, $2, $3::timestamptz) as r', [c, w, at]),
    member: (p, w) => privateJson('select private.stats_member_payload($1, $2, $3, $4::timestamptz) as r', [c, p.id, w, at]),
    history: (p, w, limit, before) =>
      privateJson('select private.stats_history_payload($1, $2, $3, $4, $5::timestamptz, $6::timestamptz) as r', [
        c,
        p.id,
        w,
        limit,
        before,
        at,
      ]) as Promise<History>,
  };
}

function liveFetch(world: World): Fetch {
  const c = world.season.communityId;
  const org = world.organizer.id;
  return {
    community: async (w) => {
      const actual = await communityStats(org, c, w);
      return { actual, at: Date.parse(actual.to) };
    },
    summary: (w) => summary(org, c, w),
    member: (p, w) => memberStats(org, c, p.id, w),
    history: (p, w, limit, before) => history(p.id, c, w, limit, before),
  };
}

const MEMBER_KEYS = [
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

async function compareAll(world: World, fetch: Fetch, label: string, windows: Window[], historyRuns: number): Promise<string[]> {
  const out: string[] = [];
  const { model } = world;
  const note = (what: string, diffs: string[]) => {
    for (const d of diffs) out.push(`${label} ${what}${d}`);
  };

  for (const w of windows) {
    const { actual, at } = await fetch.community(w);
    note(`community ${w}`, diff(norm(actual), communityRef(model, w, at)));

    const sum = (await fetch.summary(w)) as { members: Record<string, unknown>[]; total_members: number; truncated: boolean; to: string };
    const sumAt = Date.parse(sum.to);
    const active = model.people.filter((p) => p.status === 'active').sort((a, b) => (a.name < b.name ? -1 : 1));
    note(
      `summary ${w}`,
      diff(
        { total_members: sum.total_members, truncated: sum.truncated, members: sum.members.map((m) => ({ user_id: m.user_id, role: m.role, ...pickKeys(m, true) })) },
        {
          total_members: active.length,
          truncated: false,
          members: active.map((p) => ({ user_id: p.id, role: p.role, ...pickKeys(memberRef(model, p, w, sumAt) as unknown as Record<string, unknown>, true) })),
        },
      ),
    );

    for (const p of model.people) {
      const actualMember = norm(await fetch.member(p, w)) as { to: number };
      note(`member ${p.name} ${w}`, diff(actualMember, memberRef(model, p, w, actualMember.to)));
    }

    for (let run = 0; run < historyRuns; run += 1) {
      const p = pick(world.rand, model.people.filter((x) => x.status === 'active'));
      const limit = run === 0 ? 100 : 1 + Math.floor(world.rand() * 4);
      const items: unknown[] = [];
      let before: string | null = null;
      let pages = 0;
      let atMs = 0;
      for (;;) {
        const page: History = await fetch.history(p, w, limit, before);
        atMs = Date.parse(page.to);
        items.push(...page.items);
        pages += 1;
        if (page.has_more !== (page.next_before !== null)) out.push(`${label} history ${w}: has_more/next_before disagree`);
        if (!page.has_more) break;
        before = page.next_before;
        if (pages > 60) {
          out.push(`${label} history ${w}: does not terminate`);
          break;
        }
      }
      const expected = memberRows(model, p, w, atMs);
      note(
        `history ${p.name} ${w} limit ${limit}`,
        diff(
          norm(items),
          expected.map(({ session_id, starts_at, rsvp_response, outcome, is_walk_in }) => ({ session_id, starts_at, rsvp_response, outcome, is_walk_in })),
        ),
      );
    }
  }
  return out;
}

function pickKeys(m: Record<string, unknown>, summaryLine = false): Record<string, unknown> {
  return Object.fromEntries(MEMBER_KEYS.filter((k) => !(summaryLine && k === 'recorded')).map((k) => [k, m[k]]));
}

describe('reference implementation vs the statistics functions', () => {
  it('pinned clock: 30 random seasons, every window, before and after corrections, moves, a removal and a zone change', async () => {
    const mismatches: string[] = [];
    for (let seed = 1; seed <= 30; seed += 1) {
      await resetData();
      const world = await buildWorld(seed, BASE, true);
      mismatches.push(...(await compareAll(world, pinnedFetch(world), `seed ${seed} initial`, WINDOWS, 1)));
      const log = await mutate(world);
      mismatches.push(...(await compareAll(world, pinnedFetch(world), `seed ${seed} after [${log.join('; ')}]`, WINDOWS, 2)));
    }
    expect(mismatches.slice(0, 40)).toEqual([]);
  }, 600_000);

  it('live clock, through the public RPCs as real callers: 6 seasons, before and after changes', async () => {
    const mismatches: string[] = [];
    for (let seed = 101; seed <= 106; seed += 1) {
      await resetData();
      const world = await buildWorld(seed, Date.now() - 3000, false);
      const fetch = liveFetch(world);
      mismatches.push(...(await compareAll(world, fetch, `seed ${seed} initial`, WINDOWS, 1)));

      // get_my_statistics equals get_member_statistics for every active person (same numbers, same window).
      for (const p of world.model.people.filter((x) => x.status === 'active')) {
        const mine = await myStats(p.id, world.season.communityId, '90d');
        const viaOrg = await memberStats(world.organizer.id, world.season.communityId, p.id, '90d');
        mismatches.push(...diff(pickKeys(mine as unknown as Record<string, unknown>), pickKeys(viaOrg as unknown as Record<string, unknown>)).map((d) => `seed ${seed} my-vs-member ${p.name}${d}`));
      }
    }
    expect(mismatches.slice(0, 40)).toEqual([]);
  }, 600_000);

  it('the harness is sensitive: an unmodelled correction, move or removal is reported as a mismatch', async () => {
    await resetData();
    const world = await buildWorld(7, BASE, true);
    const fetch = pinnedFetch(world);
    expect(await compareAll(world, fetch, 'baseline', ['all'], 0)).toEqual([]);
    const s = world.model.sessions.find((x) => x.kind === 'completed' && [...x.recs.values()].some((r) => r.status === 'present' && !r.walkIn))!;
    const uid = [...s.recs.entries()].find(([, r]) => r.status === 'present' && !r.walkIn)![0];
    await admin.query("update public.attendance_records set status = 'absent' where session_id = $1 and user_id = $2", [s.id, uid]);
    const drift = await compareAll(world, fetch, 'drift', ['all'], 0);
    expect(drift.length).toBeGreaterThan(3);
    expect(drift.some((d) => d.includes('community all.total_attendances'))).toBe(true);
  }, 120_000);

  it('coverage: the seeds exercise the interesting cases', async () => {
    let nullRates = 0;
    let incomplete = 0;
    let lateJoiners = 0;
    let removed = 0;
    let weeks = 0;
    for (let seed = 1; seed <= 30; seed += 1) {
      await resetData();
      const w = await buildWorld(seed, BASE, false);
      const c = communityRef(w.model, 'all', BASE);
      incomplete += c.incomplete_sessions;
      weeks += communityRef(w.model, '90d', BASE).trend.length;
      removed += w.model.people.filter((p) => p.status === 'removed').length;
      for (const p of w.model.people) {
        const r7 = memberRef(w.model, p, '7d', BASE);
        if (r7.attendance_rate === null || r7.rsvp_reliability === null) nullRates += 1;
        if (w.model.sessions.some((s) => p.joinedMs > s.startMs)) lateJoiners += 1;
      }
    }
    expect({ nullRates, incomplete, lateJoiners, removed, weeks }).toMatchObject({});
    expect(nullRates).toBeGreaterThan(10);
    expect(incomplete).toBeGreaterThan(10);
    expect(lateJoiners).toBeGreaterThan(20);
    expect(removed).toBeGreaterThan(10);
    expect(weeks).toBeGreaterThan(60);
  }, 300_000);
});
