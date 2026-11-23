import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { deleteMyAccount, exportMyData, removeMember } from './account-deletion-helpers';
import { createEvent, type EventKind, type EventSession } from './events-helpers';
import {
  admin,
  asAnon,
  asService,
  asUser,
  closeDb,
  createPack,
  grantConsents,
  RAISED,
  resetData,
  rpc,
  setRsvp,
} from './helpers';

/**
 * P5 workout logs: independent QA review (adversarial). Complements workout-logs.test.ts.
 *
 * Tests named "DEFECT P5-QA-n" use `it.fails`: they assert the SAFE behaviour, currently do not
 * hold, and therefore pass only while the defect exists. When the owning role fixes the defect the
 * test starts failing with "expected to fail"; then remove `.fails`. Tests named "KNOWN LIMIT"
 * document behaviour that the contract accepts or that the product owner must decide.
 */

type Log = {
  id: string;
  session_id: string;
  log_type: 'strength' | 'running' | 'race';
  distance_m: number | null;
  duration_s: number | null;
  pace_s_per_km: number | null;
  exercises: unknown;
  notes: string | null;
  updated_at: string;
};
type Screen = {
  event: { title: string } | null;
  log_type: string | null;
  can_log: boolean;
  cannot_log_reason: string | null;
  has_consent: boolean;
  log: Log | null;
};
type Community = {
  insufficient_data: boolean;
  members_contributing: number | null;
  sessions_logged: number | null;
  total_distance_km: number | null;
  total_duration_minutes: number | null;
  average_pace_s_per_km: number | null;
};

const raised = (message: string) => ({ code: RAISED, message });

const saveRaw = (userId: string, sessionId: string, rawJson: string) =>
  asUser(userId, (db) => rpc<Log>(db, 'save_workout_log', [sessionId, rawJson]));
const save = (userId: string, sessionId: string, input: unknown) => saveRaw(userId, sessionId, JSON.stringify(input));
const getLog = (userId: string, sessionId: string) => asUser(userId, (db) => rpc<Screen>(db, 'get_my_workout_log', [sessionId]));
const deleteLog = (userId: string, sessionId: string) =>
  asUser(userId, (db) => rpc<{ deleted: boolean }>(db, 'delete_my_workout_log', [sessionId]));
const myStats = (userId: string) =>
  asUser(userId, (db) =>
    rpc<{ running_sessions: number; strength_sessions: number; total_distance_m: number }>(db, 'get_my_workout_stats', [
      null,
      null,
      null,
    ]),
  );
const communityStats = (userId: string, communityId: string, window = '30d') =>
  asUser(userId, (db) => rpc<Community>(db, 'get_community_workout_stats', [communityId, window]));
const runPrompts = () => asService((db) => rpc<number>(db, 'enqueue_workout_log_prompts'));
const RUN = { distance_m: 10000, duration_s: 3000 };

async function endedEvent(
  organizerId: string,
  communityId: string,
  options: {
    kind?: EventKind;
    subtype?: string;
    going?: string[];
    endedMinutesAgo?: number;
    noEnd?: boolean;
    status?: 'confirmed' | 'completed' | 'cancelled';
    title?: string;
  } = {},
): Promise<EventSession> {
  const { kind = 'training', going = [], endedMinutesAgo = 60, noEnd = false, status = 'confirmed' } = options;
  const overrides: Record<string, unknown> = {};
  if (options.subtype) {
    overrides.event_subtype = options.subtype;
    if (kind === 'training') overrides.activity_type = options.subtype;
  }
  if (kind === 'training') overrides.min_participants = 1;
  if (options.title) overrides.title = options.title;
  const event = await createEvent(organizerId, communityId, kind, overrides);
  for (const id of going) await setRsvp(id, event.id, 'going');
  await admin.query(
    `update public.training_sessions
     set rsvp_deadline = now() - make_interval(mins => $2 + 180),
         starts_at = now() - make_interval(mins => $2 + 120),
         ends_at = case when $3::boolean then null else now() - make_interval(mins => $2) end,
         status = $4::public.session_status,
         attendance_finalized_at = case when $4 = 'completed' then now() end,
         cancel_reason = case when $4 = 'cancelled' then 'organizer'::public.cancel_reason end,
         cancelled_at = case when $4 = 'cancelled' then now() end
     where id = $1`,
    [event.id, endedMinutesAgo, noEnd, status],
  );
  return event;
}

async function storedCount(userId?: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    userId
      ? 'select count(*)::int as n from private.workout_logs where user_id = $1'
      : 'select count(*)::int as n from private.workout_logs',
    userId ? [userId] : [],
  );
  return rows[0].n;
}

async function promptsFor(sessionId: string): Promise<string[]> {
  const { rows } = await admin.query<{ user_id: string }>(
    "select user_id from public.notifications where kind = 'workout_log_prompt' and related_session_id = $1 order by user_id",
    [sessionId],
  );
  return rows.map((r) => r.user_id);
}

beforeEach(resetData);
afterAll(closeDb);

describe('QA: who can reach private.workout_logs', () => {
  // Every function body that mentions the table. A new reader of the table (a new way to leak a
  // log) shows up here and must be reviewed on purpose.
  const READERS = [
    // G3 (reviewed): reads only max(updated_at) of one account's logs as an activity signal; no
    // API role can execute it; its callers return counts / timestamps, never log content.
    'private.account_last_activity',
    'private.erase_user',
    'public.delete_my_workout_log',
    'public.enqueue_workout_log_prompts',
    'public.export_my_data',
    'public.get_community_workout_stats',
    'public.get_my_workout_log',
    'public.get_my_workout_stats',
    'public.list_my_workout_logs',
    'public.save_workout_log',
    'public.withdraw_consent',
  ];

  it('only the reviewed functions touch the table, no view or publication exposes it, no role holds a privilege', async () => {
    const { rows: fns } = await admin.query<{ name: string }>(
      `select n.nspname || '.' || p.proname as name
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname not in ('pg_catalog', 'information_schema')
         and p.prosrc ~* 'workout_logs'
       order by 1`,
    );
    const names = fns.map((r) => r.name);
    // Allow functions that only mention the purpose string 'workout_logs' (consent helpers).
    const unexpected = names.filter((n) => !READERS.includes(n));
    for (const name of unexpected) {
      const { rows } = await admin.query<{ src: string }>(
        `select p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname || '.' || p.proname = $1`,
        [name],
      );
      for (const { src } of rows) {
        expect(src, `${name} must only mention the consent purpose, not read the table`).not.toMatch(
          /(from|join|update|into)\s+private\.workout_logs/i,
        );
      }
    }
    for (const name of READERS) expect(names, name).toContain(name);

    const views = await admin.query(
      "select 1 from pg_views where definition ~* 'workout_logs' union all select 1 from pg_matviews where definition ~* 'workout_logs'",
    );
    expect(views.rows).toHaveLength(0);
    const published = await admin.query("select 1 from pg_publication_tables where tablename like 'workout_%'");
    expect(published.rows).toHaveLength(0);

    for (const role of ['anon', 'authenticated', 'service_role', 'public']) {
      for (const table of ['private.workout_logs', 'private.workout_prompt_runs']) {
        const { rows } = await admin.query<{ ok: boolean }>(
          role === 'public'
            ? `select exists (select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                              where c.oid = $1::regclass and a.grantee = 0) as ok`
            : `select has_any_column_privilege($1, $2::regclass, 'select,insert,update,references') as ok`,
          role === 'public' ? [table] : [role, table],
        );
        expect(rows[0].ok, `${role} on ${table}`).toBe(false);
      }
    }
    // Nobody can use the private schema's objects through the API either.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const { rows } = await admin.query<{ ok: boolean }>("select has_schema_privilege($1, 'private', 'usage') as ok", [role]);
      expect(rows[0].ok, `${role} usage on schema private`).toBe(false);
    }
  });

  it('member functions: authenticated only; the prompt job: service_role only', async () => {
    for (const fn of [
      'save_workout_log(uuid, jsonb)',
      'get_my_workout_log(uuid)',
      'delete_my_workout_log(uuid)',
      'list_my_workout_logs(integer, timestamptz)',
      'get_my_workout_stats(uuid, timestamptz, timestamptz)',
      'get_community_workout_stats(uuid, text)',
    ]) {
      const { rows } = await admin.query<{ a: boolean; s: boolean; u: boolean }>(
        `select has_function_privilege('anon', 'public.${fn}', 'execute') as a,
                has_function_privilege('service_role', 'public.${fn}', 'execute') as s,
                has_function_privilege('authenticated', 'public.${fn}', 'execute') as u`,
      );
      expect(rows[0], fn).toEqual({ a: false, s: false, u: true });
    }
    const { rows } = await admin.query<{ a: boolean; s: boolean; u: boolean }>(
      `select has_function_privilege('anon', 'public.enqueue_workout_log_prompts()', 'execute') as a,
              has_function_privilege('service_role', 'public.enqueue_workout_log_prompts()', 'execute') as s,
              has_function_privilege('authenticated', 'public.enqueue_workout_log_prompts()', 'execute') as u`,
    );
    expect(rows[0]).toEqual({ a: false, s: true, u: false });
    await expect(asAnon((db) => rpc(db, 'get_my_workout_log', ['00000000-0000-0000-0000-000000000000']))).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('members only ever reach their own log; another community and organizers get nothing', async () => {
    const a = await createPack(2);
    const b = await createPack(1);
    const [m1, m2] = a.memberIds;
    await grantConsents(m1, ['workout_logs']);
    await grantConsents(m2, ['workout_logs']);
    const event = await endedEvent(a.organizerId, a.communityId, { going: [m1, m2, a.organizerId] });
    await save(m1, event.id, { distance_m: 11111, duration_s: 4000, notes: 'private note of m1' });

    // m2 and the organizer see no log of m1, whatever they ask.
    expect((await getLog(m2, event.id)).log).toBeNull();
    expect((await getLog(a.organizerId, event.id)).log).toBeNull();
    // A member of another community learns nothing but "not a member".
    await expect(getLog(b.memberIds[0], event.id)).rejects.toMatchObject(raised('not_a_member'));
    await expect(save(b.memberIds[0], event.id, RUN)).rejects.toMatchObject(raised('not_a_member'));
    // Deleting by session id only ever touches the caller's own row.
    expect(await deleteLog(m2, event.id)).toMatchObject({ deleted: false });
    expect(await deleteLog(b.organizerId, event.id)).toMatchObject({ deleted: false });
    expect(await deleteLog(a.organizerId, event.id)).toMatchObject({ deleted: false });
    expect((await getLog(m1, event.id)).log?.notes).toBe('private note of m1');

    // Saving as m2 never touches m1's row (same event, same community).
    await save(m2, event.id, { distance_m: 2000 });
    expect((await getLog(m1, event.id)).log?.distance_m).toBe(11111);
    expect(await storedCount()).toBe(2);

    // Notes never reach notifications, even those of the prompt job.
    await runPrompts();
    const { rows } = await admin.query("select 1 from public.notifications where body ~* 'private note' or title ~* 'private note'");
    expect(rows).toHaveLength(0);
  });

  it('a removed member can still read and delete their own log, but not save', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, { going: [m], title: 'Original title' });
    await save(m, event.id, RUN);
    await removeMember(organizerId, communityId, m);
    await expect(save(m, event.id, RUN)).rejects.toMatchObject(raised('not_a_member'));
    expect(await getLog(m, event.id)).toMatchObject({ can_log: false, cannot_log_reason: 'not_a_member' });
    expect(await deleteLog(m, event.id)).toMatchObject({ deleted: true });
  });

  // DEFECT P5-QA-6 (low, FIXED): get_my_workout_log returned the CURRENT event (title, time,
  // status, distance) to a member who was removed or left, for as long as they hold a log. Now
  // `event` is null for a caller who is not an active member; the log carries its own snapshot.
  it('DEFECT P5-QA-6: a removed member does not see later edits of the event', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, { going: [m], title: 'Original title' });
    await save(m, event.id, RUN);
    await removeMember(organizerId, communityId, m);
    await admin.query("update public.training_sessions set title = 'Secret organizers meeting' where id = $1", [event.id]);
    const screen = await getLog(m, event.id);
    expect(JSON.stringify(screen)).not.toContain('Secret organizers meeting');
    expect(screen.event).toBeNull();
    expect(screen.log).toMatchObject({ distance_m: 10000 });
    expect(JSON.stringify(screen.log)).toContain('Original title');
  });
});

describe('QA: consent and erasure', () => {
  it('withdrawing then granting again does not resurrect logs; logs of a member without consent never count', async () => {
    const pack = await createPack(20);
    for (const id of pack.memberIds) await grantConsents(id, ['workout_logs']);
    const event = await endedEvent(pack.organizerId, pack.communityId, { going: pack.memberIds });
    for (const id of pack.memberIds) await save(id, event.id, RUN);
    expect((await communityStats(pack.organizerId, pack.communityId)).insufficient_data).toBe(false);

    // Defence in depth: a stray log of a member whose consent is withdrawn is not counted. The
    // withdrawal normally deletes it; here it is put back as a superuser would.
    const [first] = pack.memberIds;
    await asUser(first, (db) => rpc(db, 'withdraw_consent', ['workout_logs']));
    expect(await storedCount(first)).toBe(0);
    await admin.query(
      `insert into private.workout_logs (user_id, session_id, community_id, log_type, event_title, event_starts_at,
                                         event_kind, event_subtype, distance_m, duration_s)
       select $1, s.id, s.community_id, 'running', s.title, s.starts_at, s.event_kind, s.event_subtype, 10000, 3000
       from public.training_sessions s where s.id = $2`,
      [first, event.id],
    );
    expect((await communityStats(pack.organizerId, pack.communityId)).insufficient_data).toBe(true);
    await admin.query('delete from private.workout_logs where user_id = $1', [first]);

    await asUser(first, (db) => rpc(db, 'record_consent', ['workout_logs']));
    expect(await storedCount(first)).toBe(0);
    expect((await getLog(first, event.id)).log).toBeNull();
  });

  it('twelve parallel saves of the same log leave exactly one consistent row', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, { going: [m] });
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => save(m, event.id, { distance_m: 1000 * (i + 1), duration_s: 600 * (i + 1) })),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const { rows } = await admin.query<{ distance_m: number; duration_s: number; pace_s_per_km: number }>(
      'select distance_m, duration_s, pace_s_per_km from private.workout_logs where user_id = $1',
      [m],
    );
    expect(rows).toHaveLength(1);
    // One whole request won: distance and time belong together (always 600 s per km here).
    expect(rows[0].duration_s / rows[0].distance_m).toBeCloseTo(0.6);
    expect(rows[0].pace_s_per_km).toBe(600);
  });

  it('a save racing the deletion of the account never leaves an orphan log or an unexpected error', async () => {
    for (let i = 0; i < 4; i += 1) {
      const { communityId, organizerId, memberIds } = await createPack(2);
      const [m] = memberIds;
      await grantConsents(m, ['workout_logs']);
      const event = await endedEvent(organizerId, communityId, { going: [m] });
      const results = await Promise.allSettled([save(m, event.id, RUN), deleteMyAccount(m)]);
      for (const r of results) {
        if (r.status === 'rejected') {
          expect(['not_a_member', 'not_authenticated', 'not_found']).toContain((r.reason as { message: string }).message);
        }
      }
      expect(await storedCount(m)).toBe(0);
      const orphans = await admin.query(
        'select 1 from private.workout_logs l where not exists (select 1 from public.profiles p where p.id = l.user_id)',
      );
      expect(orphans.rows).toHaveLength(0);
    }
  });

  it('the export holds at most 5000 logs, says so, and the oldest come first', async () => {
    const { communityId, memberIds } = await createPack(1);
    const [m] = memberIds;
    await admin.query(
      `insert into private.workout_logs (user_id, session_id, community_id, log_type, event_title, event_starts_at,
                                         event_kind, event_subtype, distance_m, duration_s)
       select $1, gen_random_uuid(), $2, 'running', 'E' || g, now() - make_interval(mins => g), 'training', 'running', 1000, 600
       from generate_series(1, 5001) g`,
      [m, communityId],
    );
    const ex = await exportMyData(m);
    const logs = ex.extensions.workout_logs as { event_title: string; event_starts_at: string }[];
    expect(logs).toHaveLength(5000);
    expect(ex.truncated.workout_logs).toBe(true);
    // Oldest first: E5001 is the oldest, E1 (the newest) is the one left out.
    expect(logs[0].event_title).toBe('E5001');
    expect(logs.some((l) => l.event_title === 'E1')).toBe(false);
  });
});

describe('QA: validation against type confusion and hostile payloads', () => {
  async function setup(subtype: string) {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, { subtype, going: [m] });
    return { m, event };
  }

  it('running: strings, booleans, arrays, objects and exotic numbers are refused and store nothing', async () => {
    const { m, event } = await setup('running');
    const bad: [string, string][] = [
      ['{"distance_m":"5000"}', 'validation_failed:distance_m'],
      ['{"distance_m":true}', 'validation_failed:distance_m'],
      ['{"distance_m":[5000]}', 'validation_failed:distance_m'],
      ['{"distance_m":{"v":5000}}', 'validation_failed:distance_m'],
      ['{"distance_m":5000.5}', 'validation_failed:distance_m'],
      ['{"distance_m":-1}', 'validation_failed:distance_m'],
      ['{"distance_m":1e30}', 'validation_failed:distance_m'],
      ['{"distance_m":2147483648}', 'validation_failed:distance_m'],
      ['{"distance_m":5000,"distance_m":0}', 'validation_failed:distance_m'], // the last duplicate key wins
      ['{"duration_s":"1e3"}', 'validation_failed:duration_s'],
      ['{"duration_s":0.5}', 'validation_failed:duration_s'],
      ['{"distance_m":1000,"notes":{"a":1}}', 'validation_failed:notes'],
      ['{"distance_m":1000,"notes":["a"]}', 'validation_failed:notes'],
      ['{"distance_m":1000,"notes":true}', 'validation_failed:notes'],
      [`{"distance_m":1000,"notes":"${'x'.repeat(2_000_000)}"}`, 'validation_failed:notes'],
      ['{"distance_m":1000,"__proto__":{"x":1}}', 'validation_failed:input'],
      ['{"distance_m":1000,"Distance_M":5}', 'validation_failed:input'],
      ['[]', 'validation_failed:input'],
      ['"distance_m"', 'validation_failed:input'],
      ['5', 'validation_failed:input'],
      ['null', 'validation_failed:input'],
    ];
    for (const [raw, message] of bad) {
      await expect(saveRaw(m, event.id, raw), raw.slice(0, 80)).rejects.toMatchObject(raised(message));
    }
    // Payloads the JSON parser itself refuses: an error, never a stored row.
    for (const raw of [
      '{"distance_m":1000,"notes":"a\\u0000b"}',
      `{"distance_m":1000,"notes":${'['.repeat(3000)}${']'.repeat(3000)}}`,
      '{"distance_m":1e999999999}',
    ]) {
      await expect(saveRaw(m, event.id, raw), raw.slice(0, 60)).rejects.toBeTruthy();
    }
    expect(await storedCount(m)).toBe(0);

    // Accepted spellings of the same integers.
    await expect(saveRaw(m, event.id, '{"distance_m":5000.0,"duration_s":3e3}')).resolves.toMatchObject({
      distance_m: 5000,
      duration_s: 3000,
    });
    // Duplicate keys: the last one wins, as in every JSON parser.
    await expect(saveRaw(m, event.id, '{"distance_m":0,"distance_m":7000}')).resolves.toMatchObject({ distance_m: 7000 });
    // An explicit null clears a field, an absent key too (whole-log replacement).
    await expect(saveRaw(m, event.id, '{"distance_m":null,"duration_s":900}')).resolves.toMatchObject({
      distance_m: null,
      duration_s: 900,
    });
  });

  it('strength: nested junk, wrong types, fractional reps and weights are refused', async () => {
    const { m, event } = await setup('strength');
    const ok = '{"name":"Squat","sets":[{"reps":5,"weight_kg":100}]}';
    const bad: [string, string][] = [
      [`{"exercises":{"name":"Squat"}}`, 'validation_failed:exercises'],
      [`{"exercises":[[${ok}]]}`, 'validation_failed:exercises'],
      [`{"exercises":[${ok}],"exercises":[]}`, 'validation_failed:exercises'], // last duplicate wins: empty
      [`{"exercises":[{"name":5,"sets":[{"reps":1}]}]}`, 'validation_failed:exercise_name'],
      [`{"exercises":[{"name":["a"],"sets":[{"reps":1}]}]}`, 'validation_failed:exercise_name'],
      [`{"exercises":[{"name":{"a":1},"sets":[{"reps":1}]}]}`, 'validation_failed:exercise_name'],
      [`{"exercises":[{"name":"x","sets":{"reps":1}}]}`, 'validation_failed:sets'],
      [`{"exercises":[{"name":"x","sets":[[1]]}]}`, 'validation_failed:sets'],
      [`{"exercises":[{"name":"x","sets":[{"reps":true}]}]}`, 'validation_failed:reps'],
      [`{"exercises":[{"name":"x","sets":[{"reps":null}]}]}`, 'validation_failed:reps'],
      [`{"exercises":[{"name":"x","sets":[{"reps":[1]}]}]}`, 'validation_failed:reps'],
      [`{"exercises":[{"name":"x","sets":[{"reps":1e1000}]}]}`, 'validation_failed:reps'],
      [`{"exercises":[{"name":"x","sets":[{"reps":1,"weight_kg":0.30000000000000004}]}]}`, 'validation_failed:weight_kg'],
      [`{"exercises":[{"name":"x","sets":[{"reps":1,"weight_kg":1e-30}]}]}`, 'validation_failed:weight_kg'],
      [`{"exercises":[{"name":"x","sets":[{"reps":1,"weight_kg":[5]}]}]}`, 'validation_failed:weight_kg'],
      [`{"exercises":[{"name":"x","sets":[{"reps":1,"weight_kg":false}]}]}`, 'validation_failed:weight_kg'],
      [`{"exercises":[{"name":"x","sets":[{"reps":1,"weight_kg":1e9}]}]}`, 'validation_failed:weight_kg'],
      [`{"exercises":[{"name":"x","sets":[{"reps":1,"weight_kg":-0.0000001}]}]}`, 'validation_failed:weight_kg'],
      [`{"exercises":[{"name":"x","sets":[{"reps":1}],"id":"x"}]}`, 'validation_failed:exercises'],
      [`{"exercises":[{"name":"x\\ty\\nz","sets":[{"reps":1}]}],"notes":null,"extra":1}`, 'validation_failed:input'],
    ];
    for (const [raw, message] of bad) {
      await expect(saveRaw(m, event.id, raw), raw.slice(0, 90)).rejects.toMatchObject(raised(message));
    }
    expect(await storedCount(m)).toBe(0);

    // A tab or newline inside an exercise name is whitespace, not a second line.
    const stored = await saveRaw(m, event.id, `{"exercises":[{"name":"Bench\\tpress\\nnarrow","sets":[{"reps":1e0,"weight_kg":100.00}]}]}`);
    expect(stored.exercises).toEqual([{ name: 'Bench press narrow', sets: [{ reps: 1, weight_kg: 100 }] }]);
  });

  it('pace and totals: no division by zero, nothing overflows at the limits', async () => {
    const { m, event } = await setup('running');
    // The extreme field values alone are accepted (no pace), and the largest plausible combinations.
    expect(await saveRaw(m, event.id, '{"distance_m":1000000}')).toMatchObject({ pace_s_per_km: null });
    expect(await saveRaw(m, event.id, '{"duration_s":604800}')).toMatchObject({ pace_s_per_km: null });
    expect(await saveRaw(m, event.id, '{"duration_s":60000,"distance_m":1000000}')).toMatchObject({ pace_s_per_km: 60 });
    expect(await saveRaw(m, event.id, '{"duration_s":604800,"distance_m":336000}')).toMatchObject({ pace_s_per_km: 1800 });
    // The extreme combinations are implausible (P5-QA-7) and refused.
    await expect(saveRaw(m, event.id, '{"duration_s":1,"distance_m":1000000}')).rejects.toMatchObject(raised('validation_failed:duration_s'));
    await expect(saveRaw(m, event.id, '{"duration_s":604800,"distance_m":1}')).rejects.toMatchObject(raised('validation_failed:duration_s'));
    await expect(saveRaw(m, event.id, '{"duration_s":600,"distance_m":0}')).rejects.toMatchObject(raised('validation_failed:distance_m'));
    // The previous valid log survives a refused save.
    expect((await getLog(m, event.id)).log?.pace_s_per_km).toBe(1800);
    const stats = await myStats(m);
    expect(stats.total_distance_m).toBe(336000);
  });

  // P5-QA-7 (low, FIXED): nothing checked that a log is plausible; one member could log 1000 km in
  // one second and dominate the organizers' totals and average pace. Now a log with both a distance
  // and a time must have a pace between 1:00 and 30:00 min/km (validation_failed:duration_s).
  it('P5-QA-7: an implausible log (1000 km in one second, 1 m in 7 days) is refused and stores nothing', async () => {
    const { m, event } = await setup('running');
    for (const input of [
      { distance_m: 1_000_000, duration_s: 1 },
      { distance_m: 1, duration_s: 604800 },
      { distance_m: 42195, duration_s: 2531 }, // marathon in 42:11 (0:59.98 /km)
      { distance_m: 5000, duration_s: 9001 }, // 5 km in 2.5 hours (30:00.2 /km)
    ]) {
      await expect(save(m, event.id, input), JSON.stringify(input)).rejects.toMatchObject(raised('validation_failed:duration_s'));
    }
    expect(await storedCount(m)).toBe(0);
    // Just inside the range on both ends.
    expect(await save(m, event.id, { distance_m: 42195, duration_s: 2532 })).toMatchObject({ pace_s_per_km: 60 });
    expect(await save(m, event.id, { distance_m: 5000, duration_s: 9000 })).toMatchObject({ pace_s_per_km: 1800 });
  });
});

describe('QA: log type follows the event, also when the event changes later', () => {
  it('an edit of the subtype after a log exists: the stored log keeps its type until it is saved again', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, { subtype: 'running', going: [m] });
    await save(m, event.id, RUN);

    await admin.query("update public.training_sessions set event_subtype = 'strength' where id = $1", [event.id]);
    const screen = await getLog(m, event.id);
    // The screen now asks for a strength form while the stored log is a run: the app form starts
    // empty (the stored distance and time are not shown) until the member saves a new log.
    expect(screen).toMatchObject({ log_type: 'strength', can_log: true });
    expect(screen.log).toMatchObject({ log_type: 'running', distance_m: 10000 });
    expect(await myStats(m)).toMatchObject({ running_sessions: 1, strength_sessions: 0, total_distance_m: 10000 });

    // Saving again replaces the log completely with the new type; nothing of the run survives.
    const replaced = await save(m, event.id, { exercises: [{ name: 'Squat', sets: [{ reps: 5, weight_kg: 100 }] }] });
    expect(replaced).toMatchObject({ log_type: 'strength', distance_m: null, duration_s: null, pace_s_per_km: null });
    expect(await myStats(m)).toMatchObject({ running_sessions: 0, strength_sessions: 1, total_distance_m: 0 });
  });

  it('an event that becomes cancelled after logging keeps the log (readable, deletable) but leaves the totals', async () => {
    const pack = await createPack(20);
    for (const id of pack.memberIds) await grantConsents(id, ['workout_logs']);
    const event = await endedEvent(pack.organizerId, pack.communityId, { going: pack.memberIds });
    for (const id of pack.memberIds) await save(id, event.id, RUN);
    await runPrompts();
    expect((await communityStats(pack.organizerId, pack.communityId)).insufficient_data).toBe(false);
    await admin.query(
      "update public.training_sessions set status = 'cancelled', cancel_reason = 'organizer', cancelled_at = now() where id = $1",
      [event.id],
    );
    expect((await communityStats(pack.organizerId, pack.communityId)).insufficient_data).toBe(true);
    const [m] = pack.memberIds;
    expect(await getLog(m, event.id)).toMatchObject({ can_log: false, cannot_log_reason: 'not_loggable' });
    await expect(save(m, event.id, RUN)).rejects.toMatchObject(raised('not_loggable'));
    expect(await deleteLog(m, event.id)).toMatchObject({ deleted: true });
  });
});

describe('QA: the prompt job', () => {
  it('end + 15 minutes also holds when ends_at is empty (start + 2 hours)', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    const early = await endedEvent(organizerId, communityId, { going: [m], noEnd: true, endedMinutesAgo: 14 });
    const due = await endedEvent(organizerId, communityId, { going: [m], noEnd: true, endedMinutesAgo: 16 });
    expect(await runPrompts()).toBe(1);
    expect(await promptsFor(early.id)).toEqual([]);
    expect(await promptsFor(due.id)).toEqual([m]);
  });

  it('only going members are prompted: a walk-in marked present is not, a going member marked absent is', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const [walkIn, noShow] = memberIds;
    const event = await endedEvent(organizerId, communityId, { going: [noShow], status: 'completed' });
    await admin.query(
      `insert into public.attendance_records (session_id, community_id, user_id, status, had_rsvp_going, is_walk_in)
       values ($1, $2, $3, 'present', false, true), ($1, $2, $4, 'absent', true, false)`,
      [event.id, communityId, walkIn, noShow],
    );
    expect(await runPrompts()).toBe(1);
    expect(await promptsFor(event.id)).toEqual([noShow]);
    // The walk-in can still log (eligible by attendance), only the reminder is missing.
    await grantConsents(walkIn, ['workout_logs']);
    await expect(save(walkIn, event.id, RUN)).resolves.toMatchObject({ distance_m: 10000 });
  });

  it('an event cancelled after its prompts went out keeps the stale notification; logging is refused', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, { going: [m] });
    expect(await runPrompts()).toBe(1);
    await admin.query(
      "update public.training_sessions set status = 'cancelled', cancel_reason = 'organizer', cancelled_at = now() where id = $1",
      [event.id],
    );
    expect(await runPrompts()).toBe(0);
    expect(await promptsFor(event.id)).toEqual([m]);
    await expect(save(m, event.id, RUN)).rejects.toMatchObject(raised('not_loggable'));
  });

  // P5-QA-8 (low, FIXED): the first run after deployment (and any outage of up to 7 days) sent one
  // prompt (and one push) per event of the last 7 days to every member who was going. Now only
  // events that ended within the last 48 hours are back-filled; older ones are never prompted.
  it('P5-QA-8: a first run back-fills only the events of the last 48 hours', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    const events: EventSession[] = [];
    for (let day = 0; day < 7; day += 1) {
      events.push(await endedEvent(organizerId, communityId, { going: [m], endedMinutesAgo: 30 + day * 24 * 60 }));
    }
    // Ended 30 min, 24 h 30 min ago: prompted; 48 h 30 min ago and older: not.
    expect(await runPrompts()).toBe(2);
    const { rows } = await admin.query<{ n: number }>(
      "select count(*)::int as n from public.notification_delivery_jobs j join public.notifications n on n.id = j.notification_id where j.user_id = $1 and n.kind = 'workout_log_prompt'",
      [m],
    );
    expect(rows[0].n).toBe(2);
    for (const [day, e] of events.entries()) expect(await promptsFor(e.id), `day ${day}`).toEqual(day < 2 ? [m] : []);
    // Later runs never pick up the older events either.
    expect(await runPrompts()).toBe(0);
  });

  it('deep links: look-alikes of /events/<uuid>/log are refused by the database check', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const event = await endedEvent(organizerId, communityId, {});
    const id = event.id;
    const insert = (link: string) =>
      admin.query(
        `insert into public.notifications (user_id, community_id, kind, title, body, deep_link, related_session_id, dedupe_key)
         values ($1, $2, 'workout_log_prompt', 't', 'b', $3, $4, gen_random_uuid()::text)`,
        [memberIds[0], communityId, link, id],
      );
    await insert(`/events/${id}/log`);
    const bad = [
      `/events/${id}/log/`,
      `/events/${id}/log?x=1`,
      `/events/${id}/log#x`,
      `/events/${id}/log\n`,
      `/events/${id}/log/extra`,
      `/events/${id}/LOG`,
      `/events/${id}/log `,
      ` /events/${id}/log`,
      `//events/${id}/log`,
      `/events/${id}//log`,
      `/events/${id.slice(0, 35)}/log`,
      `/events/${id}0/log`,
      `/events/${id.replace(/./, 'g')}/log`,
      `/events/../log`,
      `/events/${id}/%6cog`,
      `/event/${id}/log`,
      `https://evil.example/events/${id}/log`,
      `/events/${id}/log/../../x`,
    ];
    for (const link of bad) await expect(insert(link), JSON.stringify(link)).rejects.toMatchObject({ code: '23514' });
  });
});

describe('QA: community totals and what an organizer can work out', () => {
  async function logged(contributors: number) {
    const pack = await createPack(contributors);
    for (const id of pack.memberIds) await grantConsents(id, ['workout_logs']);
    return pack;
  }

  const WINDOWS = ['7d', '30d', '90d', 'all'] as const;

  /** Every pair of published distances (both windows published) differs from `value` by more than 1 km. */
  async function noPairReveals(organizerId: string, communityId: string, value: number) {
    const answers: { window: (typeof WINDOWS)[number]; stats: Community }[] = [];
    for (const window of WINDOWS) answers.push({ window, stats: await communityStats(organizerId, communityId, window) });
    for (const a of answers) {
      for (const b of answers) {
        if (a.window === b.window || a.stats.total_distance_km === null || b.stats.total_distance_km === null) continue;
        const difference = a.stats.total_distance_km - b.stats.total_distance_km;
        expect(Math.abs(difference - value), `${a.window} - ${b.window}`).toBeGreaterThan(1);
      }
    }
    return Object.fromEntries(answers.map((a) => [a.window, a.stats])) as Record<(typeof WINDOWS)[number], Community>;
  }

  it('the organizer is one of the contributors when they log; other communities never mix in', async () => {
    const a = await createPack(19);
    const b = await createPack(20);
    for (const id of [...a.memberIds, a.organizerId, ...b.memberIds]) await grantConsents(id, ['workout_logs']);
    const ea = await endedEvent(a.organizerId, a.communityId, { going: [...a.memberIds, a.organizerId] });
    const eb = await endedEvent(b.organizerId, b.communityId, { going: b.memberIds });
    for (const id of [...a.memberIds, a.organizerId]) await save(id, ea.id, { distance_m: 4000, duration_s: 1200 });
    for (const id of b.memberIds) await save(id, eb.id, { distance_m: 40000, duration_s: 12000 });
    const stats = await communityStats(a.organizerId, a.communityId);
    expect(stats).toMatchObject({ insufficient_data: false, members_contributing: 20, total_distance_km: 80 }); // 20 x 4 km, nothing of B
    await expect(communityStats(a.organizerId, b.communityId)).rejects.toMatchObject(raised('forbidden'));
  });

  // DEFECT P5-QA-1 (medium, design; same class as P3-QA-1; FIXED): the "5 contributing members"
  // rule was defeated by an organizer who controls the other contributors: four sock-puppet
  // members who log a known distance plus one real member made "5 contributors", and the published
  // total minus the puppets' values was that one member's distance to within 1 km. Now the floor
  // is 20 (as for demographics) and distance is rounded to 10 km.
  it('DEFECT P5-QA-1: five contributors (four of them controlled by the organizer) must not publish a total', async () => {
    const pack = await createPack(5);
    for (const id of pack.memberIds) await grantConsents(id, ['workout_logs']);
    const event = await endedEvent(pack.organizerId, pack.communityId, { going: pack.memberIds });
    const [victim, ...puppets] = pack.memberIds;
    await save(victim, event.id, { distance_m: 21000, duration_s: 7200 });
    for (const puppet of puppets) await save(puppet, event.id, { distance_m: 5000, duration_s: 1500 });
    const stats = await communityStats(pack.organizerId, pack.communityId);
    // Total 41 km minus 4 x 5 km of the puppets = the victim's 21 km.
    expect(stats.total_distance_km).toBeNull();
  });

  // KNOWN LIMIT (P5-QA-1, documented in STATS_DEFINITIONS.md): an organizer who controls 19
  // accounts can still subtract their known values; the floor makes that costlier and the 10 km /
  // 30 min rounding is all that is left between the published total and the one real member.
  it('KNOWN LIMIT P5-QA-1: 19 puppets + 1 member reveal that member only to within the rounding (10 km)', async () => {
    const pack = await logged(20);
    const event = await endedEvent(pack.organizerId, pack.communityId, { going: pack.memberIds });
    const [victim, ...puppets] = pack.memberIds;
    await save(victim, event.id, { distance_m: 21000, duration_s: 7200 });
    for (const puppet of puppets) await save(puppet, event.id, { distance_m: 5000, duration_s: 1500 });
    const stats = await communityStats(pack.organizerId, pack.communityId);
    // 116 km -> 120; 120 - 95 = 25 km, the true 21 km is somewhere in [20, 30).
    expect(stats.total_distance_km).toBe(120);
    expect(stats.total_distance_km! % 10).toBe(0);
  });

  // DEFECT P5-QA-2 (medium, FIXED): the windows are nested (7d inside 30d inside 90d inside all)
  // and each was only checked for its OWN contributor count; five members logging this week plus
  // one member who logged 14 days ago made 7d and 30d both publishable, and their difference was
  // exactly that member's log. Now a window is published only when the members with a log in the
  // band between it and the next smaller published window number 0 or at least 20.
  it('DEFECT P5-QA-2: the difference between two windows must not isolate one member', async () => {
    // The original scenario (5 this week + 1 member 14 days ago): nothing is published at all.
    const small = await logged(6);
    const recent = await endedEvent(small.organizerId, small.communityId, { going: small.memberIds.slice(0, 5) });
    const old = await endedEvent(small.organizerId, small.communityId, {
      going: [small.memberIds[5]],
      endedMinutesAgo: 14 * 24 * 60,
    });
    for (const id of small.memberIds.slice(0, 5)) await save(id, recent.id, { distance_m: 10000, duration_s: 3000 });
    await save(small.memberIds[5], old.id, { distance_m: 14000, duration_s: 4200 });
    const smallAnswers = await noPairReveals(small.organizerId, small.communityId, 14);
    for (const window of WINDOWS) expect(smallAnswers[window].insufficient_data, window).toBe(true);

    // The same at the new floor: 20 members this week + 1 member 14 days ago.
    await resetData();
    const pack = await logged(21);
    const week = await endedEvent(pack.organizerId, pack.communityId, { going: pack.memberIds.slice(0, 20) });
    const earlier = await endedEvent(pack.organizerId, pack.communityId, {
      going: [pack.memberIds[20]],
      endedMinutesAgo: 14 * 24 * 60,
    });
    for (const id of pack.memberIds.slice(0, 20)) await save(id, week.id, { distance_m: 10000, duration_s: 3000 });
    await save(pack.memberIds[20], earlier.id, { distance_m: 14000, duration_s: 4200 });
    const answers = await noPairReveals(pack.organizerId, pack.communityId, 14);
    expect(answers['7d'].insufficient_data).toBe(false);
    // 30d (and every larger window) differs from 7d by one member: suppressed.
    expect(answers['30d'].insufficient_data).toBe(true);
    expect(answers['90d'].insufficient_data).toBe(true);
    expect(answers.all.insufficient_data).toBe(true);
  });

  it('nested windows: an older log of a member who is also in the smaller window cannot be isolated', async () => {
    const pack = await logged(20);
    const week = await endedEvent(pack.organizerId, pack.communityId, { going: pack.memberIds });
    const earlier = await endedEvent(pack.organizerId, pack.communityId, {
      going: [pack.memberIds[0]],
      endedMinutesAgo: 14 * 24 * 60,
    });
    for (const id of pack.memberIds) await save(id, week.id, { distance_m: 10000, duration_s: 3000 });
    await save(pack.memberIds[0], earlier.id, { distance_m: 14000, duration_s: 4200 });
    const answers = await noPairReveals(pack.organizerId, pack.communityId, 14);
    expect(answers['7d'].insufficient_data).toBe(false);
    expect(answers['30d'].insufficient_data).toBe(true);
  });

  it('nested windows: a suppressed middle window does not let 90d be compared with 7d either', async () => {
    // 20 this week, 1 member 14 days ago (30d band), 20 more members 60 days ago (90d band).
    const pack = await logged(41);
    const week = await endedEvent(pack.organizerId, pack.communityId, { going: pack.memberIds.slice(0, 20) });
    const earlier = await endedEvent(pack.organizerId, pack.communityId, {
      going: [pack.memberIds[20]],
      endedMinutesAgo: 14 * 24 * 60,
    });
    const older = await endedEvent(pack.organizerId, pack.communityId, {
      going: pack.memberIds.slice(21),
      endedMinutesAgo: 60 * 24 * 60,
    });
    for (const id of pack.memberIds.slice(0, 20)) await save(id, week.id, { distance_m: 10000, duration_s: 3000 });
    await save(pack.memberIds[20], earlier.id, { distance_m: 14000, duration_s: 4200 });
    for (const id of pack.memberIds.slice(21)) await save(id, older.id, { distance_m: 10000, duration_s: 3000 });
    const answers = await noPairReveals(pack.organizerId, pack.communityId, 14);
    expect(answers['7d']).toMatchObject({ insufficient_data: false, total_distance_km: 200 });
    expect(answers['30d'].insufficient_data).toBe(true);
    // 90d minus 7d covers 21 members (the one of 14 days ago among them): published.
    expect(answers['90d']).toMatchObject({ insufficient_data: false, members_contributing: 40, total_distance_km: 410 });
  });

  // DEFECT P5-QA-3 (medium, same root cause; FIXED at the rounding granularity): totals before and
  // after the organizer REMOVES a member differed by that member's contribution to within 1 km /
  // 5 min. Now the floor is 20 and the distance is rounded to 10 km (time to 30 min): one removal
  // reveals the member's contribution only to within that rounding (the documented limit).
  it("DEFECT P5-QA-3: removing a member must not reveal that member's distance", async () => {
    const pack = await logged(21);
    const event = await endedEvent(pack.organizerId, pack.communityId, { going: pack.memberIds });
    const [victim, ...others] = pack.memberIds;
    await save(victim, event.id, { distance_m: 12300, duration_s: 4000 });
    for (const id of others) await save(id, event.id, { distance_m: 10000, duration_s: 3000 });
    const before = await communityStats(pack.organizerId, pack.communityId);
    await removeMember(pack.organizerId, pack.communityId, victim);
    const after = await communityStats(pack.organizerId, pack.communityId);
    expect(after.insufficient_data).toBe(false);
    const revealed = (before.total_distance_km ?? 0) - (after.total_distance_km ?? 0);
    expect(Math.abs(revealed - 12.3)).toBeGreaterThan(1);
    expect(revealed % 10).toBe(0);
  });

  it('removing a member whose contribution is below the rounding changes nothing visible', async () => {
    const pack = await logged(21);
    const event = await endedEvent(pack.organizerId, pack.communityId, { going: pack.memberIds });
    const [victim, ...others] = pack.memberIds;
    await save(victim, event.id, { distance_m: 4000, duration_s: 1200 });
    for (const id of others) await save(id, event.id, { distance_m: 10000, duration_s: 3000 });
    const before = await communityStats(pack.organizerId, pack.communityId);
    await removeMember(pack.organizerId, pack.communityId, victim);
    const after = await communityStats(pack.organizerId, pack.communityId);
    // 204 km -> 200 and 200 km -> 200; 1020 min -> 1020 and 1000 min -> 990 (time to 30 min).
    expect(before).toMatchObject({ total_distance_km: 200, members_contributing: 20, average_pace_s_per_km: 300 });
    expect(after).toMatchObject({ total_distance_km: 200, members_contributing: 20, average_pace_s_per_km: 300 });
  });

  it('a single dominating contributor cannot be told apart from the rounding, but the totals do follow it', async () => {
    const pack = await logged(20);
    const event = await endedEvent(pack.organizerId, pack.communityId, { going: pack.memberIds });
    const [big, ...small] = pack.memberIds;
    await save(big, event.id, { distance_m: 100000, duration_s: 36000 });
    for (const id of small) await save(id, event.id, { distance_m: 1000, duration_s: 400 });
    const stats = await communityStats(pack.organizerId, pack.communityId);
    // 119 km in total -> 120: the one large log is 84 % of the number an organizer sees.
    expect(stats.total_distance_km).toBe(120);
  });

  it('rounding and threshold arithmetic at the edges (19/20/22/23 members, x.5 values)', async () => {
    for (const [members, shownMembers] of [
      [19, null],
      [20, 20],
      [22, 20],
      [23, 25],
    ] as const) {
      await resetData();
      const pack = await createPack(members);
      for (const id of pack.memberIds) await grantConsents(id, ['workout_logs']);
      const event = await endedEvent(pack.organizerId, pack.communityId, { going: pack.memberIds });
      for (const id of pack.memberIds) await save(id, event.id, { distance_m: 750, duration_s: 225 });
      const stats = await communityStats(pack.organizerId, pack.communityId);
      expect(stats.members_contributing, `${members} members`).toBe(shownMembers);
      if (shownMembers !== null) {
        // members x 0.75 km to the nearest 10 km (20 members: 15 km, half-way, rounds up to 20);
        // members x 3.75 min to the nearest 30 min (20 members: 75 min, half-way, rounds up to 90).
        expect(stats.total_distance_km).toBe(Math.round((members * 0.75) / 10 + 1e-9) * 10);
        expect(stats.total_duration_minutes).toBe(Math.round((members * 3.75) / 30 + 1e-9) * 30);
        expect(stats.total_distance_km! % 10).toBe(0);
        expect(stats.total_duration_minutes! % 30).toBe(0);
        expect(stats.average_pace_s_per_km! % 10).toBe(0);
        expect(stats.average_pace_s_per_km).toBe(300);
      } else {
        expect(stats).toMatchObject({ insufficient_data: true, total_distance_km: null, total_duration_minutes: null });
      }
    }
  });
});
