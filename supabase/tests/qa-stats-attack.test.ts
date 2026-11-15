import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { admin, asAnon, asService, asUser, closeDb, createUser, INSUFFICIENT_PRIVILEGE, resetData, rpc } from './helpers';
import { average, bucketOf, prng, rate } from './qa-stats-reference';
import { communityStats, history, memberStats, myStats, SeasonBuilder, summary } from './stats-helpers';

/**
 * M4-Q1: attacks on the statistics SQL. Rounding grid against the reference, privilege checks on
 * the private helpers, hostile input, pagination with equal starts, calendar buckets in every
 * time zone the database knows, reads while attendance is being rewritten, leakage of other
 * members' data through member-visible payloads, and a large dataset.
 */

beforeEach(resetData);
afterAll(closeDb);

const raised = (message: string) => ({ code: 'P0001', message });

describe('rounding: private.stats_rate / stats_average equal an exact half-up reference', () => {
  it('every n <= d <= 160 (rates) and totals up to 500 over counts up to 60 (averages)', async () => {
    const { rows: rates } = await admin.query<{ n: number; d: number; r: string | null }>(
      `select n, d, private.stats_rate(n, d) as r
       from generate_series(0, 160) d cross join lateral generate_series(0, d) n`,
    );
    const bad: string[] = [];
    for (const row of rates) {
      const expected = rate(row.n, row.d);
      const actual = row.r === null ? null : Number(row.r);
      if (actual !== expected) bad.push(`rate ${row.n}/${row.d}: expected ${expected}, got ${actual}`);
    }
    const { rows: avgs } = await admin.query<{ t: number; c: number; r: string | null }>(
      `select t, c, private.stats_average(t, c) as r
       from generate_series(0, 500) t cross join generate_series(0, 60) c`,
    );
    for (const row of avgs) {
      const expected = average(row.t, row.c);
      const actual = row.r === null ? null : Number(row.r);
      if (actual !== expected) bad.push(`average ${row.t}/${row.c}: expected ${expected}, got ${actual}`);
    }
    expect(bad.slice(0, 20)).toEqual([]);
    // Spot checks of the ties the reference must get right.
    expect(rate(1, 16)).toBe(6.3);
    expect(rate(1, 8)).toBe(12.5);
    expect(rate(1, 3)).toBe(33.3);
    expect(rate(2, 3)).toBe(66.7);
  });

  it('the JSON carries rates as numbers with at most one decimal (no float noise such as 66.69999)', async () => {
    const season = await SeasonBuilder.create('UTC');
    const M = await season.person({ joinedAt: '2020-01-01T00:00:00Z' });
    for (let i = 1; i <= 3; i += 1) {
      const s = await season.session({ hoursAgo: i * 10 });
      await season.going(s, M, i === 3 ? 'absent' : 'present');
    }
    const stats = await myStats(M, season.communityId, '7d');
    expect(stats.attendance_rate).toBe(66.7);
    expect(JSON.stringify(stats)).toContain('"attendance_rate": 66.7'.replace(': ', ':'));
  });
});

describe('private helpers are not callable through the API', () => {
  it('no API role can execute or even reach any private.stats_* function', async () => {
    const { rows } = await admin.query<{ sig: string }>(
      `select p.oid::regprocedure::text as sig
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'private' and p.proname like 'stats\\_%'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const user = await createUser();
    const calls: Record<string, string> = {
      'stats_rate(integer,integer)': 'select private.stats_rate(1, 2)',
      'stats_rows(uuid,timestamp with time zone,timestamp with time zone,uuid)': "select * from private.stats_rows(gen_random_uuid(), null, now(), null)",
      'stats_member_payload(uuid,uuid,text,timestamp with time zone)': "select private.stats_member_payload(gen_random_uuid(), gen_random_uuid(), 'all', now())",
      'stats_community_payload(uuid,text,timestamp with time zone)': "select private.stats_community_payload(gen_random_uuid(), 'all', now())",
      'stats_summary_payload(uuid,text,timestamp with time zone)': "select private.stats_summary_payload(gen_random_uuid(), 'all', now())",
      'stats_history_payload(uuid,uuid,text,integer,timestamp with time zone,timestamp with time zone)':
        "select private.stats_history_payload(gen_random_uuid(), gen_random_uuid(), 'all', 5, null, now())",
    };
    for (const [sig, sql] of Object.entries(calls)) {
      expect(rows.map((r) => r.sig.replace('private.', ''))).toContain(sig);
      await expect(asUser(user, (db) => db.query(sql))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(asAnon((db) => db.query(sql))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(asService((db) => db.query(sql))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    }
  });

  it('the public functions are security definer with an empty search_path and not callable by public', async () => {
    const { rows } = await admin.query<{ name: string; secdef: boolean; config: string[] | null; anon: boolean; svc: boolean; auth: boolean; vol: string }>(
      `select p.proname as name, p.prosecdef as secdef, p.proconfig as config, p.provolatile as vol,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('service_role', p.oid, 'execute') as svc,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('get_my_statistics','get_my_attendance_history','get_member_statistics','get_community_statistics','list_member_statistics_summary')`,
    );
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row, row.name).toMatchObject({ secdef: true, anon: false, svc: false, auth: true, vol: 's' });
      expect(row.config, row.name).toContain('search_path=""');
    }
  });
});

async function smallWorld() {
  const season = await SeasonBuilder.create('Europe/Bucharest');
  const org = await season.person({ role: 'organizer', name: 'Org' });
  const member = await season.person({ name: 'Mem' });
  const other = await season.person({ name: 'Oth' });
  const s = await season.session({ hoursAgo: 30 });
  await season.going(s, member, 'present');
  await season.going(s, other, 'absent');
  const outsider = await createUser();
  await admin.query("insert into public.profiles (id, display_name) values ($1, 'Outsider')", [outsider]);
  return { season, c: season.communityId, org, member, other, s, outsider };
}

describe('hostile input', () => {
  const windows: (string | null)[] = [
    null, '', ' ', '7D', '7d ', ' 7d', 'ALL', 'All', 'week', '1d', '7', '0d', '-7d', '365d', 'NaN', 'Infinity',
    "7d'; drop table public.training_sessions; --", "' or 1=1 --", '７d', 'all\n', 'x'.repeat(100_000),
  ];

  it('every function rejects every malformed window with validation_failed:window, after authorization', async () => {
    const w = await smallWorld();
    for (const window of windows) {
      await expect(myStats(w.member, w.c, window), String(window).slice(0, 20)).rejects.toMatchObject(raised('validation_failed:window'));
      await expect(history(w.member, w.c, window), String(window).slice(0, 20)).rejects.toMatchObject(raised('validation_failed:window'));
      await expect(memberStats(w.org, w.c, w.member, window)).rejects.toMatchObject(raised('validation_failed:window'));
      await expect(communityStats(w.org, w.c, window)).rejects.toMatchObject(raised('validation_failed:window'));
      await expect(summary(w.org, w.c, window)).rejects.toMatchObject(raised('validation_failed:window'));
      // An outsider with a malformed window learns nothing about the input check.
      await expect(myStats(w.outsider, w.c, window)).rejects.toMatchObject(raised('not_a_member'));
      await expect(communityStats(w.member, w.c, window)).rejects.toMatchObject(raised('forbidden'));
    }
    // The data survived the injection attempt.
    expect((await admin.query('select count(*)::int as n from public.training_sessions')).rows[0].n).toBe(1);
  });

  it('limits: only 1..100 are accepted; null, zero, negative and huge values are rejected, not clamped', async () => {
    const w = await smallWorld();
    for (const limit of [0, -1, -2147483648, 101, 1000, 2147483647, null]) {
      await expect(history(w.member, w.c, 'all', limit as number | null), String(limit)).rejects.toMatchObject(raised('validation_failed:limit'));
    }
    for (const limit of [1, 50, 100]) expect((await history(w.member, w.c, 'all', limit)).items).toHaveLength(1);
    // A value outside the integer range is a protocol error from the database, never a result.
    await expect(asUser(w.member, (db) => db.query("select public.get_my_attendance_history($1, 'all', 2147483648)", [w.c]))).rejects.toMatchObject({
      code: expect.stringMatching(/^(22003|42883)$/),
    });
  });

  it('p_before: infinities, the far future and the far past are handled; the past cursor is exclusive', async () => {
    const w = await smallWorld();
    const page = (before: string) => asUser(w.member, (db) => rpc<{ items: unknown[]; has_more: boolean; next_before: string | null }>(db, 'get_my_attendance_history', [w.c, 'all', 10, before]));
    expect((await page('infinity')).items).toHaveLength(1);
    expect((await page('9999-12-31T00:00:00Z')).items).toHaveLength(1);
    expect(await page('-infinity')).toMatchObject({ items: [], has_more: false, next_before: null });
    expect(await page('0001-01-01T00:00:00Z')).toMatchObject({ items: [], has_more: false, next_before: null });
    const { rows } = await admin.query<{ starts_at: string }>('select starts_at from public.training_sessions where id = $1', [w.s]);
    expect((await page(rows[0].starts_at)).items).toEqual([]);
  });

  it('p_user_id cannot be used to read someone else: members have no such parameter, organizers are scoped to their community', async () => {
    const w = await smallWorld();
    // get_my_* take the identity from auth.uid(); an extra argument does not exist.
    await expect(asUser(w.member, (db) => db.query('select public.get_my_statistics($1, $2, $3)', [w.c, '30d', w.other]))).rejects.toMatchObject({ code: '42883' });
    // A member asking for another member's numbers through the organizer function is refused.
    await expect(memberStats(w.member, w.c, w.other)).rejects.toMatchObject(raised('forbidden'));
    // A demoted organizer loses access at once (no cached role).
    await admin.query("update public.memberships set role = 'member' where community_id = $1 and user_id = $2", [w.c, w.org]);
    await expect(communityStats(w.org, w.c)).rejects.toMatchObject(raised('forbidden'));
    await expect(summary(w.org, w.c)).rejects.toMatchObject(raised('forbidden'));
    await expect(memberStats(w.org, w.c, w.other)).rejects.toMatchObject(raised('forbidden'));
    expect((await myStats(w.org, w.c)).eligible).toBe(1);
  });

  it('a malformed uuid is a protocol error, never data', async () => {
    const w = await smallWorld();
    await expect(asUser(w.org, (db) => db.query("select public.get_member_statistics($1, 'not-a-uuid', '30d')", [w.c]))).rejects.toMatchObject({ code: '22P02' });
  });
});

describe('leakage through member-visible payloads', () => {
  it('a member payload, the history and the community-wide values hold no other member id or name', async () => {
    const season = await SeasonBuilder.create('Europe/Bucharest');
    const org = await season.person({ role: 'organizer', name: 'Zorro Organizer' });
    const a = await season.person({ name: 'Alpha Visible' });
    const b = await season.person({ name: 'Bravo Secret' });
    const gone = await season.person({ name: 'Charlie Removed', status: 'removed' });
    for (let i = 1; i <= 4; i += 1) {
      const s = await season.session({ hoursAgo: i * 20, title: `Run ${i}` });
      await season.going(s, a, 'present');
      await season.going(s, b, i % 2 ? 'absent' : 'present');
      await season.going(s, gone, 'absent');
    }
    const mine = JSON.stringify(await myStats(a, season.communityId, 'all'));
    const hist = JSON.stringify(await history(a, season.communityId, 'all', 100));
    for (const secret of [b, gone, org, 'Bravo', 'Charlie', 'Zorro']) {
      expect(mine, String(secret)).not.toContain(secret);
      expect(hist, String(secret)).not.toContain(secret);
    }
    // The organizer overview carries counts and sessions, never a person.
    const overview = JSON.stringify(await communityStats(org, season.communityId, 'all'));
    for (const secret of [a, b, gone, 'Alpha', 'Bravo', 'Charlie']) expect(overview, String(secret)).not.toContain(secret);
    // Member B's payload is B's: A's absence and presence are not in it.
    const bPayload = await memberStats(org, season.communityId, b, 'all');
    expect(bPayload).toMatchObject({ user_id: b, absent: 2, attended: 2 });
  });
});

describe('cross-community mixing', () => {
  it('rows of one community cannot reference sessions of another (composite keys), so statistics cannot mix', async () => {
    const a = await SeasonBuilder.create('UTC', 'A');
    const b = await SeasonBuilder.create('UTC', 'B');
    const memB = await b.person({ name: 'B member' });
    const sA = await a.session({ hoursAgo: 30 });
    await expect(
      admin.query("insert into public.attendance_records (session_id, community_id, user_id, status, had_rsvp_going) values ($1, $2, $3, 'present', true)", [sA, b.communityId, memB]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      admin.query("insert into public.training_rsvps (session_id, community_id, user_id, response) values ($1, $2, $3, 'going')", [sA, b.communityId, memB]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('a person who is in A and has records in B (never a member of B) is not in B members, only in B session totals', async () => {
    const a = await SeasonBuilder.create('UTC', 'A');
    const b = await SeasonBuilder.create('UTC', 'B');
    const orgB = await b.person({ role: 'organizer', name: 'Org B' });
    const x = await a.person({ name: 'Xavier' });
    const sB = await b.session({ hoursAgo: 30 });
    // Not possible through the API (the person has no membership in B); arranged to prove the joins hold.
    await b.walkIn(sB, x);
    const community = await communityStats(orgB, b.communityId, '7d');
    expect(community).toMatchObject({ total_attendances: 1, members_attended: 0, active_members: 1 });
    expect((await summary(orgB, b.communityId, '7d')).members.map((m) => m.user_id)).toEqual([orgB]);
    await expect(memberStats(orgB, b.communityId, x)).rejects.toMatchObject(raised('not_found'));
    expect(await myStats(x, a.communityId, '7d')).toMatchObject({ eligible: 0, attended: 0 });
  });
});

// Pagination ---------------------------------------------------------------------------------

describe('history pagination with many sessions sharing one start', () => {
  it('random tie structures and limits: concatenated pages equal the full list, no duplicates, no skips', async () => {
    const rand = prng(4242);
    const bad: string[] = [];
    for (let trial = 0; trial < 12; trial += 1) {
      await resetData();
      const season = await SeasonBuilder.create('UTC');
      const M = await season.person({ name: 'Runner', joinedAt: '2020-01-01T00:00:00Z' });
      const instants = [10, 20, 30, 40, 50].map((h) => h * 3_600_000);
      const base = Date.now() - 1000;
      const expected: { id: string; at: number }[] = [];
      const n = 6 + Math.floor(rand() * 18);
      for (let i = 0; i < n; i += 1) {
        const at = base - instants[Math.floor(rand() * 3 + (rand() < 0.3 ? 2 : 0))];
        const id = await season.session({ at: new Date(at).toISOString() });
        await season.going(id, M, 'present');
        expected.push({ id, at });
      }
      expected.sort((x, y) => y.at - x.at || (x.id < y.id ? 1 : -1));
      for (const limit of [1, 2, 3, 5, 7]) {
        const got: string[] = [];
        let before: string | null = null;
        for (let guard = 0; guard < 40; guard += 1) {
          const page = await history(M, season.communityId, 'all', limit, before);
          got.push(...page.items.map((i) => i.session_id));
          const sameInstant = new Set(page.items.map((i) => i.starts_at)).size === 1;
          if (page.items.length > limit && !sameInstant) bad.push(`trial ${trial} limit ${limit}: page of ${page.items.length} spans several starts`);
          if (page.items.length === 0 && page.has_more) bad.push(`trial ${trial} limit ${limit}: empty page with has_more`);
          if (!page.has_more) {
            if (page.next_before !== null) bad.push(`trial ${trial} limit ${limit}: next_before set on last page`);
            break;
          }
          before = page.next_before;
        }
        if (JSON.stringify(got) !== JSON.stringify(expected.map((e) => e.id))) bad.push(`trial ${trial} limit ${limit}: pages differ from the full list (${got.length} vs ${expected.length})`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  }, 180_000);
});

describe('a pile of sessions at one instant', () => {
  it('a page can exceed the limit by the size of a same-instant group (documented); nothing is skipped', async () => {
    const season = await SeasonBuilder.create('UTC');
    const M = await season.person({ joinedAt: '2020-01-01T00:00:00Z' });
    const at = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const older = await season.session({ at: new Date(Date.now() - 6 * 86_400_000).toISOString() });
    await season.going(older, M, 'present');
    const ids: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const id = await season.session({ at });
      await season.rsvp(id, M, 'going');
      ids.push(id);
    }
    const first = await history(M, season.communityId, 'all', 5);
    expect(first.items).toHaveLength(60);
    expect(first.has_more).toBe(true);
    expect(new Set(first.items.map((i) => i.session_id))).toEqual(new Set(ids));
    const second = await history(M, season.communityId, 'all', 5, first.next_before);
    expect(second.items.map((i) => i.session_id)).toEqual([older]);
    expect(second.has_more).toBe(false);
  }, 120_000);
});

// Time zones ---------------------------------------------------------------------------------

describe('calendar buckets in every time zone the database knows', () => {
  it('weeks and months are contiguous, ordered and anchored to local midnight (within the hour a DST rule may move it) for every zone, 2020 to 2030', async () => {
    const { rows } = await admin.query<{ name: string; unit: string; n: number; gaps: number; wrongStart: number }>(
      `with zones as (
         select name from pg_timezone_names
         where name ~ '^[A-Z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)+$' and name !~ '^(posix|right)/'
            or name = 'UTC'
       ), units(unit) as (values ('month'), ('week')),
       b as (
         select z.name, u.unit, k.*,
                lag(k.period_to) over (partition by z.name, u.unit order by k.period_from) as prev_to
         from zones z cross join units u
         cross join lateral private.stats_buckets(z.name, u.unit, '2020-01-15T00:00:00Z', '2030-01-15T00:00:00Z') k
       )
       select name, unit, count(*)::int as n,
              count(*) filter (where prev_to is not null and prev_to <> period_from)::int as gaps,
              count(*) filter (where not ((period_from at time zone name)::time <= '01:00' or (period_from at time zone name)::time >= '23:00'))::int as "wrongStart"
       from b group by name, unit
       having count(*) filter (where prev_to is not null and prev_to <> period_from) > 0
           or count(*) filter (where not ((period_from at time zone name)::time <= '01:00' or (period_from at time zone name)::time >= '23:00')) > 0`,
    );
    expect(rows).toEqual([]);
    const { rows: counts } = await admin.query<{ months: number; zones: number }>(
      `select count(*)::int as months, count(distinct z.name)::int as zones
       from pg_timezone_names z
       cross join lateral private.stats_buckets(z.name, 'month', '2020-01-15T00:00:00Z', '2030-01-15T00:00:00Z') k
       where z.name in ('Europe/Bucharest', 'America/New_York')`,
    );
    expect(counts[0]).toEqual({ months: 242, zones: 2 });
  });

  it('the reference calendar and the database agree on every bucket of 9 zones for 2025-2027', async () => {
    const bad: string[] = [];
    for (const tz of ['Europe/Bucharest', 'America/New_York', 'Pacific/Auckland', 'Asia/Kolkata', 'Australia/Lord_Howe', 'UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Europe/London']) {
      for (const unit of ['month', 'week'] as const) {
        const { rows } = await admin.query<{ period: string; f: string; t: string }>(
          `select period, period_from as f, period_to as t
           from private.stats_buckets($1, $2, '2025-01-01T00:00:00Z', '2027-12-31T00:00:00Z') order by period_from`,
          [tz, unit],
        );
        let cursor = Date.parse(rows[0].f);
        for (const row of rows) {
          const ref = bucketOf(cursor, unit, tz);
          if (ref.period !== row.period || ref.from !== Date.parse(row.f) || ref.to !== Date.parse(row.t)) {
            bad.push(`${tz} ${unit} ${row.period}: reference ${ref.period} ${new Date(ref.from).toISOString()}..${new Date(ref.to).toISOString()}, db ${row.f}..${row.t}`);
          }
          cursor = Date.parse(row.t);
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('a community with a time zone name that is odd but accepted by the database still gets statistics', async () => {
    for (const tz of ['Factory', 'Etc/GMT+12', 'Etc/GMT-14', 'Antarctica/Troll', 'America/Argentina/ComodRivadavia']) {
      await resetData();
      const season = await SeasonBuilder.create(tz);
      const org = await season.person({ role: 'organizer' });
      const s = await season.session({ hoursAgo: 30 });
      await season.going(s, org, 'present');
      const stats = await communityStats(org, season.communityId, '90d');
      expect(stats.trend.length, tz).toBeGreaterThanOrEqual(3);
      expect((await myStats(org, season.communityId, 'all')).monthly.length, tz).toBeGreaterThanOrEqual(1);
    }
  });

  it('a stored zone that the database cannot resolve fails with a raw database error, not a business error (unreachable through the API)', async () => {
    const season = await SeasonBuilder.create('Europe/Bucharest');
    const org = await season.person({ role: 'organizer' });
    const s = await season.session({ hoursAgo: 30 });
    await season.going(s, org, 'present');
    // No RPC changes communities.timezone and the table is select-only for API roles; a superuser
    // (migration, dashboard) can still put a bad value in.
    await admin.query("update public.communities set timezone = 'Not/AZone' where id = $1", [season.communityId]);
    await expect(communityStats(org, season.communityId, '30d')).rejects.toMatchObject({ code: '22023' });
    await expect(myStats(org, season.communityId, '30d')).rejects.toMatchObject({ code: '22023' });
    // History and the summary do not use the zone and keep working.
    expect((await history(org, season.communityId, '30d')).items).toHaveLength(1);
    expect((await summary(org, season.communityId, '30d')).members).toHaveLength(1);
  });
});

// Concurrency --------------------------------------------------------------------------------

describe('reads while attendance is being rewritten', () => {
  it('every payload is one consistent snapshot of a writer that flips a whole season at once', async () => {
    const season = await SeasonBuilder.create('Europe/Bucharest');
    const org = await season.person({ role: 'organizer', name: 'Org' });
    const members: string[] = [];
    for (let i = 0; i < 4; i += 1) members.push(await season.person({ name: `Mem ${i}` }));
    const sessions: string[] = [];
    for (let i = 1; i <= 6; i += 1) {
      const s = await season.session({ hoursAgo: i * 20 });
      sessions.push(s);
      for (const m of members) await season.going(s, m, 'present');
    }
    const seasonWriter = await admin.connect();
    let running = true;
    let flips = 0;
    // Each transaction rewrites all sessions in several statements, committing a new "state":
    // all present, or all absent with the last two sessions un-finalized.
    const writer = (async () => {
      while (running) {
        const toAbsent = flips % 2 === 0;
        await seasonWriter.query('begin');
        for (const s of sessions) {
          await seasonWriter.query('update public.attendance_records set status = $2 where session_id = $1', [s, toAbsent ? 'absent' : 'present']);
          await seasonWriter.query('select pg_sleep(0.004)');
        }
        await seasonWriter.query(
          `update public.training_sessions
           set status = $2::public.session_status, attendance_finalized_at = case when $2 = 'completed' then starts_at + interval '2 hours' end
           where id = any($1::uuid[])`,
          [sessions.slice(4), toAbsent ? 'confirmed' : 'completed'],
        );
        await seasonWriter.query('commit');
        flips += 1;
      }
    })();

    const violations: string[] = [];
    const seen = new Set<string>();
    try {
      for (let i = 0; i < 1500 && (flips < 12 || i < 40); i += 1) {
        const [c, sum, mine] = await Promise.all([
          communityStats(org, season.communityId, 'all'),
          summary(org, season.communityId, 'all'),
          myStats(members[0], season.communityId, 'all'),
        ]);
        // Allowed states: 6 sessions x 4 present = 24 attendances, or 4 sessions x 0 = 0 (absent, two un-finalized).
        const state = `${c.completed_trainings}/${c.total_attendances}`;
        seen.add(state);
        if (!['6/24', '4/0', '6/0', '4/16'].includes(state)) violations.push(`community state ${state}`);
        if (c.trend.reduce((n, b) => n + b.present, 0) !== c.total_attendances) violations.push(`trend sum differs from total (${state})`);
        if (c.trend.reduce((n, b) => n + b.sessions, 0) !== c.completed_trainings) violations.push(`trend sessions differ (${state})`);
        const attendedSum = sum.members.reduce((n, m) => n + m.attended, 0);
        if (!['24', '0', '16'].includes(String(attendedSum))) violations.push(`summary attended ${attendedSum}`);
        if (mine.attended + mine.absent + mine.not_recorded !== mine.eligible) violations.push('member counts do not add up');
        if (mine.monthly.reduce((n, m) => n + m.eligible, 0) !== mine.eligible) violations.push('monthly sum differs');
        if (!(mine.attended === 0 || mine.attended === mine.eligible)) violations.push(`member torn read ${mine.attended}/${mine.eligible}`);
      }
    } finally {
      running = false;
      await writer;
      seasonWriter.release();
    }
    expect(flips).toBeGreaterThanOrEqual(12);
    expect(violations.slice(0, 10)).toEqual([]);
    expect(seen.size).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('a read never waits for an open writer and does not see its uncommitted rows', async () => {
    const season = await SeasonBuilder.create('UTC');
    const org = await season.person({ role: 'organizer' });
    const m = await season.person();
    const s = await season.session({ hoursAgo: 30 });
    await season.going(s, m, 'absent');
    const writer = await admin.connect();
    try {
      await writer.query('begin');
      await writer.query("update public.attendance_records set status = 'present' where session_id = $1", [s]);
      await writer.query('lock table public.attendance_records in share row exclusive mode');
      const started = Date.now();
      const stats = await communityStats(org, season.communityId, '7d');
      expect(Date.now() - started).toBeLessThan(3000);
      expect(stats.total_attendances).toBe(0);
      await writer.query('commit');
    } finally {
      writer.release();
    }
    expect((await communityStats(org, season.communityId, '7d')).total_attendances).toBe(1);
  });
});

// Consistency and definitions ----------------------------------------------------------------

describe('definition checks that the reference season in stats.test.ts does not pin', () => {
  it('SPEC LITERAL vs DEFINITIONS: the spec rate (going and present over finalized sessions with going) differs from the shipped reliability when records are missing', async () => {
    const season = await SeasonBuilder.create('UTC');
    const M = await season.person({ joinedAt: '2020-01-01T00:00:00Z' });
    // Four sessions with going RSVP: present, present, unrecorded, no record at all.
    const s1 = await season.session({ hoursAgo: 10 });
    const s2 = await season.session({ hoursAgo: 20 });
    const s3 = await season.session({ hoursAgo: 30 });
    const s4 = await season.session({ hoursAgo: 40 });
    await season.going(s1, M, 'present');
    await season.going(s2, M, 'present');
    await season.going(s3, M, 'unrecorded');
    await season.rsvp(s4, M, 'going');
    const stats = await myStats(M, season.communityId, '7d');
    expect(stats).toMatchObject({ confirmed_rsvps: 4, rsvp_going_present: 2, rsvp_going_recorded: 2, rsvp_reliability: 100, attendance_rate: 50, not_recorded: 2, missed: 0 });
    // The spec's literal wording would give 2 / 4 = 50 %. The shipped value is 100 %. Owner decision D1.
    expect((100 * stats.rsvp_going_present) / stats.confirmed_rsvps).toBe(50);
  });

  it('attendance rate keeps unrecorded in the denominator, so an unrecorded session lowers the rate exactly like an absence (owner decision D2)', async () => {
    const season = await SeasonBuilder.create('UTC');
    const A = await season.person({ joinedAt: '2020-01-01T00:00:00Z', name: 'Marked absent' });
    const B = await season.person({ joinedAt: '2020-01-01T00:00:00Z', name: 'Never marked' });
    const s1 = await season.session({ hoursAgo: 10 });
    const s2 = await season.session({ hoursAgo: 20 });
    await season.going(s1, A, 'present');
    await season.going(s2, A, 'absent');
    await season.going(s1, B, 'present');
    await season.going(s2, B, 'unrecorded');
    const a = await myStats(A, season.communityId, '7d');
    const b = await myStats(B, season.communityId, '7d');
    expect(a.attendance_rate).toBe(50);
    expect(b.attendance_rate).toBe(50);
    expect([a.absent, a.not_recorded]).toEqual([1, 0]);
    expect([b.absent, b.not_recorded]).toEqual([0, 1]);
  });

  it('people who said not_going or never answered count in the rate denominator as "not recorded" (owner decision D3)', async () => {
    const season = await SeasonBuilder.create('UTC');
    const M = await season.person({ joinedAt: '2020-01-01T00:00:00Z' });
    for (let i = 1; i <= 4; i += 1) {
      const s = await season.session({ hoursAgo: i * 10 });
      if (i === 1) await season.going(s, M, 'present');
      else await season.rsvp(s, M, 'not_going');
    }
    expect(await myStats(M, season.communityId, '7d')).toMatchObject({ eligible: 4, attended: 1, attendance_rate: 25, not_recorded: 3, absent: 0, missed: 0 });
  });

  it('a removed member is eligible for sessions after their removal, so their rate is diluted by sessions they could not attend (owner decision D4)', async () => {
    const season = await SeasonBuilder.create('UTC');
    const org = await season.person({ role: 'organizer' });
    const R = await season.person({ joinedAt: '2020-01-01T00:00:00Z', name: 'Leaver' });
    const early = await season.session({ hoursAgo: 100 });
    await season.going(early, R, 'present');
    await admin.query("update public.memberships set status = 'removed' where community_id = $1 and user_id = $2", [season.communityId, R]);
    for (let i = 1; i <= 3; i += 1) await season.session({ hoursAgo: i * 10 });
    const stats = await memberStats(org, season.communityId, R, '7d');
    expect(stats).toMatchObject({ membership_status: 'removed', eligible: 4, attended: 1, not_recorded: 3, attendance_rate: 25 });
  });

  it('a reinstated member (status back to active, joined_at unchanged) is eligible for sessions held while removed (owner decision D5)', async () => {
    const season = await SeasonBuilder.create('UTC');
    const M = await season.person({ joinedAt: '2020-01-01T00:00:00Z' });
    await admin.query("update public.memberships set status = 'removed' where community_id = $1 and user_id = $2", [season.communityId, M]);
    for (let i = 1; i <= 3; i += 1) await season.session({ hoursAgo: i * 10 });
    await admin.query("update public.memberships set status = 'active' where community_id = $1 and user_id = $2", [season.communityId, M]);
    expect((await myStats(M, season.communityId, '7d')).eligible).toBe(3);
  });
});

// Scale --------------------------------------------------------------------------------------

describe('a larger season', () => {
  it('400 members x 500 sessions (200k member-session pairs): every function answers, sums stay consistent', async () => {
    const { rows } = await admin.query<{ id: string }>("insert into public.communities (name, timezone) values ('Huge Pack', 'Europe/Bucharest') returning id");
    const c = rows[0].id;
    await admin.query(
      `insert into public.training_sessions (community_id, title, starts_at, ends_at, rsvp_deadline, timezone, location_name,
         min_participants, status, decided_at, attendance_finalized_at)
       select $1, 'Run ' || i, now() - i * interval '5 hours', now() - i * interval '5 hours' + interval '1 hour',
              now() - i * interval '5 hours' - interval '2 hours', 'Europe/Bucharest', 'Park', 1,
              'completed', now() - i * interval '5 hours' - interval '2 hours', now() - i * interval '5 hours' + interval '2 hours'
       from generate_series(1, 500) i`,
      [c],
    );
    await admin.query(
      `with u as (insert into auth.users (is_anonymous) select true from generate_series(1, 400) returning id),
            numbered as (select id, row_number() over (order by id) as n from u),
            p as (insert into public.profiles (id, display_name) select id, 'Runner ' || lpad(n::text, 3, '0') from numbered returning id)
       insert into public.memberships (community_id, user_id, role, joined_at)
       select $1, id, (case when n = 1 then 'organizer' else 'member' end)::public.membership_role, now() - interval '400 days' from numbered`,
      [c],
    );
    await admin.query(
      `insert into public.training_rsvps (session_id, community_id, user_id, response)
       select s.id, s.community_id, m.user_id, 'going'
       from public.training_sessions s join public.memberships m on m.community_id = s.community_id
       where s.community_id = $1 and abs(hashtext(s.id::text || m.user_id::text)) % 100 < 50`,
      [c],
    );
    await admin.query(
      `insert into public.attendance_records (session_id, community_id, user_id, status, had_rsvp_going, is_walk_in)
       select r.session_id, r.community_id, r.user_id,
              (case when abs(hashtext(r.user_id::text || r.session_id::text)) % 10 < 8 then 'present' else 'absent' end)::public.attendance_status, true, false
       from public.training_rsvps r where r.community_id = $1`,
      [c],
    );
    await admin.query('analyze');
    const { rows: ppl } = await admin.query<{ user_id: string; role: string }>('select user_id, role from public.memberships where community_id = $1 order by role, user_id', [c]);
    const org = ppl.find((p) => p.role === 'organizer')!.user_id;
    const mem = ppl.find((p) => p.role === 'member')!.user_id;

    const timings: Record<string, number> = {};
    const timed = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
      const t = performance.now();
      const out = await fn();
      timings[label] = Math.round(performance.now() - t);
      return out;
    };
    const comm = await timed('community all', () => communityStats(org, c, 'all'));
    const list = await timed('summary all', () => summary(org, c, 'all'));
    const mine = await timed('my stats all', () => myStats(mem, c, 'all'));
    const hist = await timed('history all', () => history(mem, c, 'all', 100));
    await timed('member stats all', () => memberStats(org, c, mem, 'all'));
    const comm30 = await timed('community 30d', () => communityStats(org, c, '30d'));
    console.log('[qa stats scale] ms', JSON.stringify(timings));
    expect(comm.completed_trainings).toBe(500);
    expect(list.members.reduce((n, m) => n + m.attended, 0)).toBe(comm.total_attendances);
    expect(mine.eligible).toBe(500);
    expect(hist.items).toHaveLength(100);
    expect(comm30.completed_trainings).toBe(143);
    for (const [label, ms] of Object.entries(timings)) expect(ms, label).toBeLessThan(15_000);
  }, 240_000);
});

