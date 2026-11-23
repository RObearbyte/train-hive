import type { PoolClient } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { deleteMyAccount, exportMyData, leaveCommunity, removeMember } from './account-deletion-helpers';
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
 * P5: workout logs (private, owner only), the post-event prompt job and the workout statistics.
 * Contract: docs/API_CONTRACT.md ("Workout logs (P5)"); definitions: docs/STATS_DEFINITIONS.md
 * ("Workout statistics (P5)").
 */

type WorkoutLog = {
  id: string;
  session_id: string;
  community_id: string;
  log_type: 'strength' | 'running' | 'race';
  event_title: string;
  event_starts_at: string;
  event_kind: EventKind;
  event_subtype: string;
  distance_m: number | null;
  duration_s: number | null;
  pace_s_per_km: number | null;
  exercises: { name: string; sets: { reps: number; weight_kg: number }[] }[] | null;
  strength_volume_kg: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type LogScreen = {
  session_id: string;
  community_id: string;
  event: Record<string, unknown> | null;
  log_type: string | null;
  can_log: boolean;
  cannot_log_reason: string | null;
  has_consent: boolean;
  log: WorkoutLog | null;
};

type MyStats = {
  community_id: string | null;
  from: string | null;
  to: string | null;
  sessions_logged: number;
  running_sessions: number;
  race_sessions: number;
  strength_sessions: number;
  total_distance_m: number;
  total_duration_s: number;
  average_pace_s_per_km: number | null;
  pace_sessions: number;
  strength_volume_kg: number;
  strength_sets: number;
};

type CommunityStats = {
  community_id: string;
  window: string;
  from: string | null;
  to: string;
  min_contributors: number;
  insufficient_data: boolean;
  members_contributing: number | null;
  sessions_logged: number | null;
  total_distance_km: number | null;
  total_duration_minutes: number | null;
  average_pace_s_per_km: number | null;
};

const raised = (message: string) => ({ code: RAISED, message });
const denied = { code: INSUFFICIENT_PRIVILEGE };

const save = (userId: string, sessionId: string | null, input: unknown) =>
  asUser(userId, (db) =>
    rpc<WorkoutLog>(db, 'save_workout_log', [sessionId, input === null ? null : JSON.stringify(input)]),
  );
const getLog = (userId: string, sessionId: string | null) =>
  asUser(userId, (db) => rpc<LogScreen>(db, 'get_my_workout_log', [sessionId]));
const deleteLog = (userId: string, sessionId: string | null) =>
  asUser(userId, (db) => rpc<{ session_id: string; deleted: boolean }>(db, 'delete_my_workout_log', [sessionId]));
const listLogs = (userId: string, limit: number | null = 20, before: string | null = null) =>
  asUser(userId, (db) =>
    rpc<{ logs: WorkoutLog[]; next_before: string | null }>(db, 'list_my_workout_logs', [limit, before]),
  );
const myStats = (userId: string, communityId: string | null = null, from: string | null = null, to: string | null = null) =>
  asUser(userId, (db) => rpc<MyStats>(db, 'get_my_workout_stats', [communityId, from, to]));
const communityStats = (userId: string, communityId: string | null, window = '30d') =>
  asUser(userId, (db) => rpc<CommunityStats>(db, 'get_community_workout_stats', [communityId, window]));
const runPrompts = () => asService((db) => rpc<number>(db, 'enqueue_workout_log_prompts'));
const withdraw = (userId: string, purpose: string) =>
  asUser(userId, (db) => rpc<{ changed: boolean }>(db, 'withdraw_consent', [purpose]));

const RUN = { distance_m: 10000, duration_s: 3000 };

interface EndedOptions {
  kind?: EventKind;
  subtype?: string;
  going?: string[];
  notGoing?: string[];
  /** Minutes since the event ended (negative: it ends in the future). Default 60. */
  endedMinutesAgo?: number;
  status?: 'scheduled' | 'confirmed' | 'completed' | 'cancelled';
  /** No ends_at: the end is starts_at + 2 hours. */
  noEnd?: boolean;
  title?: string;
}

/** An event created through the real RPC (future), RSVPs set, then moved into the past (superuser). */
async function endedEvent(organizerId: string, communityId: string, options: EndedOptions = {}): Promise<EventSession> {
  const { kind = 'training', going = [], notGoing = [], endedMinutesAgo = 60, status = 'confirmed', noEnd = false } = options;
  const overrides: Record<string, unknown> = {};
  if (options.subtype) {
    overrides.event_subtype = options.subtype;
    if (kind === 'training') overrides.activity_type = options.subtype;
  }
  if (kind === 'training') overrides.min_participants = 1;
  if (options.title) overrides.title = options.title;
  const event = await createEvent(organizerId, communityId, kind, overrides);
  for (const id of going) await setRsvp(id, event.id, 'going');
  for (const id of notGoing) await setRsvp(id, event.id, 'not_going');
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

async function markPresent(sessionId: string, communityId: string, userId: string): Promise<void> {
  await admin.query(
    `insert into public.attendance_records (session_id, community_id, user_id, status, had_rsvp_going, is_walk_in)
     values ($1, $2, $3, 'present', false, true)`,
    [sessionId, communityId, userId],
  );
}

async function storedLogs(userId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await admin.query('select * from private.workout_logs where user_id = $1 order by event_starts_at', [userId]);
  return rows;
}

async function prompts(sessionId: string): Promise<{ user_id: string; title: string; body: string; deep_link: string }[]> {
  const { rows } = await admin.query(
    `select user_id, title, body, deep_link from public.notifications
     where kind = 'workout_log_prompt' and related_session_id = $1 order by user_id`,
    [sessionId],
  );
  return rows;
}

beforeEach(resetData);
afterAll(closeDb);

describe('privileges', () => {
  it('anon and service_role cannot call the member functions; members cannot run the prompt job', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const event = await endedEvent(organizerId, communityId, { going: memberIds });
    const calls: [string, unknown[]][] = [
      ['select public.save_workout_log($1, $2)', [event.id, JSON.stringify(RUN)]],
      ['select public.get_my_workout_log($1)', [event.id]],
      ['select public.delete_my_workout_log($1)', [event.id]],
      ['select public.list_my_workout_logs($1, $2)', [20, null]],
      ['select public.get_my_workout_stats($1, $2, $3)', [null, null, null]],
      ['select public.get_community_workout_stats($1, $2)', [communityId, '30d']],
    ];
    for (const [sql, params] of calls) {
      await expect(asAnon((db) => db.query(sql, params)), sql).rejects.toMatchObject(denied);
      await expect(asService((db) => db.query(sql, params)), sql).rejects.toMatchObject(denied);
    }
    await expect(asAnon((db) => db.query('select public.enqueue_workout_log_prompts()'))).rejects.toMatchObject(denied);
    await expect(
      asUser(organizerId, (db) => db.query('select public.enqueue_workout_log_prompts()')),
    ).rejects.toMatchObject(denied);
  });

  it('the log tables cannot be read or written by any API role', async () => {
    const { memberIds } = await createPack(1);
    for (const table of ['private.workout_logs', 'private.workout_prompt_runs']) {
      await expect(asUser(memberIds[0], (db) => db.query(`select * from ${table}`))).rejects.toMatchObject(denied);
      await expect(asService((db) => db.query(`select * from ${table}`))).rejects.toMatchObject(denied);
    }
  });

  it('every function needs a signed-in caller', async () => {
    const { rows } = await admin.query<{ id: string }>('select gen_random_uuid() as id');
    // An authenticated role without a sub claim: auth.uid() is null.
    const noSub = <T>(fn: (db: PoolClient) => Promise<T>) => asRole('authenticated', { role: 'authenticated' }, fn);
    for (const [sql, params] of [
      ['select public.save_workout_log($1, $2)', [rows[0].id, '{}']],
      ['select public.get_my_workout_log($1)', [rows[0].id]],
      ['select public.delete_my_workout_log($1)', [rows[0].id]],
      ['select public.list_my_workout_logs()', []],
      ['select public.get_my_workout_stats()', []],
      ['select public.get_community_workout_stats($1)', [rows[0].id]],
    ] as [string, unknown[]][]) {
      await expect(noSub((db) => db.query(sql, params)), sql).rejects.toMatchObject(raised('not_authenticated'));
    }
  });
});

describe('who can log what', () => {
  it('a going member logs a running training; an organizer never sees it', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    const event = await endedEvent(organizerId, communityId, { going: [m, organizerId], title: 'Tempo run' });
    await grantConsents(m, ['workout_logs']);

    const log = await save(m, event.id, { ...RUN, notes: 'Felt good' });
    expect(log).toMatchObject({
      session_id: event.id,
      community_id: communityId,
      log_type: 'running',
      event_title: 'Tempo run',
      event_kind: 'training',
      event_subtype: 'running',
      distance_m: 10000,
      duration_s: 3000,
      pace_s_per_km: 300,
      exercises: null,
      strength_volume_kg: null,
      notes: 'Felt good',
    });

    // The organizer (going too) has no log of their own; no function returns someone else's log.
    const organizerView = await getLog(organizerId, event.id);
    expect(organizerView.log).toBeNull();
    expect(organizerView.can_log).toBe(true);
    expect((await listLogs(organizerId)).logs).toEqual([]);
    expect(await myStats(organizerId)).toMatchObject({ sessions_logged: 0 });
    // Another member: nothing either, and cannot delete it.
    const other = await addMember(communityId, { name: 'Other' });
    expect(await deleteLog(other, event.id)).toEqual({ session_id: event.id, deleted: false });
    expect(await storedLogs(m)).toHaveLength(1);
  });

  it('log types follow the event kind and activity', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const cases: [EndedOptions, string | null][] = [
      [{ kind: 'training', subtype: 'running' }, 'running'],
      [{ kind: 'training', subtype: 'trail_running' }, 'running'],
      [{ kind: 'training', subtype: 'ocr' }, 'running'],
      [{ kind: 'training', subtype: 'strength' }, 'strength'],
      [{ kind: 'training', subtype: 'functional_fitness' }, 'strength'],
      [{ kind: 'training', subtype: 'other' }, null],
      [{ kind: 'race', subtype: 'asphalt_running' }, 'race'],
      [{ kind: 'race', subtype: 'ocr' }, 'race'],
      [{ kind: 'sports_event', subtype: 'crossfit_event' }, 'strength'],
      [{ kind: 'sports_event', subtype: 'public_training' }, null],
      [{ kind: 'social', subtype: 'social_gathering' }, null],
    ];
    for (const [options, type] of cases) {
      const event = await endedEvent(organizerId, communityId, { ...options, going: [m] });
      const screen = await getLog(m, event.id);
      expect(screen.log_type, JSON.stringify(options)).toBe(type);
      expect(screen.cannot_log_reason, JSON.stringify(options)).toBe(type === null ? 'not_loggable' : null);
      if (type === null) {
        await expect(save(m, event.id, RUN)).rejects.toMatchObject(raised('not_loggable'));
      }
    }
  });

  it('refuses unknown events, non-members, unfinished, cancelled or undecided events and non-attendees', async () => {
    const { communityId, organizerId, memberIds } = await createPack(3);
    const [going, notGoing, silent] = memberIds;
    await grantConsents(going, ['workout_logs']);
    await grantConsents(notGoing, ['workout_logs']);
    await grantConsents(silent, ['workout_logs']);
    const other = await createPack(1);
    await grantConsents(other.memberIds[0], ['workout_logs']);

    const ended = await endedEvent(organizerId, communityId, { going: [going], notGoing: [notGoing] });
    const { rows } = await admin.query<{ id: string }>('select gen_random_uuid() as id');
    await expect(save(going, rows[0].id, RUN)).rejects.toMatchObject(raised('not_found'));
    await expect(save(going, null, RUN)).rejects.toMatchObject(raised('not_found'));
    await expect(getLog(going, rows[0].id)).rejects.toMatchObject(raised('not_found'));
    await expect(save(other.memberIds[0], ended.id, RUN)).rejects.toMatchObject(raised('not_a_member'));
    await expect(getLog(other.memberIds[0], ended.id)).rejects.toMatchObject(raised('not_a_member'));
    await expect(save(notGoing, ended.id, RUN)).rejects.toMatchObject(raised('not_eligible'));
    await expect(save(silent, ended.id, RUN)).rejects.toMatchObject(raised('not_eligible'));
    expect((await getLog(silent, ended.id)).cannot_log_reason).toBe('not_eligible');

    const future = await endedEvent(organizerId, communityId, { going: [going], endedMinutesAgo: -30 });
    await expect(save(going, future.id, RUN)).rejects.toMatchObject(raised('event_not_ended'));
    // No ends_at: the end is starts_at + 2 hours.
    const noEndRunning = await endedEvent(organizerId, communityId, { going: [going], endedMinutesAgo: -1, noEnd: true });
    await expect(save(going, noEndRunning.id, RUN)).rejects.toMatchObject(raised('event_not_ended'));
    const noEndDone = await endedEvent(organizerId, communityId, { going: [going], endedMinutesAgo: 1, noEnd: true });
    await expect(save(going, noEndDone.id, RUN)).resolves.toMatchObject({ distance_m: 10000 });

    const cancelled = await endedEvent(organizerId, communityId, { going: [going], status: 'cancelled' });
    await expect(save(going, cancelled.id, RUN)).rejects.toMatchObject(raised('not_loggable'));
    const undecided = await endedEvent(organizerId, communityId, { going: [going], status: 'scheduled' });
    await expect(save(going, undecided.id, RUN)).rejects.toMatchObject(raised('not_loggable'));
    const completed = await endedEvent(organizerId, communityId, { going: [going], status: 'completed' });
    await expect(save(going, completed.id, RUN)).resolves.toMatchObject({ log_type: 'running' });

    // A removed member can no longer log.
    await removeMember(organizerId, communityId, going);
    const later = await endedEvent(organizerId, communityId, {});
    await expect(save(going, later.id, RUN)).rejects.toMatchObject(raised('not_a_member'));
    expect(await storedLogs(notGoing)).toHaveLength(0);
    expect(await storedLogs(silent)).toHaveLength(0);
  });

  it('a member recorded present without a going RSVP (walk-in) can log', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, {});
    await expect(save(m, event.id, RUN)).rejects.toMatchObject(raised('not_eligible'));
    await markPresent(event.id, communityId, m);
    await expect(save(m, event.id, RUN)).resolves.toMatchObject({ pace_s_per_km: 300 });
  });
});

describe('consent', () => {
  it('saving needs a current workout_logs consent; reading and deleting do not', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    const event = await endedEvent(organizerId, communityId, { going: [m] });
    expect(await getLog(m, event.id)).toMatchObject({ can_log: true, has_consent: false, log: null });
    await expect(save(m, event.id, RUN)).rejects.toMatchObject(raised('consent_required:workout_logs'));
    expect(await storedLogs(m)).toHaveLength(0);

    await grantConsents(m, ['workout_logs']);
    await save(m, event.id, RUN);
    expect((await getLog(m, event.id)).has_consent).toBe(true);
  });

  it('withdrawing the consent deletes every log of the member (and only theirs)', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const [m, keeper] = memberIds;
    await grantConsents(m, ['workout_logs']);
    await grantConsents(keeper, ['workout_logs']);
    const a = await endedEvent(organizerId, communityId, { going: [m, keeper] });
    const b = await endedEvent(organizerId, communityId, { going: [m], kind: 'training', subtype: 'strength' });
    await save(m, a.id, RUN);
    await save(keeper, a.id, RUN);
    await save(m, b.id, { exercises: [{ name: 'Squat', sets: [{ reps: 5, weight_kg: 100 }] }] });
    expect(await storedLogs(m)).toHaveLength(2);

    expect(await withdraw(m, 'workout_logs')).toMatchObject({ changed: true });
    expect(await storedLogs(m)).toHaveLength(0);
    expect(await storedLogs(keeper)).toHaveLength(1);
    await expect(save(m, a.id, RUN)).rejects.toMatchObject(raised('consent_required:workout_logs'));
  });

  it('withdrawing without a grant on record still deletes stray logs (changed: false)', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    const event = await endedEvent(organizerId, communityId, { going: [m] });
    await admin.query(
      `insert into private.workout_logs (user_id, session_id, community_id, log_type, event_title, event_starts_at,
                                         event_kind, event_subtype, distance_m)
       values ($1, $2, $3, 'running', 'x', now(), 'training', 'running', 1000)`,
      [m, event.id, communityId],
    );
    expect(await withdraw(m, 'workout_logs')).toMatchObject({ changed: false });
    expect(await storedLogs(m)).toHaveLength(0);
  });
});

describe('validation and text hygiene', () => {
  async function setup(subtype: string, kind: EventKind = 'training') {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, { kind, subtype, going: [m] });
    return { m, event };
  }

  it('running: shape, ranges and required fields', async () => {
    const { m, event } = await setup('running');
    const bad: [unknown, string][] = [
      [null, 'validation_failed:input'],
      [[1], 'validation_failed:input'],
      ['x', 'validation_failed:input'],
      [{ ...RUN, extra: 1 }, 'validation_failed:input'],
      [{ exercises: [] }, 'validation_failed:input'],
      [{}, 'validation_failed:distance_m'],
      [{ notes: 'only a note' }, 'validation_failed:distance_m'],
      [{ distance_m: 0 }, 'validation_failed:distance_m'],
      [{ distance_m: 1000001 }, 'validation_failed:distance_m'],
      [{ distance_m: 5.5 }, 'validation_failed:distance_m'],
      [{ distance_m: '5000' }, 'validation_failed:distance_m'],
      [{ duration_s: 0 }, 'validation_failed:duration_s'],
      [{ duration_s: 604801 }, 'validation_failed:duration_s'],
      [{ duration_s: 1e12 }, 'validation_failed:duration_s'],
      [{ ...RUN, notes: 'x'.repeat(1001) }, 'validation_failed:notes'],
      [{ ...RUN, notes: '​​' }, 'validation_failed:notes'],
      [{ ...RUN, notes: 5 }, 'validation_failed:notes'],
    ];
    for (const [input, message] of bad) {
      await expect(save(m, event.id, input), JSON.stringify(input)).rejects.toMatchObject(raised(message));
    }
    expect(await storedLogs(m)).toHaveLength(0);

    // Plausibility (P5-QA-7): with both values the pace must lie in [1:00, 30:00] min/km.
    for (const input of [
      { distance_m: 1, duration_s: 604800 }, // 7 days for 1 m
      { distance_m: 1000000, duration_s: 1 }, // 1000 km in one second
      { distance_m: 10000, duration_s: 599 }, // 0:59.9 /km
      { distance_m: 10000, duration_s: 18001 }, // 30:00.1 /km
      { distance_m: 3, duration_s: 6 }, // 33:20 /km
    ]) {
      await expect(save(m, event.id, input), JSON.stringify(input)).rejects.toMatchObject(
        raised('validation_failed:duration_s'),
      );
    }
    expect(await storedLogs(m)).toHaveLength(0);
    await expect(save(m, event.id, { distance_m: 10000, duration_s: 600 })).resolves.toMatchObject({
      pace_s_per_km: 60,
    });
    await expect(save(m, event.id, { distance_m: 10000, duration_s: 18000 })).resolves.toMatchObject({
      pace_s_per_km: 1800,
    });
    await expect(save(m, event.id, { distance_m: 336000, duration_s: 604800 })).resolves.toMatchObject({
      pace_s_per_km: 1800,
    });
    await expect(save(m, event.id, { distance_m: 1000000 })).resolves.toMatchObject({
      distance_m: 1000000,
      duration_s: null,
      pace_s_per_km: null,
    });
    await expect(save(m, event.id, { duration_s: 1800, notes: '   ' })).resolves.toMatchObject({
      distance_m: null,
      notes: null,
    });
    await expect(save(m, event.id, { ...RUN, notes: 'x'.repeat(1000) })).resolves.toMatchObject({
      notes: 'x'.repeat(1000),
    });
    // Controls and bidi overrides stripped, CR LF normalized, trimmed.
    await expect(
      save(m, event.id, { ...RUN, notes: '  Hill\u0007 repeats‮\r\nlegs ok  ' }),
    ).resolves.toMatchObject({ notes: 'Hill repeats\nlegs ok' });
  });

  it('race: finish time required', async () => {
    const { m, event } = await setup('asphalt_running', 'race');
    await expect(save(m, event.id, { distance_m: 21097 })).rejects.toMatchObject(raised('validation_failed:duration_s'));
    await expect(save(m, event.id, { duration_s: 6300 })).resolves.toMatchObject({
      log_type: 'race',
      distance_m: null,
      pace_s_per_km: null,
    });
    await expect(save(m, event.id, { distance_m: 21097, duration_s: 6300 })).resolves.toMatchObject({
      log_type: 'race',
      pace_s_per_km: 299, // 6300 / 21.097 = 298.62
    });
  });

  it('strength: exercises, sets, reps and weights', async () => {
    const { m, event } = await setup('strength');
    const set = { reps: 5, weight_kg: 100 };
    const ex = (sets: unknown[] = [set], name: unknown = 'Squat') => ({ name, sets });
    const bad: [unknown, string][] = [
      [{}, 'validation_failed:exercises'],
      [{ exercises: [] }, 'validation_failed:exercises'],
      [{ exercises: {} }, 'validation_failed:exercises'],
      [{ exercises: Array.from({ length: 31 }, () => ex()) }, 'validation_failed:exercises'],
      [{ exercises: [1] }, 'validation_failed:exercises'],
      [{ exercises: [{ ...ex(), extra: true }] }, 'validation_failed:exercises'],
      [{ distance_m: 5 }, 'validation_failed:input'],
      [{ exercises: [ex([set], '')] }, 'validation_failed:exercise_name'],
      [{ exercises: [ex([set], '​')] }, 'validation_failed:exercise_name'],
      [{ exercises: [ex([set], 'x'.repeat(81))] }, 'validation_failed:exercise_name'],
      [{ exercises: [ex([set], null)] }, 'validation_failed:exercise_name'],
      [{ exercises: [ex([])] }, 'validation_failed:sets'],
      [{ exercises: [ex(Array.from({ length: 21 }, () => set))] }, 'validation_failed:sets'],
      [{ exercises: [ex([{ reps: 5, weight_kg: 10, rpe: 8 }])] }, 'validation_failed:sets'],
      [{ exercises: [ex([{ weight_kg: 10 }])] }, 'validation_failed:reps'],
      [{ exercises: [ex([{ reps: 0 }])] }, 'validation_failed:reps'],
      [{ exercises: [ex([{ reps: 1001 }])] }, 'validation_failed:reps'],
      [{ exercises: [ex([{ reps: 2.5 }])] }, 'validation_failed:reps'],
      [{ exercises: [ex([{ reps: '5' }])] }, 'validation_failed:reps'],
      [{ exercises: [ex([{ reps: 5, weight_kg: -0.25 }])] }, 'validation_failed:weight_kg'],
      [{ exercises: [ex([{ reps: 5, weight_kg: 1000.25 }])] }, 'validation_failed:weight_kg'],
      [{ exercises: [ex([{ reps: 5, weight_kg: 10.1 }])] }, 'validation_failed:weight_kg'],
      [{ exercises: [ex([{ reps: 5, weight_kg: '10' }])] }, 'validation_failed:weight_kg'],
      [{ exercises: [ex()], notes: 'x'.repeat(1001) }, 'validation_failed:notes'],
    ];
    for (const [input, message] of bad) {
      await expect(save(m, event.id, input), JSON.stringify(input).slice(0, 120)).rejects.toMatchObject(raised(message));
    }
    expect(await storedLogs(m)).toHaveLength(0);

    // Limits accepted: 30 exercises x 20 sets, 1000 reps, 1000 kg, 0.25 steps, bodyweight.
    const max = await save(m, event.id, {
      exercises: Array.from({ length: 30 }, (_, i) => ex(Array.from({ length: 20 }, () => ({ reps: 1000, weight_kg: 1000 })), `E${i}`)),
    });
    expect(max.strength_volume_kg).toBe(600000000);

    const log = await save(m, event.id, {
      exercises: [
        { name: '  Back‮   squat ', sets: [{ reps: 5, weight_kg: 100 }, { reps: 5, weight_kg: 102.5 }] },
        { name: 'Pull-up', sets: [{ reps: 10 }, { reps: 8, weight_kg: null }, { reps: 3, weight_kg: 0.25 }] },
      ],
      notes: 'PR',
    });
    expect(log).toMatchObject({
      log_type: 'strength',
      distance_m: null,
      duration_s: null,
      pace_s_per_km: null,
      notes: 'PR',
      exercises: [
        { name: 'Back squat', sets: [{ reps: 5, weight_kg: 100 }, { reps: 5, weight_kg: 102.5 }] },
        { name: 'Pull-up', sets: [{ reps: 10, weight_kg: 0 }, { reps: 8, weight_kg: 0 }, { reps: 3, weight_kg: 0.25 }] },
      ],
    });
    // 5 x 100 + 5 x 102.5 + 3 x 0.25 = 1013.25
    expect(Number(log.strength_volume_kg)).toBe(1013.25);

    // A note alone is a valid strength log.
    await expect(save(m, event.id, { notes: 'Mobility only' })).resolves.toMatchObject({
      exercises: [],
      strength_volume_kg: 0,
    });
  });
});

describe('pace math', () => {
  it('rounds seconds per km half away from zero and needs both values', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, { going: [m] });
    const cases: [number, number, number][] = [
      [10000, 3000, 300],
      [5000, 1501, 300], // 300.2
      [2000, 601, 301], // 300.5 -> up
      [2000, 599, 300], // 299.5 -> up
      [42195, 10800, 256], // 255.95
      [1609, 360, 224], // 223.74
    ];
    for (const [distance, duration, pace] of cases) {
      const log = await save(m, event.id, { distance_m: distance, duration_s: duration });
      expect(log.pace_s_per_km, `${distance} m in ${duration} s`).toBe(pace);
    }
  });
});

describe('save / get / delete / list', () => {
  it('one log per member and event: saving again replaces it (same id, created_at kept)', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, { going: [m] });
    const first = await save(m, event.id, { ...RUN, notes: 'first' });
    const second = await save(m, event.id, { distance_m: 5000 });
    expect(second.id).toBe(first.id);
    expect(second.created_at).toBe(first.created_at);
    expect(second).toMatchObject({ distance_m: 5000, duration_s: null, notes: null });
    expect(await storedLogs(m)).toHaveLength(1);
    expect((await getLog(m, event.id)).log).toEqual(second);

    expect(await deleteLog(m, event.id)).toEqual({ session_id: event.id, deleted: true });
    expect(await deleteLog(m, event.id)).toEqual({ session_id: event.id, deleted: false });
    expect((await getLog(m, event.id)).log).toBeNull();
  });

  it('get_my_workout_log returns the screen context', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    const event = await endedEvent(organizerId, communityId, {
      kind: 'race',
      subtype: 'trail_running',
      going: [m],
      title: 'Mountain race',
    });
    expect(await getLog(m, event.id)).toEqual({
      session_id: event.id,
      community_id: communityId,
      event: {
        title: 'Mountain race',
        starts_at: expect.any(String),
        ends_at: expect.any(String),
        event_kind: 'race',
        event_subtype: 'trail_running',
        distance_km: null,
        status: 'confirmed',
      },
      log_type: 'race',
      can_log: true,
      cannot_log_reason: null,
      has_consent: false,
      log: null,
    });
  });

  it('lists own logs newest event first, paged without splitting ties', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const [m, other] = memberIds;
    await grantConsents(m, ['workout_logs']);
    await grantConsents(other, ['workout_logs']);
    const events: EventSession[] = [];
    for (const ago of [60, 120, 180, 180, 240]) {
      events.push(await endedEvent(organizerId, communityId, { going: [m, other], endedMinutesAgo: ago }));
    }
    // The 3rd and 4th events start at exactly the same instant.
    await admin.query(
      `update public.training_sessions t
       set starts_at = s.starts_at, ends_at = s.ends_at, rsvp_deadline = s.rsvp_deadline
       from public.training_sessions s
       where s.id = $1 and t.id = $2`,
      [events[2].id, events[3].id],
    );
    for (const e of events) await save(m, e.id, RUN);
    await save(other, events[0].id, RUN);

    const page1 = await listLogs(m, 2);
    expect(page1.logs.map((l) => l.session_id)).toEqual([events[0].id, events[1].id]);
    expect(page1.next_before).not.toBeNull();
    // The 3rd and 4th share a start: the page holds both although the limit is 1.
    const page2 = await listLogs(m, 1, page1.next_before);
    expect(page2.logs.map((l) => l.session_id).sort()).toEqual([events[2].id, events[3].id].sort());
    const page3 = await listLogs(m, 5, page2.next_before);
    expect(page3.logs.map((l) => l.session_id)).toEqual([events[4].id]);
    expect(page3.next_before).toBeNull();
    expect((await listLogs(m, 100)).logs).toHaveLength(5);
    expect((await listLogs(m, 100)).next_before).toBeNull();
    // Only own logs.
    expect((await listLogs(other)).logs.map((l) => l.session_id)).toEqual([events[0].id]);

    await expect(listLogs(m, 0)).rejects.toMatchObject(raised('validation_failed:limit'));
    await expect(listLogs(m, 101)).rejects.toMatchObject(raised('validation_failed:limit'));
    await expect(listLogs(m, null)).rejects.toMatchObject(raised('validation_failed:limit'));
  });
});

describe('the post-event prompt job', () => {
  it('prompts going active members once, with the log deep link, and is idempotent', async () => {
    const { communityId, organizerId, memberIds } = await createPack(4);
    const [a, b, notGoing, silent] = memberIds;
    const event = await endedEvent(organizerId, communityId, {
      going: [a, b, organizerId],
      notGoing: [notGoing],
      endedMinutesAgo: 16,
      title: 'Long run',
    });
    void silent;

    expect(await runPrompts()).toBe(3);
    expect(await runPrompts()).toBe(0);
    const sent = await prompts(event.id);
    expect(sent.map((p) => p.user_id).sort()).toEqual([a, b, organizerId].sort());
    for (const p of sent) {
      expect(p).toMatchObject({
        title: 'How did it go?',
        body: 'Log your workout: Long run',
        deep_link: `/events/${event.id}/log`,
      });
    }
    // One push job per notification.
    const { rows } = await admin.query<{ n: number }>(
      `select count(*)::int as n from public.notification_delivery_jobs j
       join public.notifications n on n.id = j.notification_id
       where n.kind = 'workout_log_prompt'`,
    );
    expect(rows[0].n).toBe(3);
    // Even with the event's marker gone, the dedupe key prevents a second notification.
    await admin.query('delete from private.workout_prompt_runs where session_id = $1', [event.id]);
    expect(await runPrompts()).toBe(0);
    expect(await prompts(event.id)).toHaveLength(3);
  });

  it('skips events that ended less than 15 minutes or more than 48 hours ago, cancelled, undecided, unloggable and future ones', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    const skipped = [
      await endedEvent(organizerId, communityId, { going: [m], endedMinutesAgo: 14 }),
      await endedEvent(organizerId, communityId, { going: [m], endedMinutesAgo: 48 * 60 + 1 }),
      await endedEvent(organizerId, communityId, { going: [m], endedMinutesAgo: 7 * 24 * 60 - 5 }),
      await endedEvent(organizerId, communityId, { going: [m], endedMinutesAgo: -60 }),
      await endedEvent(organizerId, communityId, { going: [m], status: 'cancelled' }),
      await endedEvent(organizerId, communityId, { going: [m], status: 'scheduled' }),
      await endedEvent(organizerId, communityId, { going: [m], kind: 'social' }),
      await endedEvent(organizerId, communityId, { going: [m], kind: 'training', subtype: 'other' }),
    ];
    const sent = [
      await endedEvent(organizerId, communityId, { going: [m], endedMinutesAgo: 48 * 60 - 5 }),
      await endedEvent(organizerId, communityId, { going: [m], status: 'completed' }),
      await endedEvent(organizerId, communityId, { going: [m], kind: 'race' }),
      await endedEvent(organizerId, communityId, { going: [m], kind: 'sports_event' }),
      await endedEvent(organizerId, communityId, { going: [m], noEnd: true, endedMinutesAgo: 20 }),
    ];
    expect(await runPrompts()).toBe(sent.length);
    for (const e of skipped) expect(await prompts(e.id)).toHaveLength(0);
    for (const e of sent) expect((await prompts(e.id)).map((p) => p.user_id)).toEqual([m]);

    // The 14-minute event is picked up once it reaches 15 minutes.
    await admin.query(
      "update public.training_sessions set ends_at = now() - interval '15 minutes' where id = $1",
      [skipped[0].id],
    );
    expect(await runPrompts()).toBe(1);
  });

  it('is sent without consent, never to removed members or members who already logged', async () => {
    const { communityId, organizerId, memberIds } = await createPack(3);
    const [noConsent, logged, removed] = memberIds;
    await grantConsents(logged, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, { going: [noConsent, logged, removed], endedMinutesAgo: 5 });
    await save(logged, event.id, RUN);
    await removeMember(organizerId, communityId, removed);
    await admin.query("update public.training_sessions set ends_at = now() - interval '20 minutes' where id = $1", [event.id]);
    expect(await runPrompts()).toBe(1);
    expect((await prompts(event.id)).map((p) => p.user_id)).toEqual([noConsent]);
  });

  it('push falls in the training_updates preference category', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const [off, on] = memberIds;
    await admin.query(
      `insert into public.notification_preferences (user_id, training_updates, training_reminders, announcements)
       values ($1, false, true, true), ($2, true, false, false)`,
      [off, on],
    );
    await grantConsents(off, ['push_notifications']);
    await grantConsents(on, ['push_notifications']);
    await endedEvent(organizerId, communityId, { going: [off, on], endedMinutesAgo: 30 });
    expect(await runPrompts()).toBe(2);
    const jobs = await asService((db) =>
      db.query<{ j: { user_id: string; kind: string; skip_reason: string | null } }>(
        "select j from public.claim_notification_jobs(100, 'test') as j",
      ),
    );
    const byUser = Object.fromEntries(
      jobs.rows.filter((r) => r.j.kind === 'workout_log_prompt').map((r) => [r.j.user_id, r.j]),
    );
    expect(byUser[off]).toMatchObject({ kind: 'workout_log_prompt', skip_reason: 'category_disabled' });
    expect(byUser[on]).toMatchObject({ kind: 'workout_log_prompt', skip_reason: 'no_tokens' });
  });

  it('the deep link allowlist accepts /events/<uuid>/log and still refuses other paths', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const event = await endedEvent(organizerId, communityId, {});
    const insert = (link: string) =>
      admin.query(
        `insert into public.notifications (user_id, community_id, kind, title, body, deep_link, related_session_id, dedupe_key)
         values ($1, $2, 'workout_log_prompt', 't', 'b', $3, $4, gen_random_uuid()::text)`,
        [memberIds[0], communityId, link, event.id],
      );
    await insert(`/events/${event.id}/log`);
    await insert(`/events/${event.id}/feed`);
    await insert(`/trainings/${event.id}`);
    await expect(insert(`/events/${event.id}/logs`)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(`/events/${event.id.toUpperCase()}/log`)).rejects.toMatchObject({ code: '23514' });
  });
});

describe('concurrency', () => {
  it('concurrent prompt runs send exactly one prompt per member', async () => {
    const { communityId, organizerId, memberIds } = await createPack(3);
    const event = await endedEvent(organizerId, communityId, { going: memberIds, endedMinutesAgo: 30 });
    const counts = await Promise.all([runPrompts(), runPrompts(), runPrompts(), runPrompts()]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3);
    expect((await prompts(event.id)).map((p) => p.user_id).sort()).toEqual([...memberIds].sort());
  });

  it('a save racing a withdrawal never leaves a log behind a withdrawn consent', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    const event = await endedEvent(organizerId, communityId, { going: [m] });
    for (let i = 0; i < 6; i += 1) {
      await asUser(m, (db) => rpc(db, 'record_consent', ['workout_logs']));
      await Promise.allSettled([save(m, event.id, RUN), withdraw(m, 'workout_logs')]);
      const { rows } = await admin.query<{ granted: boolean }>(
        `select granted from public.consent_records where user_id = $1 and purpose = 'workout_logs'
         order by created_at desc, id desc limit 1`,
        [m],
      );
      expect(rows[0].granted).toBe(false);
      expect(await storedLogs(m)).toHaveLength(0);
    }
  });
});

describe('personal statistics', () => {
  it('totals, average pace (distance-weighted), strength volume, community and window filters', async () => {
    const alpha = await createPack(1);
    const [m] = alpha.memberIds;
    await grantConsents(m, ['workout_logs']);
    const beta = await createPack(0);
    await admin.query(
      "insert into public.memberships (community_id, user_id, role, status) values ($1, $2, 'member', 'active')",
      [beta.communityId, m],
    );

    const run1 = await endedEvent(alpha.organizerId, alpha.communityId, { going: [m], endedMinutesAgo: 60 });
    const run2 = await endedEvent(alpha.organizerId, alpha.communityId, { going: [m], endedMinutesAgo: 3 * 24 * 60 });
    const lift = await endedEvent(alpha.organizerId, alpha.communityId, { going: [m], subtype: 'strength' });
    const race = await endedEvent(beta.organizerId, beta.communityId, { kind: 'race', going: [m], endedMinutesAgo: 10 * 24 * 60 });
    const distOnly = await endedEvent(beta.organizerId, beta.communityId, { going: [m], endedMinutesAgo: 30 });

    await save(m, run1.id, { distance_m: 10000, duration_s: 3000 });
    await save(m, run2.id, { distance_m: 5000, duration_s: 1800 });
    await save(m, lift.id, {
      exercises: [
        { name: 'Deadlift', sets: [{ reps: 5, weight_kg: 120 }, { reps: 3, weight_kg: 130.5 }] },
        { name: 'Plank', sets: [{ reps: 1 }] },
      ],
    });
    await save(m, race.id, { distance_m: 21097, duration_s: 6000 });
    await save(m, distOnly.id, { distance_m: 3000 });

    const all = await myStats(m);
    expect(all).toMatchObject({
      community_id: null,
      from: null,
      to: null,
      sessions_logged: 5,
      running_sessions: 3,
      race_sessions: 1,
      strength_sessions: 1,
      total_distance_m: 39097,
      total_duration_s: 10800,
      // (3000 + 1800 + 6000) s over (10000 + 5000 + 21097) m = 299.19 s/km; distance-only log excluded.
      average_pace_s_per_km: 299,
      pace_sessions: 3,
      strength_sets: 3,
    });
    // 5 x 120 + 3 x 130.5 + 1 x 0 = 991.5
    expect(Number(all.strength_volume_kg)).toBe(991.5);

    const alphaOnly = await myStats(m, alpha.communityId);
    expect(alphaOnly).toMatchObject({
      sessions_logged: 3,
      total_distance_m: 15000,
      total_duration_s: 4800,
      average_pace_s_per_km: 320,
    });

    const { rows } = await admin.query<{ from: string; to: string }>(
      "select (now() - interval '2 days')::text as from, now()::text as to",
    );
    const recent = await myStats(m, null, rows[0].from, rows[0].to);
    expect(recent).toMatchObject({ sessions_logged: 3, total_distance_m: 13000, average_pace_s_per_km: 300 });

    await expect(myStats(m, null, rows[0].to, rows[0].from)).rejects.toMatchObject(raised('validation_failed:range'));
    expect(await myStats(alpha.organizerId)).toMatchObject({
      sessions_logged: 0,
      total_distance_m: 0,
      total_duration_s: 0,
      average_pace_s_per_km: null,
      pace_sessions: 0,
      strength_volume_kg: 0,
      strength_sets: 0,
    });
  });
});

describe('community statistics (organizers, rounded, 20+ contributors, nested windows)', () => {
  type Run = { distance_m?: number; duration_s?: number };

  /** A community with `contributors` members who all hold the workout_logs consent. */
  async function consentingPack(contributors: number) {
    const pack = await createPack(contributors);
    for (const id of pack.memberIds) await grantConsents(id, ['workout_logs']);
    return pack;
  }

  /** One ended event (ended `endedMinutesAgo`) logged by `ids`, the i-th with runs[i % runs.length]. */
  async function logEvent(
    pack: { organizerId: string; communityId: string },
    ids: string[],
    runs: Run[],
    endedMinutesAgo = 60,
  ) {
    const event = await endedEvent(pack.organizerId, pack.communityId, { going: ids, endedMinutesAgo });
    for (let i = 0; i < ids.length; i += 1) await save(ids[i], event.id, runs[i % runs.length]);
    return event;
  }

  async function packWithLogs(contributors: number, runs: Run[]) {
    const pack = await consentingPack(contributors);
    const event = await logEvent(pack, pack.memberIds, runs);
    return { ...pack, event };
  }

  const DAYS_14 = 14 * 24 * 60;

  it('members are refused; organizers of other communities too', async () => {
    const { communityId, memberIds } = await createPack(1);
    const other = await createPack(0);
    await expect(communityStats(memberIds[0], communityId)).rejects.toMatchObject(raised('forbidden'));
    await expect(communityStats(other.organizerId, communityId)).rejects.toMatchObject(raised('forbidden'));
    await expect(communityStats(other.organizerId, null)).rejects.toMatchObject(raised('forbidden'));
    await expect(communityStats(other.organizerId, other.communityId, '1y')).rejects.toMatchObject(
      raised('validation_failed:window'),
    );
  });

  it('nothing below 20 contributing members; rounded totals from 20', async () => {
    const nineteen = await packWithLogs(19, [{ distance_m: 10000, duration_s: 3000 }]);
    for (const window of ['7d', '30d', '90d', 'all']) {
      expect(await communityStats(nineteen.organizerId, nineteen.communityId, window), window).toMatchObject({
        min_contributors: 20,
        insufficient_data: true,
        members_contributing: null,
        sessions_logged: null,
        total_distance_km: null,
        total_duration_minutes: null,
        average_pace_s_per_km: null,
      });
    }

    await resetData();
    const many = await packWithLogs(23, [
      { distance_m: 10400, duration_s: 3170 },
      { distance_m: 5250, duration_s: 1640 },
    ]);
    // Logs: 12 x (10400 m, 3170 s) + 11 x (5250 m, 1640 s) = 182550 m, 56080 s.
    const stats = await communityStats(many.organizerId, many.communityId);
    expect(stats).toMatchObject({
      community_id: many.communityId,
      window: '30d',
      min_contributors: 20,
      insufficient_data: false,
      members_contributing: 25, // 23 -> nearest 5
      sessions_logged: 25,
      total_distance_km: 180, // 182.55 -> nearest 10
      total_duration_minutes: 930, // 934.7 min -> nearest 30
      average_pace_s_per_km: 310, // 307.2 -> nearest 10
    });
    // Every window holds the same single event: the same answer everywhere.
    for (const window of ['7d', '90d', 'all']) {
      expect(await communityStats(many.organizerId, many.communityId, window), window).toMatchObject({
        insufficient_data: false,
        sessions_logged: 25,
        total_distance_km: 180,
      });
    }
  });

  it('each metric needs 20 contributors of its own', async () => {
    const both = { distance_m: 8000, duration_s: 2400 };
    const timeOnly = { duration_s: 2400 };
    const pack = await packWithLogs(22, [...Array.from({ length: 18 }, () => both), ...Array.from({ length: 4 }, () => timeOnly)]);
    expect(await communityStats(pack.organizerId, pack.communityId)).toMatchObject({
      insufficient_data: false,
      sessions_logged: 20, // 22 -> nearest 5
      total_distance_km: null, // only 18 members logged a distance
      total_duration_minutes: 870, // 22 x 40 min = 880 -> nearest 30
      average_pace_s_per_km: null, // only 18 logged both
    });
  });

  it('counts only active members: leaving keeps the own logs but drops the contribution', async () => {
    const pack = await packWithLogs(20, [{ distance_m: 10000, duration_s: 3000 }]);
    expect((await communityStats(pack.organizerId, pack.communityId)).insufficient_data).toBe(false);
    const leaver = pack.memberIds[0];
    await leaveCommunity(leaver, pack.communityId);
    expect((await communityStats(pack.organizerId, pack.communityId)).insufficient_data).toBe(true);
    // The leaver still owns the log, but sees only its snapshot, not the current event (P5-QA-6).
    expect((await listLogs(leaver)).logs).toHaveLength(1);
    const screen = await getLog(leaver, pack.event.id);
    expect(screen).toMatchObject({ event: null, log_type: 'running', can_log: false, cannot_log_reason: 'not_a_member' });
    expect(screen.log?.distance_m).toBe(10000);
    expect(await myStats(leaver, pack.communityId)).toMatchObject({ sessions_logged: 1 });
    expect(await deleteLog(leaver, pack.event.id)).toMatchObject({ deleted: true });
  });

  it('the window and cancelled events are respected', async () => {
    const pack = await packWithLogs(20, [{ distance_m: 10000, duration_s: 3000 }]);
    await admin.query(
      "update public.training_sessions set starts_at = now() - interval '10 days', ends_at = now() - interval '10 days' + interval '1 hour', rsvp_deadline = now() - interval '11 days' where id = $1",
      [pack.event.id],
    );
    expect((await communityStats(pack.organizerId, pack.communityId, '7d')).insufficient_data).toBe(true);
    expect(await communityStats(pack.organizerId, pack.communityId, '30d')).toMatchObject({
      insufficient_data: false,
      total_distance_km: 200,
    });
    await admin.query(
      "update public.training_sessions set status = 'cancelled', cancel_reason = 'organizer', cancelled_at = now() where id = $1",
      [pack.event.id],
    );
    expect((await communityStats(pack.organizerId, pack.communityId, 'all')).insufficient_data).toBe(true);
  });

  describe('nested windows: a larger window is published only when its difference to the next smaller published one covers 0 or 20+ members', () => {
    const RUN_10K = { distance_m: 10000, duration_s: 3000 };

    it('nothing older than the smallest window: every window gives the same answer', async () => {
      const pack = await packWithLogs(20, [RUN_10K]);
      for (const window of ['7d', '30d', '90d', 'all']) {
        expect(await communityStats(pack.organizerId, pack.communityId, window), window).toMatchObject({
          insufficient_data: false,
          members_contributing: 20,
          total_distance_km: 200,
          total_duration_minutes: 990, // 20 x 50 min = 1000 -> nearest 30
          average_pace_s_per_km: 300,
        });
      }
    });

    it('one member more in a larger window suppresses that window and every larger one', async () => {
      const pack = await consentingPack(21);
      await logEvent(pack, pack.memberIds.slice(0, 20), [RUN_10K]);
      await logEvent(pack, [pack.memberIds[20]], [{ distance_m: 14000, duration_s: 4200 }], DAYS_14);
      expect((await communityStats(pack.organizerId, pack.communityId, '7d')).insufficient_data).toBe(false);
      for (const window of ['30d', '90d', 'all']) {
        // 21 members in the window, but the difference to 7d is one member: not published.
        expect(await communityStats(pack.organizerId, pack.communityId, window), window).toMatchObject({
          insufficient_data: true,
          members_contributing: null,
          total_distance_km: null,
        });
      }
    });

    it('an older log of a member who is also in the smaller window is not isolated either', async () => {
      const pack = await consentingPack(20);
      await logEvent(pack, pack.memberIds, [RUN_10K]);
      await logEvent(pack, [pack.memberIds[0]], [{ distance_m: 14000, duration_s: 4200 }], DAYS_14);
      expect((await communityStats(pack.organizerId, pack.communityId, '7d')).insufficient_data).toBe(false);
      // Same 20 members in 30d, but the 30d-minus-7d band holds one member's log.
      expect((await communityStats(pack.organizerId, pack.communityId, '30d')).insufficient_data).toBe(true);
    });

    it('a band of 20+ members is published, and each metric checks its own band', async () => {
      const pack = await consentingPack(40);
      const recent = pack.memberIds.slice(0, 20);
      const older = pack.memberIds.slice(20);
      await logEvent(pack, recent, [RUN_10K]);
      // In the 30d-minus-7d band: 20 members, 19 of them with a distance.
      await logEvent(pack, older, [...Array.from({ length: 19 }, () => RUN_10K), { duration_s: 3000 }], DAYS_14);
      expect(await communityStats(pack.organizerId, pack.communityId, '7d')).toMatchObject({
        insufficient_data: false,
        members_contributing: 20,
        total_distance_km: 200,
      });
      expect(await communityStats(pack.organizerId, pack.communityId, '30d')).toMatchObject({
        insufficient_data: false,
        members_contributing: 40,
        sessions_logged: 40,
        total_distance_km: null, // the band has only 19 members with a distance
        total_duration_minutes: 2010, // 40 x 50 min = 2000 -> nearest 30
        average_pace_s_per_km: null, // the band has only 19 members with both
      });
    });
  });
});

describe('GDPR', () => {
  it('export_my_data lists the logs (extensions.workout_logs) and nothing of others', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const [m, other] = memberIds;
    await grantConsents(m, ['workout_logs']);
    await grantConsents(other, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, { going: [m, other], title: 'Intervals' });
    const log = await save(m, event.id, { ...RUN, notes: 'mine' });
    await save(other, event.id, { ...RUN, notes: 'theirs' });

    const ex = await exportMyData(m);
    const { id, ...rest } = log;
    expect(ex.extensions.workout_logs).toEqual([{ ...rest, log_id: id }]);
    expect(ex.truncated.workout_logs).toBe(false);
    expect(ex.README).toContain('extensions.workout_logs');
    expect(JSON.stringify(ex)).not.toContain('theirs');

    const empty = await exportMyData(organizerId);
    expect(empty.extensions.workout_logs).toEqual([]);
  });

  it('account deletion erases the logs', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const [m, keeper] = memberIds;
    await grantConsents(m, ['workout_logs']);
    await grantConsents(keeper, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, { going: [m, keeper] });
    await save(m, event.id, RUN);
    await save(keeper, event.id, RUN);
    await deleteMyAccount(m);
    expect(await storedLogs(m)).toHaveLength(0);
    expect(await storedLogs(keeper)).toHaveLength(1);
  });

  it('a log outlives its event (community deleted with its last member) and stays readable and deletable', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['workout_logs']);
    const event = await endedEvent(organizerId, communityId, { going: [m], title: 'Gone event' });
    await save(m, event.id, RUN);
    await leaveCommunity(m, communityId);
    await deleteMyAccount(organizerId); // the last active member: the community and its events go
    const { rows } = await admin.query('select 1 from public.training_sessions where id = $1', [event.id]);
    expect(rows).toHaveLength(0);

    const screen = await getLog(m, event.id);
    expect(screen).toMatchObject({ event: null, log_type: 'running', can_log: false, cannot_log_reason: 'not_found' });
    expect(screen.log).toMatchObject({ event_title: 'Gone event', distance_m: 10000 });
    expect(await deleteLog(m, event.id)).toMatchObject({ deleted: true });
  });
});
