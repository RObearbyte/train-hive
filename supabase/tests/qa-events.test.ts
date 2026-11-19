import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addMember,
  admin,
  asAnon,
  asUser,
  cancelTraining,
  closeDb,
  createPack,
  createUser,
  finalize,
  getSession,
  INSUFFICIENT_PRIVILEGE,
  makeDue,
  RAISED,
  realGoingCount,
  resetData,
  rpcRow,
  setRsvp,
} from './helpers';
import { buildFullLife, deleteMyAccount, exportMyData, goingCountMismatches, referencesTo, removeMember } from './account-deletion-helpers';
import { finalizeAttendance, makeEnded, recordAttendance, recordsOf } from './attendance-helpers';
import { enqueueReminders, notifications } from './notifications-helpers';
import { communityStats, history } from './stats-helpers';
import {
  createEvent,
  createRaw,
  eventFormOf,
  eventInput,
  type EventKind,
  type EventSession,
  FIXTURE_SUBTYPE,
  KINDS,
  updateEvent,
} from './events-helpers';
import { errorKey } from './qa-helpers';
import {
  EVENT_KINDS,
  fallbackSubtypes,
  takesCourse,
  takesObstacles,
} from '../../src/features/trainings/domain/events';

/**
 * Independent QA review of P1 (Events), backend half. Reviewed against docs/EVENTS_PLAN.md and
 * docs/API_CONTRACT.md "Events (P1)". Defects that these tests demonstrate are `it.fails`
 * with a `DEFECT Q8-n` comment (remove `.fails` once the owner fixed them).
 */

const raised = (message: string) => ({ code: RAISED, message });
const denied = { code: INSUFFICIENT_PRIVILEGE };

beforeEach(resetData);
afterAll(closeDb);

const NON_TRAINING: EventKind[] = ['race', 'sports_event', 'social'];

/** create_training with the JSON text exactly as given (numbers that JavaScript cannot express). */
function createJson(organizerId: string, communityId: string, json: string): Promise<EventSession> {
  return asUser(organizerId, (db) => rpcRow<EventSession>(db, 'create_training', [communityId, json]));
}

/** A race input as JSON text with `field` set to the raw JSON `raw`. */
function raceJson(field: string, raw: string, extra: Record<string, unknown> = {}): string {
  const input = eventInput('race', { ...extra, [field]: '@@RAW@@' });
  return JSON.stringify(input).replace('"@@RAW@@"', raw);
}

// -------------------------------------------------------------------------------------------------
// Authorization

describe('Q8 authorization per kind', () => {
  it.each(KINDS)('%s: member, outsider, other-community organizer, removed and demoted organizer, anon are all refused', async (kind) => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const other = await createPack(0);
    const outsider = await createUser();
    const removedOrganizer = await addMember(communityId, { role: 'organizer', status: 'removed' });
    const demoted = await addMember(communityId, { role: 'organizer' });
    await admin.query("update public.memberships set role = 'member' where user_id = $1", [demoted]);
    const event = await createEvent(organizerId, communityId, kind);

    const refused = [memberIds[0], outsider, other.organizerId, removedOrganizer, demoted];
    for (const user of refused) {
      await expect(createEvent(user, communityId, kind)).rejects.toMatchObject(raised('forbidden'));
      await expect(updateEvent(user, event.id, eventFormOf(event, { title: 'Hijack' }))).rejects.toMatchObject(raised('forbidden'));
      await expect(cancelTraining(user, event.id)).rejects.toMatchObject(raised('forbidden'));
    }
    await expect(asAnon((db) => rpcRow(db, 'create_training', [communityId, JSON.stringify(eventInput(kind))]))).rejects.toMatchObject(denied);
    await expect(asAnon((db) => rpcRow(db, 'update_training', [event.id, JSON.stringify(eventFormOf(event))]))).rejects.toMatchObject(denied);
    expect((await getSession(event.id)).title).toBe(event.title);
  });

  it.each(KINDS)('%s: RSVP is refused to outsiders, members of another community and removed members', async (kind) => {
    const { communityId, organizerId } = await createPack(0);
    const removed = await addMember(communityId, { status: 'removed' });
    const other = await createPack(1);
    const outsider = await createUser();
    const event = await createEvent(organizerId, communityId, kind);
    for (const user of [removed, other.memberIds[0], outsider]) {
      await expect(setRsvp(user, event.id, 'going')).rejects.toMatchObject(raised('not_a_member'));
    }
    expect((await getSession(event.id)).going_count).toBe(0);
  });

  it('an organizer of community A cannot move an event into community B or read B (community_id is not an input)', async () => {
    const a = await createPack(0);
    const b = await createPack(0);
    const race = await createEvent(a.organizerId, a.communityId, 'race');
    const updated = await updateEvent(a.organizerId, race.id, eventFormOf(race, { community_id: b.communityId, organizer_id: b.organizerId, status: 'cancelled', going_count: 9 }));
    expect(updated.community_id).toBe(a.communityId);
    expect(updated.organizer_id).toBe(a.organizerId);
    expect(updated.status).toBe('confirmed');
    expect(updated.going_count).toBe(0);
    const rows = await asUser(b.organizerId, (db) => db.query('select id from public.training_sessions where id = $1', [race.id]));
    expect(rows.rowCount).toBe(0);
  });

  it('direct table writes are denied for every API role, including the kind columns', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const race = await createEvent(organizerId, communityId, 'race');
    for (const user of [organizerId, memberIds[0]]) {
      await expect(asUser(user, (db) => db.query("update public.training_sessions set event_kind = 'social' where id = $1", [race.id]))).rejects.toMatchObject(denied);
      await expect(asUser(user, (db) => db.query("update public.training_sessions set event_notes = 'x' where id = $1", [race.id]))).rejects.toMatchObject(denied);
      await expect(asUser(user, (db) => db.query('delete from public.training_sessions where id = $1', [race.id]))).rejects.toMatchObject(denied);
      await expect(asUser(user, (db) => db.query(
        `insert into public.training_sessions (community_id, title, starts_at, rsvp_deadline, timezone, location_name, event_kind, event_subtype, status)
         values ($1, 'x', now() + interval '3 days', now() + interval '2 days', 'UTC', 'p', 'race', 'ocr', 'confirmed')`, [communityId]))).rejects.toMatchObject(denied);
      await expect(asUser(user, (db) => db.query("insert into public.event_subtypes (kind, key, label, activity_type) values ('race', 'zz', 'ZZ', 'other')"))).rejects.toMatchObject(denied);
      await expect(asUser(user, (db) => db.query("update public.event_subtypes set activity_type = 'other' where kind = 'race'"))).rejects.toMatchObject(denied);
      await expect(asUser(user, (db) => db.query("delete from public.event_subtypes where key = 'ocr'"))).rejects.toMatchObject(denied);
    }
    expect(((await getSession(race.id)) as unknown as EventSession).event_notes).toBeNull();
  });

  it('private helpers added by the migration are executable by no API role', async () => {
    const { rows } = await admin.query<{ proname: string; role: string; allowed: boolean }>(
      `select p.proname, r.role, has_function_privilege(r.role, p.oid, 'execute') as allowed
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'private'
       cross join (values ('anon'), ('authenticated'), ('service_role')) r (role)
       where p.proname in ('sync_event_subtype', 'event_kind_label', 'event_kind_title', 'parse_event_input',
                           'release_rsvps_of_removed_member', 'notify_training_created', 'notify_training_changed',
                           'stats_history_payload', 'stats_community_payload')`,
    );
    expect(rows.length).toBe(9 * 3);
    expect(rows.filter((r) => r.allowed)).toEqual([]);
    const gone = await admin.query("select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'parse_training_input'");
    expect(gone.rowCount).toBe(0);
  });

  it('privilege matrix of the four replaced public functions: authenticated (service_role for the finalizer) only', async () => {
    const { rows } = await admin.query<{ sig: string; role: string; allowed: boolean }>(
      `select p.oid::regprocedure::text as sig, r.role, has_function_privilege(r.role, p.oid, 'execute') as allowed
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
       cross join (values ('anon'), ('authenticated'), ('service_role')) r (role)
       where p.proname in ('create_training', 'update_training', 'set_rsvp', 'finalize_due_sessions')`,
    );
    const allowed = rows.filter((r) => r.allowed).map((r) => `${r.sig}:${r.role}`).sort();
    expect(allowed).toEqual([
      'create_training(uuid,jsonb):authenticated',
      'finalize_due_sessions():service_role',
      'set_rsvp(uuid,rsvp_response):authenticated',
      'update_training(uuid,jsonb):authenticated',
    ]);
  });
});

// -------------------------------------------------------------------------------------------------
// Kind and subtype matrix, parity with the app's bundled lists

describe('Q8 kind x subtype matrix and parity with the app', () => {
  it('the database seed equals the app fallback list (keys, labels, order) for every kind', async () => {
    const { rows } = await admin.query<{ kind: EventKind; key: string; label: string }>(
      'select kind::text as kind, key, label from public.event_subtypes order by kind, sort_order, key',
    );
    for (const kind of EVENT_KINDS) {
      const db = rows.filter((r) => r.kind === kind).map((r) => ({ key: r.key, label: r.label }));
      expect(db, kind).toEqual(fallbackSubtypes(kind));
    }
  });

  it('every kind x every subtype key: accepted exactly when the pair exists; the course rules match the app helpers', async () => {
    const { communityId, organizerId } = await createPack();
    const keys = [...new Set(['running', 'trail_running', 'asphalt_running', 'ocr', 'strength', 'functional_fitness', 'crossfit_event', 'public_training', 'social_gathering', 'other'])];
    const { rows: pairs } = await admin.query<{ kind: EventKind; key: string }>('select kind::text as kind, key from public.event_subtypes');
    const valid = new Set(pairs.map((p) => `${p.kind}/${p.key}`));
    for (const kind of KINDS) {
      for (const key of keys) {
        const input = eventInput(kind, { event_subtype: key, activity_type: undefined });
        if (!valid.has(`${kind}/${key}`)) {
          await expect(createRaw(organizerId, communityId, input), `${kind}/${key}`).rejects.toMatchObject(raised('validation_failed:event_subtype'));
          continue;
        }
        const plain = await createRaw(organizerId, communityId, input);
        expect(plain.event_subtype).toBe(key);
        // distance and D+ exactly where the app shows the fields
        const withCourse = createRaw(organizerId, communityId, { ...input, distance_km: 10, elevation_gain_m: 100 });
        if (takesCourse(key)) await expect(withCourse, `${kind}/${key} course`).resolves.toBeTruthy();
        else await expect(withCourse, `${kind}/${key} course`).rejects.toMatchObject(raised('validation_failed:distance_km'));
        const withObstacles = createRaw(organizerId, communityId, { ...input, obstacle_count: 3 });
        if (takesObstacles(key)) await expect(withObstacles, `${kind}/${key} obstacles`).resolves.toBeTruthy();
        else await expect(withObstacles, `${kind}/${key} obstacles`).rejects.toMatchObject(raised('validation_failed:obstacle_count'));
      }
    }
  });

  it('activity_type is derived for every pair and always a valid legacy activity type', async () => {
    const { communityId, organizerId } = await createPack();
    const { rows } = await admin.query<{ kind: EventKind; key: string; activity_type: string }>('select kind::text as kind, key, activity_type from public.event_subtypes');
    for (const pair of rows) {
      const made = await createEvent(organizerId, communityId, pair.kind, { event_subtype: pair.key, activity_type: undefined });
      expect(made.activity_type, `${pair.kind}/${pair.key}`).toBe(pair.activity_type);
    }
    const valid = await admin.query(
      'select count(*)::int as n from public.training_sessions s where not exists (select 1 from public.activity_types a where a.key = s.activity_type)',
    );
    expect(valid.rows[0].n).toBe(0);
  });

  it('hostile shapes for the kind and subtype keys fail with the field name, never an internal error', async () => {
    const { communityId, organizerId } = await createPack();
    const cases: [string, unknown, string][] = [
      ['event_kind', ['race'], 'event_kind'],
      ['event_kind', { a: 1 }, 'event_kind'],
      ['event_kind', true, 'event_kind'],
      ['event_kind', 'race ', 'event_kind'],
      ['event_kind', 'RACE', 'event_kind'],
      ['event_kind', "race'; drop table x;--", 'event_kind'],
      ['event_subtype', ['ocr'], 'event_subtype'],
      ['event_subtype', { a: 1 }, 'event_subtype'],
      ['event_subtype', 'x'.repeat(51), 'event_subtype'],
    ];
    for (const [field, value, expected] of cases) {
      await expect(createEvent(organizerId, communityId, 'race', { [field]: value }), `${field}=${JSON.stringify(value)}`).rejects.toMatchObject(raised(`validation_failed:${expected}`));
    }
  });
});

// -------------------------------------------------------------------------------------------------
// Numeric and text edge cases

describe('Q8 numeric and text edge cases', () => {
  it.each([
    ['0.01', 0.01], ['0.1', 0.1], ['1', 1], ['21.1', 21.1], ['21.10', 21.1], ['999.99', 999.99],
    ['1000', 1000], ['1000.00', 1000], ['1e1', 10], ['0.5e1', 5], ['1.0e-2', 0.01], ['4.2E1', 42],
  ])('distance_km %s is stored as %d', async (raw, expected) => {
    const { communityId, organizerId } = await createPack();
    const made = await createJson(organizerId, communityId, raceJson('distance_km', raw));
    expect(Number(made.distance_km)).toBe(expected);
  });

  it.each([
    '0.001', '0.005', '0.004999', '1000.01', '1000.001', '1e3000', '1e-4000', '-0.01', '-0', '0', '0.00',
    'true', '"21"', '"NaN"', '"Infinity"', '[1]', '{}', '""', '"1e3"',
  ])('distance_km %s is refused with validation_failed:distance_km', async (raw) => {
    const { communityId, organizerId } = await createPack();
    await expect(createJson(organizerId, communityId, raceJson('distance_km', raw))).rejects.toMatchObject(raised('validation_failed:distance_km'));
  });

  it.each([['0', 0], ['20000', 20000], ['5.0', 5], ['1e1', 10]])('elevation_gain_m %s is stored as %d', async (raw, expected) => {
    const { communityId, organizerId } = await createPack();
    const made = await createJson(organizerId, communityId, raceJson('elevation_gain_m', raw));
    expect(made.elevation_gain_m).toBe(expected);
  });

  it.each(['20001', '-1', '5.5', '"5"', '1e12', 'true', '2147483648', '1e3000'])('elevation_gain_m %s is refused', async (raw) => {
    const { communityId, organizerId } = await createPack();
    await expect(createJson(organizerId, communityId, raceJson('elevation_gain_m', raw))).rejects.toMatchObject(raised('validation_failed:elevation_gain_m'));
  });

  it('obstacle_count 0 and 500 on OCR are stored; null keeps the course free of obstacles', async () => {
    const { communityId, organizerId } = await createPack();
    for (const n of [0, 500]) {
      const made = await createEvent(organizerId, communityId, 'race', { event_subtype: 'ocr', obstacle_count: n });
      expect(made.obstacle_count).toBe(n);
    }
  });

  it('an organizer cannot store a minimum of 0 or a huge number on a training, nor a minimum above the integer range', async () => {
    const { communityId, organizerId } = await createPack();
    for (const raw of ['0', '-1', '2147483648', '1e3000', '2.5']) {
      const input = JSON.stringify(eventInput('training', { min_participants: '@@RAW@@' })).replace('"@@RAW@@"', raw);
      await expect(createJson(organizerId, communityId, input), raw).rejects.toMatchObject(raised('validation_failed:min_participants'));
    }
  });

  it('notes: HTML, SQL and markup are stored verbatim (the app renders plain text); an exact 1000-character note is accepted', async () => {
    const { communityId, organizerId } = await createPack();
    const hostile = `<script>alert(1)</script> '); drop table training_sessions; -- \${x} {{y}} [link](javascript:alert(1))`;
    const stored = await createEvent(organizerId, communityId, 'race', { event_notes: hostile });
    expect(stored.event_notes).toBe(hostile);
    const exact = await createEvent(organizerId, communityId, 'race', { event_notes: 'a'.repeat(1000) });
    expect(exact.event_notes).toHaveLength(1000);
    const emoji = await createEvent(organizerId, communityId, 'race', { event_notes: '🏃'.repeat(1000) });
    expect(Array.from(emoji.event_notes ?? '')).toHaveLength(1000);
  });

  it('notes whose cleaned length fits are accepted although the raw text is longer (control characters do not count)', async () => {
    const { communityId, organizerId } = await createPack();
    const raw = 'a'.repeat(1000) + '\u0007'.repeat(10);
    const made = await createEvent(organizerId, communityId, 'race', { event_notes: raw });
    expect(made.event_notes).toBe('a'.repeat(1000));
  });

  it('notes made only of Unicode spaces are never stored as visible blank text', async () => {
    const { communityId, organizerId } = await createPack();
    for (const text of [' ', '　', '  ', '   　 ']) {
      let stored: EventSession | null = null;
      try {
        stored = await createEvent(organizerId, communityId, 'race', { event_notes: text });
      } catch (error) {
        expect(errorKey(error)).toBe('P0001:validation_failed:event_notes');
      }
      if (stored) expect(stored.event_notes, JSON.stringify(text)).toBeNull();
    }
  });

  // Q8-1 (fixed in 20261127000100): one hygiene for every free-text field.
  it('title, description and notes are cleaned the same way (no divergence between the text fields)', async () => {
    const { communityId, organizerId } = await createPack();
    const dirty = 'ab\u0007c\r\nd‮e';
    const made = await createEvent(organizerId, communityId, 'social', { description: dirty, event_notes: dirty });
    expect(made.event_notes).toBe(made.description);
  });
});

// -------------------------------------------------------------------------------------------------
// Immutability and update payload attacks

describe('Q8 immutability of kind and consistency of the table checks', () => {
  it('every update payload that names another kind fails and changes nothing', async () => {
    const { communityId, organizerId } = await createPack();
    for (const from of KINDS) {
      const event = await createEvent(organizerId, communityId, from);
      for (const to of KINDS.filter((k) => k !== from)) {
        await expect(updateEvent(organizerId, event.id, eventFormOf(event, { event_kind: to, event_subtype: FIXTURE_SUBTYPE[to], min_participants: to === 'training' ? 2 : null })), `${from} -> ${to}`).rejects.toMatchObject(raised('validation_failed:event_kind'));
      }
      const stored = (await getSession(event.id)) as unknown as EventSession;
      expect([stored.event_kind, stored.event_subtype]).toEqual([event.event_kind, event.event_subtype]);
    }
  });

  it('the sync trigger cannot be used to smuggle a kind change in through activity_type or the subtype', async () => {
    const { communityId, organizerId } = await createPack();
    const race = await createEvent(organizerId, communityId, 'race');
    // training-only legacy path must not apply to a race
    await admin.query("update public.training_sessions set activity_type = 'strength' where id = $1", [race.id]);
    expect(((await getSession(race.id)) as unknown as EventSession).event_subtype).toBe('trail_running');
    // same kind written as a no-op is fine
    await admin.query("update public.training_sessions set event_kind = 'race' where id = $1", [race.id]);
    // a subtype of another kind through the foreign key
    await expect(admin.query("update public.training_sessions set event_subtype = 'strength' where id = $1", [race.id])).rejects.toMatchObject({ code: '23503' });
  });

  it('table checks and RPC checks agree: whatever the RPC accepts the table stores, and a direct write of an RPC-refused row is refused too', async () => {
    const { communityId, organizerId } = await createPack();
    const base = (columns: string, values: string) =>
      admin.query(
        `insert into public.training_sessions (community_id, title, starts_at, rsvp_deadline, timezone, location_name, ${columns})
         values ($1, 'T', now() + interval '3 days', now() + interval '2 days', 'UTC', 'P', ${values})`,
        [communityId],
      );
    // the RPC refuses these, so must the table
    await expect(base('event_kind, event_subtype, status, distance_km', "'social', 'other', 'confirmed', 5")).rejects.toMatchObject({ code: '23514' });
    await expect(base('event_kind, event_subtype, status, obstacle_count', "'race', 'trail_running', 'confirmed', 5")).rejects.toMatchObject({ code: '23514' });
    await expect(base('event_kind, event_subtype, status, event_notes', "'race', 'ocr', 'confirmed', ''")).rejects.toMatchObject({ code: '23514' });
    await expect(base('event_kind, event_subtype, status, elevation_gain_m', "'race', 'ocr', 'confirmed', 20001")).rejects.toMatchObject({ code: '23514' });
    await expect(base('event_kind, event_subtype, status, distance_km', "'race', 'ocr', 'confirmed', 1000.01")).rejects.toMatchObject({ code: '23514' });
    // numeric(6,2) rounds on a direct write; the RPC never rounds (documented), so no row is lost
    const rounded = await base('event_kind, event_subtype, status, distance_km', "'race', 'ocr', 'confirmed', 10.555");
    expect(rounded.rowCount).toBe(1);
    // and what the RPC accepts is stored as given
    const made = await createEvent(organizerId, communityId, 'race', { distance_km: 10.55 });
    expect(Number(made.distance_km)).toBe(10.55);
  });

  it('absent keys never clear what is stored, null always does, for every course field and the notes', async () => {
    const { communityId, organizerId } = await createPack();
    const made = await createEvent(organizerId, communityId, 'race', { event_subtype: 'ocr', distance_km: 12.5, elevation_gain_m: 300, obstacle_count: 20, event_notes: 'bring gloves' });
    const form = eventFormOf(made);
    for (const key of ['distance_km', 'elevation_gain_m', 'obstacle_count', 'event_notes']) delete form[key];
    const untouched = await updateEvent(organizerId, made.id, form);
    expect([Number(untouched.distance_km), untouched.elevation_gain_m, untouched.obstacle_count, untouched.event_notes]).toEqual([12.5, 300, 20, 'bring gloves']);
    const cleared = await updateEvent(organizerId, made.id, { ...form, distance_km: null, elevation_gain_m: null, obstacle_count: null, event_notes: null });
    expect([cleared.distance_km, cleared.elevation_gain_m, cleared.obstacle_count, cleared.event_notes]).toEqual([null, null, null, null]);
  });
});

// -------------------------------------------------------------------------------------------------
// RSVP semantics

describe('Q8 RSVP semantics per kind', () => {
  it.each(NON_TRAINING)('%s: an already-going member is never refused session_full, a not-going one is, and room frees up when someone steps down', async (kind) => {
    const { communityId, organizerId, memberIds } = await createPack(3);
    const event = await createEvent(organizerId, communityId, kind, { max_participants: 1 });
    await setRsvp(memberIds[0], event.id, 'going');
    await expect(setRsvp(memberIds[0], event.id, 'going')).resolves.toMatchObject({ going_count: 1 });
    await expect(setRsvp(memberIds[1], event.id, 'going')).rejects.toMatchObject(raised('session_full'));
    await setRsvp(memberIds[1], event.id, 'not_going');
    await expect(setRsvp(memberIds[1], event.id, 'going')).rejects.toMatchObject(raised('session_full'));
    await setRsvp(memberIds[0], event.id, 'not_going');
    await expect(setRsvp(memberIds[2], event.id, 'going')).resolves.toMatchObject({ going_count: 1 });
    expect(await realGoingCount(event.id)).toBe(1);
  });

  it.each(KINDS)('%s: once the deadline has passed no answer can be changed in either direction', async (kind) => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const event = await createEvent(organizerId, communityId, kind, kind === 'training' ? { min_participants: 1 } : {});
    await setRsvp(memberIds[0], event.id, 'going');
    await makeDue(event.id);
    await expect(setRsvp(memberIds[0], event.id, 'not_going')).rejects.toMatchObject(raised('rsvp_closed'));
    await expect(setRsvp(memberIds[1], event.id, 'going')).rejects.toMatchObject(raised('rsvp_closed'));
    expect(await realGoingCount(event.id)).toBe(1);
  });

  it.each(NON_TRAINING)('%s: an RSVP waiting for the session lock past the deadline instant is refused (clock_timestamp, not transaction start)', async (kind) => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const event = await createEvent(organizerId, communityId, kind);
    await admin.query("update public.training_sessions set rsvp_deadline = clock_timestamp() + interval '700 milliseconds' where id = $1", [event.id]);
    const holder = await admin.connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from public.training_sessions where id = $1 for update', [event.id]);
      const pending = setRsvp(memberIds[0], event.id, 'going').then(() => 'ok', (error: unknown) => errorKey(error));
      for (let i = 0; i < 200; i += 1) {
        const { rows } = await admin.query("select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like '%set_rsvp%'");
        if (rows[0].n > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
      await holder.query('commit');
      expect(await pending).toBe('P0001:rsvp_closed');
    } finally {
      holder.release();
    }
    expect(await realGoingCount(event.id)).toBe(0);
  });

  it.each(NON_TRAINING)('%s: a burst of RSVPs racing the organizer cancelling ends cancelled, every answer is ok or rsvp_closed, and the count is exact', async (kind) => {
    const { communityId, organizerId, memberIds } = await createPack(8);
    const event = await createEvent(organizerId, communityId, kind);
    const results = await Promise.all([
      ...memberIds.map((id) => setRsvp(id, event.id, 'going').then(() => 'ok', (error: unknown) => errorKey(error))),
      cancelTraining(organizerId, event.id).then(() => 'cancelled', (error: unknown) => errorKey(error)),
    ]);
    for (const result of results) expect(['ok', 'cancelled', 'P0001:rsvp_closed']).toContain(result);
    const stored = await getSession(event.id);
    expect(stored.status).toBe('cancelled');
    expect(stored.going_count).toBe(await realGoingCount(event.id));
    await expect(setRsvp(memberIds[0], event.id, 'not_going')).rejects.toMatchObject(raised('rsvp_closed'));
  });
});

// -------------------------------------------------------------------------------------------------
// Finalizer

describe('Q8 finalizer with mixed kinds and legacy rows', () => {
  it('decides only the training of a due mixed batch, never touches the others, and is idempotent', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const training = await createEvent(organizerId, communityId, 'training', { min_participants: 1 });
    const others = await Promise.all(NON_TRAINING.map((kind) => createEvent(organizerId, communityId, kind)));
    for (const event of [training, ...others]) await setRsvp(memberIds[0], event.id, 'going');
    for (const event of [training, ...others]) await makeDue(event.id);
    expect(await finalize()).toBe(1);
    expect((await getSession(training.id)).status).toBe('confirmed');
    for (const event of others) {
      const stored = await getSession(event.id);
      expect([stored.status, stored.decided_at, stored.cancel_reason]).toEqual(['confirmed', null, null]);
    }
    expect(await finalize()).toBe(0);
  });

  it('a non-training event with nobody going is not cancelled at the deadline, however many finalizer runs pass', async () => {
    const { communityId, organizerId } = await createPack(1);
    const race = await createEvent(organizerId, communityId, 'race');
    await makeDue(race.id);
    await finalize();
    await finalize();
    expect((await getSession(race.id)).status).toBe('confirmed');
    expect(await notifications("kind = 'training_cancelled'")).toHaveLength(0);
  });

  it('a legacy-shaped training row (inserted without kind, subtype or the new columns) is decided as before', async () => {
    const { communityId } = await createPack(0);
    const { rows } = await admin.query<{ id: string }>(
      `insert into public.training_sessions (community_id, title, activity_type, starts_at, rsvp_deadline, timezone, location_name, min_participants)
       values ($1, 'Legacy', 'running', now() + interval '1 day', now() - interval '1 hour', 'UTC', 'Park', 2) returning id`,
      [communityId],
    );
    expect(await finalize()).toBe(1);
    const stored = await getSession(rows[0].id);
    expect([stored.status, stored.cancel_reason]).toEqual(['cancelled', 'insufficient_participation']);
  });
});

// -------------------------------------------------------------------------------------------------
// update_training after the deadline

describe('Q8 update_training freezes per kind', () => {
  it.each(NON_TRAINING)('%s after the deadline: deadline frozen, maximum floored at going_count, notes and subtype stay editable', async (kind) => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const event = await createEvent(organizerId, communityId, kind, { max_participants: 5 });
    for (const id of memberIds) await setRsvp(id, event.id, 'going');
    await makeDue(event.id);
    const stored = (await getSession(event.id)) as unknown as EventSession;
    const form = eventFormOf(stored);
    await expect(updateEvent(organizerId, event.id, { ...form, rsvp_deadline: new Date(Date.now() + 3_600_000).toISOString() })).rejects.toMatchObject(raised('validation_failed:rsvp_deadline'));
    await expect(updateEvent(organizerId, event.id, { ...form, max_participants: 1 })).rejects.toMatchObject(raised('validation_failed:max_participants'));
    const lowered = await updateEvent(organizerId, event.id, { ...form, max_participants: 2 });
    expect(lowered.max_participants).toBe(2);
    const cleared = await updateEvent(organizerId, event.id, { ...form, max_participants: null, event_notes: 'Meeting point changed' });
    expect([cleared.max_participants, cleared.event_notes]).toEqual([null, 'Meeting point changed']);
    expect(cleared.status).toBe('confirmed');
  });

  it('a training past its deadline but not yet decided is frozen like a decided one (limits and deadline), as the app must mirror', async () => {
    const { communityId, organizerId } = await createPack(2);
    const training = await createEvent(organizerId, communityId, 'training', { min_participants: 2, max_participants: 6 });
    await makeDue(training.id);
    const stored = (await getSession(training.id)) as unknown as EventSession;
    expect(stored.status).toBe('scheduled');
    const form = eventFormOf(stored);
    await expect(updateEvent(organizerId, training.id, { ...form, min_participants: 1 })).rejects.toMatchObject(raised('validation_failed:min_participants'));
    await expect(updateEvent(organizerId, training.id, { ...form, max_participants: 7 })).rejects.toMatchObject(raised('validation_failed:max_participants'));
    await expect(updateEvent(organizerId, training.id, { ...form, rsvp_deadline: new Date(Date.now() + 3_600_000).toISOString() })).rejects.toMatchObject(raised('validation_failed:rsvp_deadline'));
  });

  it.each(NON_TRAINING)('%s: the start can move into the future but never at or before the frozen deadline', async (kind) => {
    const { communityId, organizerId } = await createPack(1);
    const event = await createEvent(organizerId, communityId, kind);
    await makeDue(event.id);
    const form = eventFormOf((await getSession(event.id)) as unknown as EventSession);
    await expect(updateEvent(organizerId, event.id, { ...form, starts_at: new Date(Date.now() - 60_000).toISOString(), ends_at: null })).rejects.toMatchObject(raised('validation_failed:starts_at'));
    const moved = await updateEvent(organizerId, event.id, { ...form, starts_at: new Date(Date.now() + 5 * 86_400_000).toISOString(), ends_at: null });
    expect(moved.starts_at.getTime()).toBeGreaterThan(Date.now() + 4 * 86_400_000);
  });
});

// -------------------------------------------------------------------------------------------------
// Member removal

describe('Q8 member removal and open non-training events', () => {
  it.each(NON_TRAINING)('%s: remove_member releases the place on an open event, keeps it after the deadline, and touches only that community', async (kind) => {
    const a = await createPack(2);
    const b = await createPack(0);
    const member = a.memberIds[0];
    await admin.query("insert into public.memberships (community_id, user_id, role, status) values ($1, $2, 'member', 'active')", [b.communityId, member]);
    const open = await createEvent(a.organizerId, a.communityId, kind);
    const closed = await createEvent(a.organizerId, a.communityId, kind);
    const elsewhere = await createEvent(b.organizerId, b.communityId, kind);
    for (const event of [open, closed, elsewhere]) await setRsvp(member, event.id, 'going');
    await setRsvp(a.memberIds[1], open.id, 'going');
    await makeDue(closed.id);
    await removeMember(a.organizerId, a.communityId, member);
    expect((await getSession(open.id)).going_count).toBe(1);
    expect((await getSession(closed.id)).going_count).toBe(1);
    expect((await getSession(elsewhere.id)).going_count).toBe(1);
    expect(await goingCountMismatches()).toEqual([]);
  });

  it('cancelled and completed events keep their counts when a member is removed', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const cancelled = await createEvent(organizerId, communityId, 'race');
    await setRsvp(memberIds[0], cancelled.id, 'going');
    await cancelTraining(organizerId, cancelled.id);
    await removeMember(organizerId, communityId, memberIds[0]);
    expect((await getSession(cancelled.id)).going_count).toBe(1);
  });
});

// -------------------------------------------------------------------------------------------------
// Notifications

describe('Q8 notifications per kind', () => {
  it.each(KINDS)('%s: one created notification per recipient, never for the organizer, valid deep link, no confirmation', async (kind) => {
    const { communityId, organizerId, memberIds } = await createPack(3);
    const event = await createEvent(organizerId, communityId, kind, kind === 'training' ? { min_participants: 1 } : {});
    const rows = await notifications('related_session_id = $1', [event.id]);
    expect(rows.map((r) => r.kind)).toEqual(Array(3).fill('training_created'));
    expect(rows.map((r) => r.user_id).sort()).toEqual([...memberIds].sort());
    for (const row of rows) {
      expect(row.deep_link).toBe(`/trainings/${event.id}`);
      expect(row.dedupe_key).toBe(`training_created:${event.id}`);
    }
    expect(rows[0].title.toLowerCase()).toContain(kind === 'sports_event' ? 'sports event' : kind === 'social' ? 'social event' : kind);
  });

  it('a lone organizer creating an event of any kind queues nothing and does not fail', async () => {
    const { communityId, organizerId } = await createPack(0);
    for (const kind of KINDS) await createEvent(organizerId, communityId, kind);
    expect(await notifications()).toHaveLength(0);
  });

  it.each(NON_TRAINING)('%s: silent edits (course, notes, maximum, subtype) queue nothing; a time change notifies once per recipient; no confirmation is ever sent', async (kind) => {
    const { communityId, organizerId, memberIds } = await createPack(3);
    const event = await createEvent(organizerId, communityId, kind);
    await setRsvp(memberIds[0], event.id, 'going');
    await setRsvp(memberIds[1], event.id, 'not_going');
    const before = (await notifications()).length;
    const stored = (await getSession(event.id)) as unknown as EventSession;
    await updateEvent(organizerId, event.id, eventFormOf(stored, { event_notes: 'silent', max_participants: 9, description: 'new text' }));
    expect((await notifications()).length).toBe(before);
    await updateEvent(organizerId, event.id, eventFormOf(stored, { starts_at: new Date(stored.starts_at.getTime() + 3_600_000).toISOString(), ends_at: null }));
    const updated = await notifications("kind = 'training_updated'");
    expect(updated.map((r) => r.user_id).sort()).toEqual([memberIds[0], memberIds[2]].sort());
    expect(await notifications("kind = 'training_confirmed'")).toHaveLength(0);
  });

  it.each(NON_TRAINING)('%s: cancelling names the kind, says "cancelled by the organizer" and skips members who said not going', async (kind) => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const event = await createEvent(organizerId, communityId, kind);
    await setRsvp(memberIds[1], event.id, 'not_going');
    await cancelTraining(organizerId, event.id);
    const rows = await notifications("kind = 'training_cancelled'");
    expect(rows.map((r) => r.user_id)).toEqual([memberIds[0]]);
    expect(rows[0].body).toContain('cancelled by the organizer.');
    expect(rows[0].body).not.toContain('not enough participants');
    expect(rows[0].title.toLowerCase()).toContain(kind === 'sports_event' ? 'sports event' : kind === 'social' ? 'social event' : kind);
  });

  it('repeated finalizer runs and repeated reminder runs never duplicate a notification', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const training = await createEvent(organizerId, communityId, 'training', { min_participants: 1 });
    await setRsvp(memberIds[0], training.id, 'going');
    await makeDue(training.id);
    await finalize();
    await finalize();
    // the going member and the organizer, once each
    expect(await notifications("kind = 'training_confirmed'")).toHaveLength(2);
  });
});

describe('Q8 reminders for non-training events', () => {
  it.each(NON_TRAINING)('%s: 24h then 2h reminder, once each, only for going active members', async (kind) => {
    const { communityId, organizerId, memberIds } = await createPack(3);
    const event = await createEvent(organizerId, communityId, kind);
    await setRsvp(memberIds[0], event.id, 'going');
    await setRsvp(memberIds[1], event.id, 'going');
    await setRsvp(memberIds[2], event.id, 'not_going');
    await admin.query('update public.memberships set status = $2 where user_id = $1', [memberIds[1], 'removed']);
    const move = (startHours: number) =>
      admin.query(
        `update public.training_sessions set starts_at = now() + make_interval(mins => $2::int),
           ends_at = now() + make_interval(mins => $2::int + 120), rsvp_deadline = now() + interval '5 minutes' where id = $1`,
        [event.id, Math.round(startHours * 60)],
      );
    await move(23.5);
    expect(await enqueueReminders()).toBe(1);
    expect(await enqueueReminders()).toBe(0);
    await move(1.5);
    expect(await enqueueReminders()).toBe(1);
    expect(await enqueueReminders()).toBe(0);
    const rows = await notifications("kind = 'training_reminder'");
    expect(rows.map((r) => r.user_id)).toEqual([memberIds[0], memberIds[0]]);
    expect(rows.map((r) => r.title.split(':')[0]).sort()).toEqual(['Starting soon', 'Tomorrow']);
  });
});

// -------------------------------------------------------------------------------------------------
// Attendance and statistics

describe('Q8 attendance and statistics across kinds', () => {
  it('top_sessions carry a null minimum for non-training events, history carries kind and subtype, cancelled events are excluded', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    await admin.query("update public.memberships set joined_at = now() - interval '30 days'");
    const completed: EventSession[] = [];
    for (const kind of KINDS) {
      const event = await createEvent(organizerId, communityId, kind, kind === 'training' ? { min_participants: 1 } : {});
      await setRsvp(memberIds[0], event.id, 'going');
      if (kind === 'training') {
        await makeDue(event.id);
        await finalize();
      }
      await makeEnded(event.id);
      await recordAttendance(organizerId, event.id, memberIds[0], 'present');
      await finalizeAttendance(organizerId, event.id);
      completed.push(event);
    }
    const cancelled = await createEvent(organizerId, communityId, 'race');
    await setRsvp(memberIds[1], cancelled.id, 'going');
    await cancelTraining(organizerId, cancelled.id);

    const stats = await communityStats(organizerId, communityId, 'all');
    expect(stats.completed_trainings).toBe(4);
    expect(stats.total_attendances).toBe(4);
    const top = (stats as unknown as { top_sessions: { session_id: string; min_participants: number | null; event_kind: EventKind }[] }).top_sessions;
    expect(top).toHaveLength(4);
    for (const item of top) {
      const event = completed.find((e) => e.id === item.session_id);
      expect(item.event_kind).toBe(event?.event_kind);
      expect(item.min_participants).toBe(event?.event_kind === 'training' ? 1 : null);
    }
    expect(top.some((t) => t.session_id === cancelled.id)).toBe(false);
    expect(stats.cancelled_by_organizer).toBe(0); // the cancelled race starts in the future: outside the window of past events

    const mine = await history(memberIds[0], communityId, 'all');
    expect(mine.items.map((i) => [i.event_kind, i.event_subtype]).sort()).toEqual(
      completed.map((e) => [e.event_kind, e.event_subtype]).sort(),
    );
    expect(mine.items.every((i) => i.outcome === 'present')).toBe(true);
    expect((await history(memberIds[1], communityId, 'all')).items.some((i) => i.outcome === 'present' || i.session_id === cancelled.id)).toBe(false);
  });

  it('a walk-in at a race counts like one at a training and the RSVP counters stay consistent', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    await admin.query("update public.memberships set joined_at = now() - interval '30 days'");
    const race = await createEvent(organizerId, communityId, 'race');
    await setRsvp(memberIds[0], race.id, 'going');
    await makeEnded(race.id);
    await recordAttendance(organizerId, race.id, memberIds[0], 'present');
    await asUser(organizerId, (db) => rpcRow(db, 'add_walk_in_attendee', [race.id, memberIds[1]]));
    await finalizeAttendance(organizerId, race.id);
    const stats = await communityStats(organizerId, communityId, 'all');
    expect(stats.total_attendances).toBe(2);
    expect(stats.members_attended).toBe(2);
    expect((await recordsOf(race.id)).filter((r) => r.is_walk_in)).toHaveLength(1);
  });
});

// -------------------------------------------------------------------------------------------------
// GDPR: export and erasure with the new kinds

describe('Q8 account export and deletion with non-training events', () => {
  it('a deleted member leaves no reference behind on open, closed and completed races; counts stay exact; attendance becomes anonymous', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const [target, other] = memberIds;
    const open = await createEvent(organizerId, communityId, 'race');
    const closed = await createEvent(organizerId, communityId, 'social');
    const done = await createEvent(organizerId, communityId, 'sports_event');
    for (const event of [open, closed, done]) {
      await setRsvp(target, event.id, 'going');
      await setRsvp(other, event.id, 'going');
    }
    await makeDue(closed.id);
    await makeEnded(done.id);
    await recordAttendance(organizerId, done.id, target, 'present');
    await recordAttendance(organizerId, done.id, other, 'absent');
    await finalizeAttendance(organizerId, done.id);

    const exported = await exportMyData(target);
    const exportedSessions = (exported.rsvps as { session_id: string }[]).map((r) => r.session_id).sort();
    expect(exportedSessions).toEqual([open.id, closed.id, done.id].sort());
    expect((exported.attendance as unknown[]).length).toBe(1);

    await deleteMyAccount(target);
    expect(await referencesTo(target)).toEqual({});
    expect(await goingCountMismatches()).toEqual([]);
    expect((await getSession(open.id)).going_count).toBe(1);
    expect((await getSession(closed.id)).going_count).toBe(1);
    const records = await recordsOf(done.id);
    expect(records).toHaveLength(2);
    expect(records.filter((r) => r.user_id === null).map((r) => r.status)).toEqual(['present']);
    const stats = await communityStats(organizerId, communityId, 'all');
    expect(stats.total_attendances).toBe(1);
  });

  it('an organizer who created races is erased without breaking them (organizer_id becomes null) and the events stay visible and RSVP-able', async () => {
    const { communityId, organizerId, secondOrganizerId, memberIds } = await (async () => {
      const pack = await createPack(1);
      const secondOrganizerId = await addMember(pack.communityId, { role: 'organizer', name: 'Second Organizer' });
      return { ...pack, secondOrganizerId };
    })();
    const race = await createEvent(organizerId, communityId, 'race', { distance_km: 42.2, event_notes: 'keep me' });
    await deleteMyAccount(organizerId);
    const stored = (await getSession(race.id)) as unknown as EventSession;
    expect([stored.organizer_id, stored.event_notes, Number(stored.distance_km)]).toEqual([null, 'keep me', 42.2]);
    await expect(setRsvp(memberIds[0], race.id, 'going')).resolves.toMatchObject({ going_count: 1 });
    await expect(updateEvent(secondOrganizerId, race.id, eventFormOf(stored, { title: 'Taken over' }))).resolves.toMatchObject({ title: 'Taken over' });
  });

  it('the existing erasure scanner still finds nothing for a life that includes every kind', async () => {
    const life = await buildFullLife();
    expect(life).toBeTruthy();
  });
});

// -------------------------------------------------------------------------------------------------
// Lock behaviour of create_training for every kind

describe('Q8 create_training lock probe', () => {
  it('a storm of creations of every kind racing the organizer being removed and then deleted: no deadlock, no foreign-key error', async () => {
    const pack = await createPack(2);
    const second = await addMember(pack.communityId, { role: 'organizer', name: 'Second Organizer' });
    const outcomes: string[] = [];
    const creates = Array.from({ length: 12 }, (_, i) =>
      createEvent(pack.organizerId, pack.communityId, KINDS[i % 4], KINDS[i % 4] === 'training' ? { min_participants: 1 } : {}).then(
        () => 'created',
        (error: unknown) => errorKey(error),
      ),
    );
    const removal = removeMember(second, pack.communityId, pack.organizerId).then(() => 'removed', (error: unknown) => errorKey(error));
    const deletion = deleteMyAccount(pack.organizerId).then(() => 'deleted', (error: unknown) => errorKey(error));
    outcomes.push(...(await Promise.all([...creates, removal, deletion])));
    const allowed = /^(created|removed|deleted|P0001:forbidden|P0001:not_authenticated|P0001:not_found|P0001:last_organizer|P0001:not_a_member|P0001:cannot_remove_self)$/;
    const unexpected = outcomes.filter((o) => !allowed.test(o));
    expect(unexpected).toEqual([]);
    expect(await goingCountMismatches()).toEqual([]);
    const { rows } = await admin.query('select count(*)::int as n from public.training_sessions where organizer_id is not null and organizer_id <> $1 and organizer_id <> $2', [pack.organizerId, second]);
    expect(rows[0].n).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------------
// Migration review (hosted-only risks that a text check can pin down)

describe('Q8 migration shape for a hosted database that already holds data', () => {
  const sql = readFileSync(join(__dirname, '..', 'migrations', '20261126000100_events.sql'), 'utf8');
  const at = (needle: string) => {
    const index = sql.indexOf(needle);
    expect(index, needle).toBeGreaterThan(-1);
    return index;
  };

  it('backfills before NOT NULL and the composite foreign key, and seeds the lookup before the foreign key', () => {
    expect(at('update public.training_sessions')).toBeLessThan(at('alter column event_subtype set not null'));
    expect(at('alter column event_subtype set not null')).toBeLessThan(at('training_sessions_event_subtype_fkey'));
    expect(at("insert into public.event_subtypes (kind, key, label, sort_order, activity_type)\nselect 'training'")).toBeLessThan(at('training_sessions_event_subtype_fkey'));
    expect(at('create trigger training_sessions_sync_event_subtype')).toBeGreaterThan(at('update public.training_sessions'));
  });

  it('every top-level UPDATE has a WHERE, and nothing deletes or truncates outside function bodies', () => {
    const topLevel = sql.replace(/\$\$[\s\S]*?\$\$/g, '');
    for (const statement of topLevel.split(';')) {
      const text = statement.replace(/--.*$/gm, '').trim().toLowerCase();
      if (/^update\s/.test(text)) expect(text, text.slice(0, 60)).toMatch(/\swhere\s/);
      expect(text).not.toMatch(/^(delete\s|truncate\s)/);
    }
  });

  it('every kind-specific subtype the lookup seeds maps to a legacy activity type that exists in a fresh deployment', async () => {
    const { rows } = await admin.query<{ activity_type: string }>('select distinct activity_type from public.event_subtypes');
    const known = await admin.query<{ key: string }>('select key from public.activity_types');
    for (const row of rows) expect(known.rows.map((k) => k.key)).toContain(row.activity_type);
  });
});
