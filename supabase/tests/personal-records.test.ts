import type { PoolClient } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { deleteMyAccount, exportMyData, leaveCommunity } from './account-deletion-helpers';
import { createEvent, type EventKind, type EventSession } from './events-helpers';
import {
  addMember,
  admin,
  asAnon,
  asRole,
  asService,
  asUser,
  closeDb,
  createPack,
  grantConsents,
  INSUFFICIENT_PRIVILEGE,
  RAISED,
  resetData,
  rpc,
  setRsvp,
} from './helpers';

/**
 * Personal records (migration 20261205000100_personal_records.sql). Contract: docs/API_CONTRACT.md
 * ("Personal records"); definitions: docs/STATS_DEFINITIONS.md ("Personal records").
 */

type Lift = 'deadlift' | 'bench_press' | 'back_squat' | 'front_squat' | 'strict_press' | 'push_press';

type Candidate = {
  lift: Lift;
  label: string;
  reps: number;
  weight_kg: number;
  confirmed: boolean;
  confirmed_weight_kg: number | null;
  previous_best_kg: number | null;
  is_new_record: boolean;
};
type Candidates = {
  session_id: string;
  log_type: string;
  event_title: string;
  event_starts_at: string;
  has_consent: boolean;
  candidates: Candidate[];
};
type Confirmation = { lift: Lift; reps: number; weight_kg: number; confirmed: boolean; is_new_record: boolean };
type Rm = {
  weight_kg: number;
  session_id: string;
  event_title: string;
  event_starts_at: string;
  achieved_at: string;
  confirmed_at: string;
} | null;
type RunningBest = {
  distance_m: number;
  time_s: number;
  pace_s_per_km: number;
  logged_distance_m: number;
  logged_duration_s: number;
  session_id: string;
  event_title: string;
  event_starts_at: string;
  log_type: string;
} | null;
type Longest = {
  distance_m: number;
  duration_s: number | null;
  pace_s_per_km: number | null;
  session_id: string;
  event_title: string;
  event_starts_at: string;
  log_type: string;
} | null;
type Records = {
  running: { best_5k: RunningBest; best_10k: RunningBest; best_half: RunningBest; best_marathon: RunningBest; longest: Longest };
  lifts: { lift: Lift; label: string; one_rm: Rm; two_rm: Rm; three_rm: Rm }[];
};

const raised = (message: string) => ({ code: RAISED, message });
const denied = { code: INSUFFICIENT_PRIVILEGE };

const save = (userId: string, sessionId: string, input: unknown) =>
  asUser(userId, (db) => rpc(db, 'save_workout_log', [sessionId, JSON.stringify(input)]));
const candidates = (userId: string, sessionId: string | null) =>
  asUser(userId, (db) => rpc<Candidates>(db, 'get_max_effort_candidates', [sessionId]));
const confirm = (
  userId: string,
  sessionId: string | null,
  lift: string | null,
  reps: number | null,
  weight: number | null,
  confirmed: boolean | null = true,
) => asUser(userId, (db) => rpc<Confirmation>(db, 'confirm_max_effort', [sessionId, lift, reps, weight, confirmed]));
const records = (userId: string) => asUser(userId, (db) => rpc<Records>(db, 'get_my_personal_records'));
const withdraw = (userId: string) => asUser(userId, (db) => rpc(db, 'withdraw_consent', ['workout_logs']));
const deleteLog = (userId: string, sessionId: string) =>
  asUser(userId, (db) => rpc(db, 'delete_my_workout_log', [sessionId]));
const normalize = async (name: string | null): Promise<string | null> => {
  const { rows } = await admin.query<{ k: string | null }>('select private.normalize_lift_name($1) as k', [name]);
  return rows[0].k;
};

async function stored(userId: string): Promise<{ session_id: string; lift: string; reps: number; weight_kg: string }[]> {
  const { rows } = await admin.query(
    'select session_id, lift, reps, weight_kg from private.lift_max_efforts where user_id = $1 order by lift, reps',
    [userId],
  );
  return rows;
}

/** A strength (default) or running event created through the real RPC, the member going, moved into the past. */
async function endedEvent(
  organizerId: string,
  communityId: string,
  going: string[],
  options: { kind?: EventKind; subtype?: string; title?: string; startedDaysAgo?: number } = {},
): Promise<EventSession> {
  const { kind = 'training', subtype = 'strength', startedDaysAgo = 1 } = options;
  const overrides: Record<string, unknown> = {};
  if (kind === 'training') {
    overrides.event_subtype = subtype;
    overrides.activity_type = subtype;
    overrides.min_participants = 1;
  }
  if (options.title) overrides.title = options.title;
  const event = await createEvent(organizerId, communityId, kind, overrides);
  for (const id of going) await setRsvp(id, event.id, 'going');
  await admin.query(
    `update public.training_sessions
     set rsvp_deadline = now() - make_interval(days => $2, hours => 1),
         starts_at = now() - make_interval(days => $2),
         ends_at = now() - make_interval(days => $2) + interval '1 hour',
         status = 'confirmed'
     where id = $1`,
    [event.id, startedDaysAgo],
  );
  return event;
}

/** A log written directly (superuser), for selection scenarios. Returns its session id. */
async function insertLog(
  userId: string,
  log: {
    type: 'running' | 'race' | 'strength';
    distance_m?: number | null;
    duration_s?: number | null;
    exercises?: unknown;
    startsAt: string;
    title?: string;
  },
): Promise<string> {
  const { rows } = await admin.query<{ session_id: string }>(
    `insert into private.workout_logs (user_id, session_id, community_id, log_type, event_title, event_starts_at,
       event_kind, event_subtype, distance_m, duration_s, exercises, strength_volume_kg)
     values ($1, gen_random_uuid(), gen_random_uuid(), $2, $3, $4,
       case when $2 = 'race' then 'race' else 'training' end::public.event_kind,
       case when $2 = 'strength' then 'strength' else 'running' end,
       $5, $6, $7::jsonb, case when $2 = 'strength' then 0 end)
     returning session_id`,
    [
      userId,
      log.type,
      log.title ?? `${log.type} ${log.startsAt}`,
      log.startsAt,
      log.distance_m ?? null,
      log.duration_s ?? null,
      log.type === 'strength' ? JSON.stringify(log.exercises ?? []) : null,
    ],
  );
  return rows[0].session_id;
}

const lifts = (...items: [string, [number, number][]][]) => ({
  exercises: items.map(([name, sets]) => ({ name, sets: sets.map(([reps, weight_kg]) => ({ reps, weight_kg })) })),
});

beforeEach(resetData);
afterAll(closeDb);

describe('private.normalize_lift_name', () => {
  const TABLE: [string | null, string | null][] = [
    // Canonical names the app saves from its exercise list (owner decision 2026-11-26), any case.
    ['Deadlift', 'deadlift'],
    ['Bench press', 'bench_press'],
    ['Back squat', 'back_squat'],
    ['Front squat', 'front_squat'],
    ['Strict press', 'strict_press'],
    ['Push press', 'push_press'],
    ['DEADLIFT', 'deadlift'],
    ['bench PRESS', 'bench_press'],
    ['BACK SQUAT', 'back_squat'],
    ['front Squat', 'front_squat'],
    ['STRICT PRESS', 'strict_press'],
    ['push PRESS', 'push_press'],
    // Synonyms.
    ['deadlift', 'deadlift'],
    ['dl', 'deadlift'],
    ['DL', 'deadlift'],
    ['conventional deadlift', 'deadlift'],
    ['bench', 'bench_press'],
    ['bp', 'bench_press'],
    ['flat bench', 'bench_press'],
    ['squat', 'back_squat'],
    ['bs', 'back_squat'],
    ['high bar squat', 'back_squat'],
    ['low bar squat', 'back_squat'],
    ['fs', 'front_squat'],
    ['press', 'strict_press'],
    ['overhead press', 'strict_press'],
    ['ohp', 'strict_press'],
    ['military press', 'strict_press'],
    ['shoulder press', 'strict_press'],
    ['pp', 'push_press'],
    // Whitespace, punctuation, separators.
    ['  Deadlift  ', 'deadlift'],
    ['Bench   press', 'bench_press'],
    ['Bench\tpress', 'bench_press'],
    ['Bench-press', 'bench_press'],
    ['bench_press', 'bench_press'],
    ['back/squat', 'back_squat'],
    ['O.H.P.', 'strict_press'],
    ['Deadlift!', 'deadlift'],
    ["Squat's", null], // becomes "squats": plurals are not synonyms
    ['High-bar squat', 'back_squat'],
    ['Low bar  squat.', 'back_squat'],
    ['Push-Press', 'push_press'],
    ['(press)', 'strict_press'],
    // Not recognized.
    ['Deadlifts', null],
    ['Sumo deadlift', null],
    ['Romanian deadlift', null],
    ['Incline bench', null],
    ['Dumbbell bench press', null],
    ['Squat back', null],
    ['Overhead squat', null],
    ['Push jerk', null],
    ['Plank', null],
    ['Other', null],
    ['', null],
    ['   ', null],
    ['!!!', null],
    ['Îndreptări', null],
    [null, null],
  ];
  it.each(TABLE)('%j -> %j', async (name, expected) => {
    expect(await normalize(name)).toBe(expected);
  });

  it('is immutable, pins search_path and is reachable by no API role', async () => {
    const { rows } = await admin.query<{ volatile: string; config: string[] }>(
      `select p.provolatile as volatile, p.proconfig as config from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'private' and p.proname = 'normalize_lift_name'`,
    );
    expect(rows).toEqual([{ volatile: 'i', config: ['search_path=""'] }]);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const { rows: r } = await admin.query<{ ok: boolean }>(
        "select has_function_privilege($1, 'private.normalize_lift_name(text)', 'execute') as ok",
        [role],
      );
      expect(r[0].ok, role).toBe(false);
    }
  });
});

describe('privileges', () => {
  it('anon and service_role cannot call the functions; the table is out of reach', async () => {
    const { rows } = await admin.query<{ id: string }>('select gen_random_uuid() as id');
    const calls: [string, unknown[]][] = [
      ['select public.get_max_effort_candidates($1)', [rows[0].id]],
      ['select public.confirm_max_effort($1, $2, $3, $4, $5)', [rows[0].id, 'deadlift', 1, 100, true]],
      ['select public.get_my_personal_records()', []],
    ];
    for (const [sql, params] of calls) {
      await expect(asAnon((db) => db.query(sql, params)), sql).rejects.toMatchObject(denied);
      await expect(asService((db) => db.query(sql, params)), sql).rejects.toMatchObject(denied);
    }
    const { memberIds } = await createPack(1);
    await expect(
      asUser(memberIds[0], (db) => db.query('select * from private.lift_max_efforts')),
    ).rejects.toMatchObject(denied);
    await expect(asService((db) => db.query('select * from private.lift_max_efforts'))).rejects.toMatchObject(denied);
  });

  it('every function needs a signed-in caller', async () => {
    const { rows } = await admin.query<{ id: string }>('select gen_random_uuid() as id');
    const noSub = <T>(fn: (db: PoolClient) => Promise<T>) => asRole('authenticated', { role: 'authenticated' }, fn);
    for (const [sql, params] of [
      ['select public.get_max_effort_candidates($1)', [rows[0].id]],
      ['select public.confirm_max_effort($1, $2, $3, $4, $5)', [rows[0].id, 'deadlift', 1, 100, true]],
      ['select public.get_my_personal_records()', []],
    ] as [string, unknown[]][]) {
      await expect(noSub((db) => db.query(sql, params)), sql).rejects.toMatchObject(raised('not_authenticated'));
    }
  });
});

describe('qualifying sets and candidates', () => {
  it('lists the best weight per lift x reps of recognized lifts with 1-3 reps and weight > 0', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, [m], { title: 'Heavy day' });
    await save(
      m,
      event.id,
      lifts(
        ['Deadlift', [[5, 150], [3, 170], [1, 180], [1, 190], [3, 165]]],
        ['DL', [[1, 185], [2, 175]]], // same lift as Deadlift: merged
        ['Bench press', [[4, 100], [2, 95]]], // 4 reps does not qualify
        ['Back squat', [[1, 0], [2, 140.25]]], // 0 kg does not qualify
        ['Plank', [[1, 20]]], // not a lift
        ['Front squat', [[10, 80]]], // nothing qualifies
        ['Push Press', [[3, 70.5]]],
      ),
    );

    const view = await candidates(m, event.id);
    expect(view).toMatchObject({ session_id: event.id, log_type: 'strength', event_title: 'Heavy day', has_consent: true });
    expect(view.candidates).toEqual([
      { lift: 'deadlift', label: 'Deadlift', reps: 1, weight_kg: 190, confirmed: false, confirmed_weight_kg: null, previous_best_kg: null, is_new_record: true },
      { lift: 'deadlift', label: 'Deadlift', reps: 2, weight_kg: 175, confirmed: false, confirmed_weight_kg: null, previous_best_kg: null, is_new_record: true },
      { lift: 'deadlift', label: 'Deadlift', reps: 3, weight_kg: 170, confirmed: false, confirmed_weight_kg: null, previous_best_kg: null, is_new_record: true },
      { lift: 'bench_press', label: 'Bench press', reps: 2, weight_kg: 95, confirmed: false, confirmed_weight_kg: null, previous_best_kg: null, is_new_record: true },
      { lift: 'back_squat', label: 'Back squat', reps: 2, weight_kg: 140.25, confirmed: false, confirmed_weight_kg: null, previous_best_kg: null, is_new_record: true },
      { lift: 'push_press', label: 'Push press', reps: 3, weight_kg: 70.5, confirmed: false, confirmed_weight_kg: null, previous_best_kg: null, is_new_record: true },
    ]);
  });

  it('a running log has no candidates; no log (or another member\'s log, or null) is not_found', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const [m, other] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const run = await endedEvent(organizerId, communityId, [m], { subtype: 'running' });
    await save(m, run.id, { distance_m: 5000, duration_s: 1500 });
    expect((await candidates(m, run.id)).candidates).toEqual([]);
    await expect(candidates(other, run.id)).rejects.toMatchObject(raised('not_found'));
    await expect(candidates(organizerId, run.id)).rejects.toMatchObject(raised('not_found'));
    await expect(candidates(m, null)).rejects.toMatchObject(raised('not_found'));
  });

  it('shows the previous best and whether a set would be a new record', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const old = await endedEvent(organizerId, communityId, [m], { startedDaysAgo: 10 });
    const now = await endedEvent(organizerId, communityId, [m], { startedDaysAgo: 1 });
    await save(m, old.id, lifts(['Deadlift', [[1, 180]]], ['Bench', [[1, 100]]], ['Squat', [[1, 150]]]));
    for (const [lift, w] of [['deadlift', 180], ['bench_press', 100], ['back_squat', 150]] as const) {
      await confirm(m, old.id, lift, 1, w);
    }
    await save(m, now.id, lifts(['Deadlift', [[1, 185]]], ['Bench press', [[1, 100]]], ['Back squat', [[1, 140]]]));
    const view = (await candidates(m, now.id)).candidates;
    expect(view.map((c) => [c.lift, c.previous_best_kg, c.is_new_record])).toEqual([
      ['deadlift', 180, true],
      ['bench_press', 100, false], // a tie: the earlier event keeps the record
      ['back_squat', 150, false],
    ]);
  });
});

describe('confirm_max_effort', () => {
  async function strengthLog() {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const [m, other] = memberIds;
    await grantConsents(m, ['workout_logs']);
    await grantConsents(other, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, [m, other]);
    await save(m, event.id, lifts(['Deadlift', [[1, 180], [1, 170]]], ['OHP', [[3, 50]]]));
    return { communityId, organizerId, m, other, event };
  }

  it('confirms, updates and removes a confirmation', async () => {
    const { m, event } = await strengthLog();
    expect(await confirm(m, event.id, 'deadlift', 1, 180)).toEqual({
      lift: 'deadlift', reps: 1, weight_kg: 180, confirmed: true, is_new_record: true,
    });
    // An exercise name instead of the key; the lift is normalized.
    expect(await confirm(m, event.id, 'O.H.P', 3, 50)).toMatchObject({ lift: 'strict_press', reps: 3, weight_kg: 50 });
    expect(await stored(m)).toEqual([
      { session_id: event.id, lift: 'deadlift', reps: 1, weight_kg: '180.00' },
      { session_id: event.id, lift: 'strict_press', reps: 3, weight_kg: '50.00' },
    ]);
    // Re-confirming with another existing set of the same lift x reps updates the weight.
    await confirm(m, event.id, 'deadlift', 1, 170);
    expect((await stored(m))[0].weight_kg).toBe('170.00');
    const view = (await candidates(m, event.id)).candidates;
    expect(view[0]).toMatchObject({ lift: 'deadlift', reps: 1, weight_kg: 180, confirmed: true, confirmed_weight_kg: 170 });
    // Unconfirm: removed whatever the weight.
    expect(await confirm(m, event.id, 'deadlift', 1, 180, false)).toEqual({
      lift: 'deadlift', reps: 1, weight_kg: 180, confirmed: false, is_new_record: false,
    });
    expect((await stored(m)).map((r) => r.lift)).toEqual(['strict_press']);
    // Unconfirming nothing is harmless.
    await confirm(m, event.id, 'deadlift', 1, 180, false);
    expect(await stored(m)).toHaveLength(1);
  });

  it('refuses invalid input in order', async () => {
    const { m, event } = await strengthLog();
    await expect(confirm(m, event.id, null, 1, 180)).rejects.toMatchObject(raised('validation_failed:lift'));
    await expect(confirm(m, event.id, 'plank', 1, 180)).rejects.toMatchObject(raised('validation_failed:lift'));
    await expect(confirm(m, event.id, 'deadlift', null, 180)).rejects.toMatchObject(raised('validation_failed:reps'));
    await expect(confirm(m, event.id, 'deadlift', 0, 180)).rejects.toMatchObject(raised('validation_failed:reps'));
    await expect(confirm(m, event.id, 'deadlift', 4, 180)).rejects.toMatchObject(raised('validation_failed:reps'));
    await expect(confirm(m, event.id, 'deadlift', 1, null)).rejects.toMatchObject(raised('validation_failed:weight_kg'));
    await expect(confirm(m, event.id, 'deadlift', 1, 0)).rejects.toMatchObject(raised('validation_failed:weight_kg'));
    await expect(confirm(m, event.id, 'deadlift', 1, 1000.25)).rejects.toMatchObject(raised('validation_failed:weight_kg'));
    await expect(confirm(m, event.id, 'deadlift', 1, 180, null)).rejects.toMatchObject(raised('validation_failed:confirmed'));
    expect(await stored(m)).toEqual([]);
  });

  it('refuses a set that does not exist in the log (weight, reps or lift differ)', async () => {
    const { m, event } = await strengthLog();
    for (const [lift, reps, weight] of [
      ['deadlift', 1, 181],
      ['deadlift', 2, 180],
      ['bench_press', 1, 180],
      ['strict_press', 1, 50],
    ] as const) {
      await expect(confirm(m, event.id, lift, reps, weight)).rejects.toMatchObject(raised('set_not_found'));
    }
    expect(await stored(m)).toEqual([]);
  });

  it("refuses another member's session, an unknown session and a running log", async () => {
    const { communityId, organizerId, m, other, event } = await strengthLog();
    // other has no log of the event; organizers have no access to member logs either.
    await expect(confirm(other, event.id, 'deadlift', 1, 180)).rejects.toMatchObject(raised('not_found'));
    await expect(confirm(organizerId, event.id, 'deadlift', 1, 180)).rejects.toMatchObject(raised('not_found'));
    await expect(confirm(other, event.id, 'deadlift', 1, 180, false)).rejects.toMatchObject(raised('not_found'));
    await expect(confirm(m, null, 'deadlift', 1, 180)).rejects.toMatchObject(raised('not_found'));
    // other's own log of the event does not let them touch m's confirmation.
    await confirm(m, event.id, 'deadlift', 1, 180);
    await save(other, event.id, lifts(['Deadlift', [[1, 100]]]));
    await confirm(other, event.id, 'deadlift', 1, 180, false);
    expect(await stored(m)).toHaveLength(1);
    await expect(confirm(other, event.id, 'deadlift', 1, 180)).rejects.toMatchObject(raised('set_not_found'));

    const run = await endedEvent(organizerId, communityId, [m], { subtype: 'running' });
    await save(m, run.id, { distance_m: 5000, duration_s: 1500 });
    await expect(confirm(m, run.id, 'deadlift', 1, 180)).rejects.toMatchObject(raised('set_not_found'));
  });

  it('confirming needs a current workout_logs consent; unconfirming does not', async () => {
    const { m, event } = await strengthLog();
    await confirm(m, event.id, 'deadlift', 1, 180);
    // A newer refusal in the ledger without the withdrawal's deletion (superuser fixture).
    await admin.query(
      `insert into public.consent_records (user_id, purpose, document_version, granted, created_at)
       values ($1, 'workout_logs', private.privacy_version(), false, now() + interval '1 second')`,
      [m],
    );
    await expect(confirm(m, event.id, 'strict_press', 3, 50)).rejects.toMatchObject(
      raised('consent_required:workout_logs'),
    );
    expect((await candidates(m, event.id)).has_consent).toBe(false);
    await confirm(m, event.id, 'deadlift', 1, 180, false);
    expect(await stored(m)).toEqual([]);
  });

  it('a member who left keeps their records and can still confirm their own log', async () => {
    const { communityId, m, event } = await strengthLog();
    await leaveCommunity(m, communityId);
    await confirm(m, event.id, 'deadlift', 1, 180);
    expect((await records(m)).lifts[0].one_rm).toMatchObject({ weight_kg: 180, session_id: event.id });
  });
});

describe('get_my_personal_records: lifts', () => {
  it('an empty member gets every lift with null records and no running bests', async () => {
    const { memberIds } = await createPack(1);
    expect(await records(memberIds[0])).toEqual({
      running: { best_5k: null, best_10k: null, best_half: null, best_marathon: null, longest: null },
      lifts: [
        { lift: 'deadlift', label: 'Deadlift', one_rm: null, two_rm: null, three_rm: null },
        { lift: 'bench_press', label: 'Bench press', one_rm: null, two_rm: null, three_rm: null },
        { lift: 'back_squat', label: 'Back squat', one_rm: null, two_rm: null, three_rm: null },
        { lift: 'front_squat', label: 'Front squat', one_rm: null, two_rm: null, three_rm: null },
        { lift: 'strict_press', label: 'Strict press', one_rm: null, two_rm: null, three_rm: null },
        { lift: 'push_press', label: 'Push press', one_rm: null, two_rm: null, three_rm: null },
      ],
    });
  });

  it('the highest CONFIRMED weight per lift x reps wins; unconfirmed sets never count; ties go to the earliest', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const a = await insertLog(m, { type: 'strength', startsAt: '2026-01-10T10:00:00Z', title: 'A',
      exercises: lifts(['Deadlift', [[1, 200], [2, 180]]], ['Bench', [[1, 100]]]).exercises });
    const b = await insertLog(m, { type: 'strength', startsAt: '2026-02-10T10:00:00Z', title: 'B',
      exercises: lifts(['Deadlift', [[1, 210], [2, 185]]], ['Bench', [[1, 100]]], ['Front squat', [[3, 90]]]).exercises });
    const c = await insertLog(m, { type: 'strength', startsAt: '2026-03-10T10:00:00Z', title: 'C',
      exercises: lifts(['Deadlift', [[1, 250]]], ['Bench', [[1, 100]]]).exercises });

    await confirm(m, a, 'deadlift', 1, 200);
    await confirm(m, b, 'deadlift', 1, 210);
    await confirm(m, b, 'deadlift', 2, 185);
    await confirm(m, a, 'deadlift', 2, 180);
    // Bench 100 in three events: confirmed first in C, then B, then A -> the earliest EVENT (A) wins.
    await confirm(m, c, 'bench_press', 1, 100);
    await confirm(m, b, 'bench_press', 1, 100);
    const lastTie = await confirm(m, a, 'bench_press', 1, 100);
    expect(lastTie.is_new_record).toBe(true);
    await confirm(m, b, 'front_squat', 3, 90);
    // C's 250 kg deadlift is never confirmed.

    const { lifts: got } = await records(m);
    const byLift = Object.fromEntries(got.map((l) => [l.lift, l]));
    expect(byLift.deadlift.one_rm).toMatchObject({ weight_kg: 210, session_id: b, event_title: 'B' });
    expect(new Date(byLift.deadlift.one_rm!.event_starts_at).toISOString()).toBe('2026-02-10T10:00:00.000Z');
    expect(byLift.deadlift.one_rm!.achieved_at).toBe(byLift.deadlift.one_rm!.event_starts_at);
    expect(byLift.deadlift.two_rm).toMatchObject({ weight_kg: 185, session_id: b });
    expect(byLift.deadlift.three_rm).toBeNull();
    expect(byLift.bench_press.one_rm).toMatchObject({ weight_kg: 100, session_id: a, event_title: 'A' });
    expect(byLift.front_squat).toMatchObject({ one_rm: null, two_rm: null, three_rm: { weight_kg: 90, session_id: b } });
    expect(byLift.back_squat).toMatchObject({ one_rm: null, two_rm: null, three_rm: null });
  });

  it('equal weight and the same event start: the earlier confirmation wins', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const ex = lifts(['Push press', [[2, 80]]]).exercises;
    const first = await insertLog(m, { type: 'strength', startsAt: '2026-05-01T08:00:00Z', exercises: ex });
    const second = await insertLog(m, { type: 'strength', startsAt: '2026-05-01T08:00:00Z', exercises: ex });
    await confirm(m, second, 'push_press', 2, 80);
    expect((await confirm(m, first, 'push_press', 2, 80)).is_new_record).toBe(false);
    expect((await records(m)).lifts[5].two_rm).toMatchObject({ session_id: second });
  });

  it("records are private: other members and organizers see only their own", async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const [m, other] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, [m]);
    await save(m, event.id, lifts(['Deadlift', [[1, 180]]]));
    await confirm(m, event.id, 'deadlift', 1, 180);
    const run = await endedEvent(organizerId, communityId, [m], { subtype: 'running' });
    await save(m, run.id, { distance_m: 5000, duration_s: 1500 });

    for (const viewer of [other, organizerId]) {
      const got = await records(viewer);
      expect(got.running).toEqual({ best_5k: null, best_10k: null, best_half: null, best_marathon: null, longest: null });
      expect(got.lifts.every((l) => !l.one_rm && !l.two_rm && !l.three_rm)).toBe(true);
    }
    expect((await records(m)).lifts[0].one_rm).toMatchObject({ weight_kg: 180 });
    expect((await records(m)).running.best_5k).toMatchObject({ time_s: 1500 });
  });
});

describe('get_my_personal_records: running', () => {
  it('the 1.05 window, scaling to exactly D, rounding and the longest distance', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    const log = (distance_m: number | null, duration_s: number | null, startsAt: string, type: 'running' | 'race' = 'running') =>
      insertLog(m, { type, distance_m, duration_s, startsAt, title: `${distance_m}/${duration_s}` });

    await log(4999, 1000, '2026-01-01T00:00:00Z'); // under 5 km: never counts (no extrapolation)
    const at5250 = await log(5250, 1575, '2026-01-02T00:00:00Z'); // exactly 1.05: counts, 1575 x 5000/5250 = 1500
    await log(5251, 1400, '2026-01-03T00:00:00Z'); // over 1.05: not a 5 km
    const fiveK = await log(5100, 1520, '2026-01-04T00:00:00Z'); // 1520 x 5000/5100 = 1490.196 -> 1490
    await log(5000, 1490, '2026-01-05T00:00:00Z'); // same counted time, later event: loses the tie
    await log(10000, null, '2026-01-06T00:00:00Z'); // no duration: no best, but counts for the longest
    const tenK = await log(10500, 3150, '2026-01-07T00:00:00Z', 'race'); // 3150 x 10000/10500 = 3000
    await log(10200, 3100, '2026-01-08T00:00:00Z'); // 3039.2 -> 3039: slower
    const half = await log(21097, 6000, '2026-01-09T00:00:00Z'); // whole metres: 21097 counts; 6000 x 21097.5/21097 = 6000.14 -> 6000
    await log(22153, 6000, '2026-01-10T00:00:00Z'); // over 22152.375: not a half
    const marathon = await log(42195, 12601, '2026-01-11T00:00:00Z', 'race');
    const longest = await log(44000, 14000, '2026-01-12T00:00:00Z'); // 1.0428 x marathon: 14000 x 42195/44000 = 13425.6 -> 13426, slower
    await log(44000, 15000, '2026-01-13T00:00:00Z'); // same distance, later: loses the longest tie
    await insertLog(m, { type: 'strength', startsAt: '2026-01-14T00:00:00Z', exercises: [] });

    expect(at5250).toBeTruthy();
    const { running } = await records(m);
    expect(running.best_5k).toEqual({
      distance_m: 5000, time_s: 1490, pace_s_per_km: 298, logged_distance_m: 5100, logged_duration_s: 1520,
      session_id: fiveK, event_title: '5100/1520', event_starts_at: expect.any(String), log_type: 'running',
    });
    expect(running.best_10k).toMatchObject({ distance_m: 10000, time_s: 3000, pace_s_per_km: 300, session_id: tenK, log_type: 'race' });
    expect(running.best_half).toMatchObject({
      distance_m: 21097.5, time_s: 6000, pace_s_per_km: 284, logged_distance_m: 21097, session_id: half,
    });
    expect(running.best_marathon).toMatchObject({ distance_m: 42195, time_s: 12601, pace_s_per_km: 299, session_id: marathon });
    expect(running.longest).toEqual({
      distance_m: 44000, duration_s: 14000, pace_s_per_km: 318, session_id: longest, event_title: '44000/14000',
      event_starts_at: expect.any(String), log_type: 'running',
    });
  });

  it('a log exactly at 1.05 x D counts, scaled down', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    const s = await insertLog(m, { type: 'running', distance_m: 5250, duration_s: 1575, startsAt: '2026-01-02T00:00:00Z' });
    expect((await records(m)).running.best_5k).toMatchObject({ time_s: 1500, session_id: s, pace_s_per_km: 300 });
  });

  it('a counted time with a half second rounds up', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    // 1313 x 5000 / 5200 = 1262.5 exactly -> 1263; 2001 x 10000 / 10004 = 2000.2 -> 2000.
    await insertLog(m, { type: 'running', distance_m: 5200, duration_s: 1313, startsAt: '2026-01-02T00:00:00Z' });
    await insertLog(m, { type: 'running', distance_m: 10004, duration_s: 2001, startsAt: '2026-01-03T00:00:00Z' });
    const { running } = await records(m);
    // pace = round(1263 x 1000 / 5000) = round(252.6) = 253
    expect(running.best_5k).toMatchObject({ time_s: 1263, pace_s_per_km: 253 });
    expect(running.best_10k).toMatchObject({ time_s: 2000, pace_s_per_km: 200 });
  });
});

describe('consistency: edits, deletes, withdrawal, erasure', () => {
  it('saving the log again keeps only the confirmations whose set still exists', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, [m]);
    await save(m, event.id, lifts(['Deadlift', [[1, 180], [2, 170]]], ['Bench', [[1, 100]]], ['Squat', [[3, 140]]]));
    await confirm(m, event.id, 'deadlift', 1, 180);
    await confirm(m, event.id, 'deadlift', 2, 170);
    await confirm(m, event.id, 'bench_press', 1, 100);
    await confirm(m, event.id, 'back_squat', 3, 140);

    // Deadlift single changed weight, the double stays, bench renamed to a synonym, squat removed.
    await save(m, event.id, lifts(['dl', [[1, 182.5], [2, 170]]], ['Bench press', [[1, 100]]]));
    expect((await stored(m)).map((r) => `${r.lift}:${r.reps}:${r.weight_kg}`)).toEqual([
      'bench_press:1:100.00',
      'deadlift:2:170.00',
    ]);
    // Renamed to something that is no longer a lift: gone.
    await save(m, event.id, lifts(['Sumo deadlift', [[2, 170]]], ['Bench press', [[1, 100]]]));
    expect((await stored(m)).map((r) => r.lift)).toEqual(['bench_press']);
    // Reps changed to 4: no longer qualifying.
    await save(m, event.id, lifts(['Bench press', [[4, 100]]]));
    expect(await stored(m)).toEqual([]);
  });

  it('a save of another log or by another member leaves the confirmations alone', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const [m, other] = memberIds;
    await grantConsents(m, ['workout_logs']);
    await grantConsents(other, ['workout_logs']);
    const e1 = await endedEvent(organizerId, communityId, [m, other]);
    const e2 = await endedEvent(organizerId, communityId, [m]);
    await save(m, e1.id, lifts(['Deadlift', [[1, 180]]]));
    await confirm(m, e1.id, 'deadlift', 1, 180);
    await save(m, e2.id, lifts(['Bench', [[1, 90]]]));
    await save(other, e1.id, lifts(['Bench', [[1, 50]]]));
    expect(await stored(m)).toHaveLength(1);
  });

  it('deleting the log deletes its confirmations (only that event)', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const e1 = await endedEvent(organizerId, communityId, [m]);
    const e2 = await endedEvent(organizerId, communityId, [m]);
    await save(m, e1.id, lifts(['Deadlift', [[1, 180]]]));
    await save(m, e2.id, lifts(['Deadlift', [[1, 170]]]));
    await confirm(m, e1.id, 'deadlift', 1, 180);
    await confirm(m, e2.id, 'deadlift', 1, 170);
    await deleteLog(m, e1.id);
    expect((await stored(m)).map((r) => r.session_id)).toEqual([e2.id]);
    expect((await records(m)).lifts[0].one_rm).toMatchObject({ weight_kg: 170, session_id: e2.id });
  });

  it('withdrawing the workout_logs consent deletes every confirmation (only the member\'s)', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const [m, keeper] = memberIds;
    await asUser(m, (db) => rpc(db, 'record_consent', ['workout_logs']));
    await grantConsents(keeper, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, [m, keeper]);
    await save(m, event.id, lifts(['Deadlift', [[1, 180]]]));
    await save(keeper, event.id, lifts(['Deadlift', [[1, 120]]]));
    await confirm(m, event.id, 'deadlift', 1, 180);
    await confirm(keeper, event.id, 'deadlift', 1, 120);
    await withdraw(m);
    expect(await stored(m)).toEqual([]);
    expect(await stored(keeper)).toHaveLength(1);
    expect((await records(m)).lifts[0].one_rm).toBeNull();
  });

  it('account deletion erases the confirmations', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const [m, keeper] = memberIds;
    await grantConsents(m, ['workout_logs']);
    await grantConsents(keeper, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, [m, keeper]);
    await save(m, event.id, lifts(['Deadlift', [[1, 180]]]));
    await save(keeper, event.id, lifts(['Deadlift', [[1, 120]]]));
    await confirm(m, event.id, 'deadlift', 1, 180);
    await confirm(keeper, event.id, 'deadlift', 1, 120);
    await deleteMyAccount(m);
    expect(await stored(m)).toEqual([]);
    expect(await stored(keeper)).toHaveLength(1);
  });

  it('a confirmation racing a re-save without that set never survives it', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, [m]);
    for (let i = 0; i < 6; i += 1) {
      await save(m, event.id, lifts(['Deadlift', [[1, 180]]]));
      const results = await Promise.allSettled([
        confirm(m, event.id, 'deadlift', 1, 180),
        save(m, event.id, lifts(['Deadlift', [[1, 175]]])),
      ]);
      expect(results[1].status).toBe('fulfilled');
      if (results[0].status === 'rejected') {
        expect(results[0].reason).toMatchObject(raised('set_not_found'));
      }
      expect(await stored(m)).toEqual([]);
    }
  });

  it('a confirmation racing a withdrawal never leaves a confirmation behind', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    const event = await endedEvent(organizerId, communityId, [m]);
    for (let i = 0; i < 6; i += 1) {
      await asUser(m, (db) => rpc(db, 'record_consent', ['workout_logs']));
      await save(m, event.id, lifts(['Deadlift', [[1, 180]]]));
      await Promise.allSettled([confirm(m, event.id, 'deadlift', 1, 180), withdraw(m)]);
      expect(await stored(m)).toEqual([]);
    }
  });
});

describe('export_my_data', () => {
  it('extensions.personal_records holds the confirmations and the running bests, nothing of others', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const [m, other] = memberIds;
    await grantConsents(m, ['workout_logs']);
    await grantConsents(other, ['workout_logs']);
    const lift = await endedEvent(organizerId, communityId, [m, other], { title: 'Lift day' });
    const run = await endedEvent(organizerId, communityId, [m], { subtype: 'running', title: 'Run day' });
    await save(m, lift.id, lifts(['Deadlift', [[1, 180]]], ['Bench', [[2, 90.25]]]));
    await save(other, lift.id, lifts(['Deadlift', [[1, 120]]]));
    await confirm(m, lift.id, 'deadlift', 1, 180);
    await confirm(m, lift.id, 'bench_press', 2, 90.25);
    await confirm(other, lift.id, 'deadlift', 1, 120);
    await save(m, run.id, { distance_m: 10000, duration_s: 3000 });

    const ex = await exportMyData(m);
    const pr = ex.extensions.personal_records as {
      lift_max_efforts: Record<string, unknown>[];
      running: Records['running'];
    };
    expect(pr.lift_max_efforts).toEqual([
      { session_id: lift.id, event_title: 'Lift day', event_starts_at: expect.any(String), lift: 'deadlift', reps: 1, weight_kg: 180, confirmed_at: expect.any(String) },
      { session_id: lift.id, event_title: 'Lift day', event_starts_at: expect.any(String), lift: 'bench_press', reps: 2, weight_kg: 90.25, confirmed_at: expect.any(String) },
    ]);
    expect(pr.running).toEqual(await records(m).then((r) => r.running));
    expect(pr.running.best_10k).toMatchObject({ time_s: 3000, session_id: run.id, event_title: 'Run day' });
    expect(ex.truncated.lift_max_efforts).toBe(false);
    expect(ex.README).toContain('extensions.personal_records');
    expect(JSON.stringify(ex)).not.toContain(other);
  });

  it('an empty member gets empty personal records', async () => {
    const { memberIds } = await createPack(1);
    const ex = await exportMyData(memberIds[0]);
    expect(ex.extensions.personal_records).toEqual({
      lift_max_efforts: [],
      running: { best_5k: null, best_10k: null, best_half: null, best_marathon: null, longest: null },
    });
  });
});

describe('the member id is never a parameter', () => {
  it('a new member of another community cannot reach anything by session id', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, [m]);
    await save(m, event.id, lifts(['Deadlift', [[1, 180]]]));
    await confirm(m, event.id, 'deadlift', 1, 180);
    const outsider = await addMember((await createPack(0)).communityId, { name: 'Outsider' });
    await grantConsents(outsider, ['workout_logs']);
    await expect(candidates(outsider, event.id)).rejects.toMatchObject(raised('not_found'));
    await expect(confirm(outsider, event.id, 'deadlift', 1, 180, false)).rejects.toMatchObject(raised('not_found'));
    expect(await stored(m)).toHaveLength(1);
  });
});
