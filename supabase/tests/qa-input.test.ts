import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  admin,
  asUser,
  closeDb,
  countRows,
  createCommunity,
  createPack,
  createTraining,
  createUser,
  getSession,
  hoursFromNow,
  insertInvitation,
  resetData,
  rpc,
  rpcRow,
  type Session,
  setRsvp,
  trainingInput,
  updateTraining,
} from './helpers';
import { formOf, raised } from './qa-helpers';

/**
 * QA (M1-Q1): hostile and malformed input (jsonb type confusion, oversized strings, special
 * timestamp words, injection strings) and time zone edge cases.
 */

const STRING_KEYS = ['title', 'description', 'activity_type', 'timezone', 'location_name', 'address', 'map_url', 'meeting_instructions'];
const TIMESTAMP_KEYS = ['starts_at', 'ends_at', 'rsvp_deadline'];
const NUMBER_KEYS = ['latitude', 'longitude', 'min_participants', 'max_participants'];

const WRONG_TYPES: [string, unknown][] = [
  ['an object', { $ne: null }],
  ['an array', ['x']],
  ['a boolean', true],
];

const create = (userId: string, communityId: string, input: unknown) =>
  asUser(userId, (db) => rpcRow<Session>(db, 'create_training', [communityId, JSON.stringify(input)]));

beforeEach(resetData);
afterAll(closeDb);

describe('QA jsonb type confusion', () => {
  it('every field rejects every wrong JSON type with validation_failed:<field>, on create and update', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId);
    const cases: [string, unknown][] = [];
    for (const key of [...STRING_KEYS, ...TIMESTAMP_KEYS, ...NUMBER_KEYS]) {
      for (const [, value] of WRONG_TYPES) cases.push([key, value]);
    }
    for (const key of [...STRING_KEYS, ...TIMESTAMP_KEYS]) cases.push([key, 12345]);
    for (const key of NUMBER_KEYS) cases.push([key, '3']);

    for (const [key, value] of cases) {
      const label = `${key} = ${JSON.stringify(value)}`;
      await expect(create(organizerId, communityId, trainingInput({ [key]: value })), label).rejects.toMatchObject(
        raised(`validation_failed:${key}`),
      );
      await expect(updateTraining(organizerId, session.id, formOf(session, { [key]: value })), label).rejects.toMatchObject(
        raised(`validation_failed:${key}`),
      );
    }
    expect(await countRows('training_sessions')).toBe(1);
    expect(await getSession(session.id)).toEqual(session);
  });

  it('rejects oversized strings without storing anything', async () => {
    const { communityId, organizerId } = await createPack();
    const huge = 'x'.repeat(1_000_000);
    for (const key of STRING_KEYS) {
      await expect(create(organizerId, communityId, trainingInput({ [key]: huge })), key).rejects.toMatchObject(
        raised(`validation_failed:${key}`),
      );
    }
    for (const key of TIMESTAMP_KEYS) {
      await expect(create(organizerId, communityId, trainingInput({ [key]: `2099-01-01T10:00:00Z${huge}` })), key).rejects.toMatchObject(
        raised(`validation_failed:${key}`),
      );
    }
    expect(await countRows('training_sessions')).toBe(0);
  });

  it('rejects special timestamp words and non-ISO forms that Postgres itself would accept', async () => {
    const { communityId, organizerId } = await createPack();
    const year = new Date().getUTCFullYear() + 2;
    const words = [
      'now', 'today', 'tomorrow', 'allballs', 'epoch', 'infinity', '-infinity',
      `${year}-06-01`, `${year}-06-01T10:00:00`, `${year}-06-01T10:00:00 Europe/Bucharest`, `${year}-06-01T10:00:00 EET`,
      `June 1, ${year} 10:00 UTC`, `1${year}-06-01T10:00:00Z`, `${year}-06-01T10:00:00Z; drop table public.training_sessions`,
      `${year}-13-01T10:00:00Z`, `${year}-06-31T10:00:00Z`, `${year}-06-01T25:00:00Z`, `${year}-06-01T10:00:00+99:00`,
    ];
    for (const word of words) {
      await expect(create(organizerId, communityId, trainingInput({ starts_at: word })), word).rejects.toMatchObject(
        raised('validation_failed:starts_at'),
      );
    }
    expect(await countRows('training_sessions')).toBe(0);
  });

  it('rejects numbers that are not usable integers or coordinates', async () => {
    const { communityId, organizerId } = await createPack();
    const bad: [string, unknown][] = [
      ['min_participants', -1],
      ['min_participants', 1.0000001],
      ['min_participants', 2 ** 31],
      ['min_participants', 1e30],
      ['max_participants', -5],
      ['max_participants', 0],
      ['max_participants', 2 ** 31],
      ['latitude', -90.000001],
      ['longitude', 180.000001],
      ['latitude', 1e308],
    ];
    for (const [key, value] of bad) {
      await expect(create(organizerId, communityId, trainingInput({ [key]: value })), `${key} = ${value}`).rejects.toMatchObject(
        raised(`validation_failed:${key}`),
      );
    }
    // NaN and Infinity are not JSON: the request fails before the function runs.
    await expect(
      asUser(organizerId, (db) => db.query("select public.create_training($1, '{\"min_participants\": NaN}')", [communityId])),
    ).rejects.toMatchObject({ code: '22P02' });
    expect(await countRows('training_sessions')).toBe(0);
  });

  it('stores injection strings verbatim and executes nothing', async () => {
    const { communityId, organizerId } = await createPack();
    const evil = "Robert'); drop table public.training_rsvps; -- $$ \\ \" %s {0}";
    const session = await createTraining(organizerId, communityId, {
      title: evil,
      description: evil,
      location_name: evil,
      address: evil,
      meeting_instructions: evil,
    });

    expect(session).toMatchObject({ title: evil, description: evil, location_name: evil, address: evil, meeting_instructions: evil });
    expect(await countRows('training_rsvps')).toBe(0);
    for (const code of ["' or '1'='1", 'MEMBER22%', "x'; select pg_sleep(5); --", '\\', '%', '_'.repeat(8)]) {
      const user = await createUser();
      expect(await asUser(user, (db) => rpc(db, 'preview_invitation', [code])), code).toEqual({ ok: false, error: 'invalid_code' });
    }
  });

  it('invitation RPCs survive null, empty and megabyte-sized codes and names', async () => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'MEMBER22');
    for (const code of [null, '', '   ', '-'.repeat(100), 'A'.repeat(1_000_000), 'MEMBER22MEMBER22', 'MEMBER2']) {
      const user = await createUser();
      expect(await asUser(user, (db) => rpc(db, 'preview_invitation', [code]))).toEqual({ ok: false, error: 'invalid_code' });
      expect(await asUser(user, (db) => rpc(db, 'redeem_invitation', [code, 'Ana Runner']))).toEqual({ ok: false, error: 'invalid_code' });
    }
    const user = await createUser();
    for (const name of [null, '', ' ', 'A', '\n\t', 'x'.repeat(1_000_000)]) {
      expect(await asUser(user, (db) => rpc(db, 'redeem_invitation', ['MEMBER22', name]))).toEqual({ ok: false, error: 'invalid_display_name' });
    }
    expect(await countRows('memberships')).toBe(0);
    expect(await countRows('profiles')).toBe(0);
  });

  it('set_rsvp rejects a response outside the enum before touching anything', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const session = await createTraining(organizerId, communityId);
    for (const response of ['GOING', 'maybe', '', 'going; drop table x']) {
      await expect(
        asUser(memberIds[0], (db) => db.query('select public.set_rsvp($1, $2)', [session.id, response])),
      ).rejects.toMatchObject({ code: '22P02' });
    }
    expect(await countRows('training_rsvps')).toBe(0);
  });
});

describe('QA deadline rules at the edges', () => {
  it('the default deadline is exactly start - 2h, and an explicit deadline may equal the start', async () => {
    const { communityId, organizerId } = await createPack();
    const start = hoursFromNow(30);

    const byDefault = await createTraining(organizerId, communityId, { starts_at: start, ends_at: null, rsvp_deadline: null });
    const atStart = await createTraining(organizerId, communityId, { starts_at: start, ends_at: null, rsvp_deadline: start });

    expect(byDefault.starts_at.getTime() - byDefault.rsvp_deadline.getTime()).toBe(2 * 3_600_000);
    // OBSERVATION Q1-O2: the spec says "deadline before start"; the contract allows equality.
    expect(atStart.rsvp_deadline).toEqual(atStart.starts_at);
  });

  // OBSERVATION Q1-O3: a training that starts in less than two hours cannot be created without
  // an explicit deadline, and the error names a field the organizer did not fill in.
  it('a start less than 2h away needs an explicit deadline', async () => {
    const { communityId, organizerId } = await createPack();
    const soon = hoursFromNow(1);

    await expect(
      create(organizerId, communityId, trainingInput({ starts_at: soon, ends_at: null, rsvp_deadline: null })),
    ).rejects.toMatchObject(raised('validation_failed:rsvp_deadline'));
    const explicit = await createTraining(organizerId, communityId, { starts_at: soon, ends_at: null, rsvp_deadline: hoursFromNow(0.5) });
    expect(explicit.status).toBe('scheduled');
  });

  it('an update cannot make the deadline later than the start or the end earlier than the start', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId);

    await expect(
      updateTraining(organizerId, session.id, formOf(session, { starts_at: hoursFromNow(40) })),
    ).rejects.toMatchObject(raised('validation_failed:rsvp_deadline'));
    await expect(
      updateTraining(organizerId, session.id, formOf(session, { starts_at: hoursFromNow(80) })),
    ).rejects.toMatchObject(raised('validation_failed:ends_at'));
    expect(await getSession(session.id)).toEqual(session);
  });

  it('table constraints reject inconsistent rows even from a privileged writer', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const session = await createTraining(organizerId, communityId, { min_participants: 2, max_participants: 3 });
    await setRsvp(memberIds[0], session.id, 'going');
    const statements = [
      "set rsvp_deadline = starts_at + interval '1 second'",
      "set ends_at = starts_at",
      'set max_participants = 1',
      'set min_participants = 0',
      'set going_count = -1',
      'set going_count = 4',
      "set status = 'cancelled'",
      "set cancel_reason = 'organizer'",
      "set title = ' padded '",
      'set latitude = null',
    ];
    for (const set of statements) {
      await expect(
        admin.query(`update public.training_sessions ${set} where id = $1`, [session.id]),
        set,
      ).rejects.toMatchObject({ code: '23514' });
    }
  });
});

describe('QA time zones', () => {
  /** The last Sunday of October (end of DST in Europe/Bucharest) two years from now. */
  function fallBackDay(): string {
    const date = new Date(Date.UTC(new Date().getUTCFullYear() + 2, 9, 31));
    date.setUTCDate(31 - date.getUTCDay());
    return date.toISOString().slice(0, 10);
  }

  it('keeps the two instants of the repeated hour apart on the fall-back day', async () => {
    const { communityId, organizerId } = await createPack();
    const day = fallBackDay();

    // 03:30 local happens twice: first in EEST (+03:00), then in EET (+02:00).
    const first = await createTraining(organizerId, communityId, { starts_at: `${day}T03:30:00+03:00`, ends_at: null, rsvp_deadline: null });
    const second = await createTraining(organizerId, communityId, { starts_at: `${day}T03:30:00+02:00`, ends_at: null, rsvp_deadline: null });

    expect(second.starts_at.getTime() - first.starts_at.getTime()).toBe(3_600_000);
    const { rows } = await admin.query<{ id: string; local_start: string; local_deadline: string }>(
      `select id, to_char(starts_at at time zone timezone, 'HH24:MI') as local_start,
              to_char(rsvp_deadline at time zone timezone, 'HH24:MI') as local_deadline
       from public.training_sessions where id = any($1::uuid[])`,
      [[first.id, second.id]],
    );
    const local = new Map(rows.map((row) => [row.id, row]));
    expect(local.get(first.id)).toMatchObject({ local_start: '03:30', local_deadline: '01:30' });
    // Two elapsed hours before the second 03:30 is 02:30 EEST: only one wall-clock hour earlier.
    expect(local.get(second.id)).toMatchObject({ local_start: '03:30', local_deadline: '02:30' });
  });

  it('the decision time does not depend on the time zone of the database session', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId, { timezone: 'Pacific/Kiritimati' });
    // Deadline 30 minutes ahead: in no session time zone may it count as passed.
    await admin.query("update public.training_sessions set rsvp_deadline = now() + interval '30 minutes' where id = $1", [session.id]);

    for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC']) {
      const client = await admin.connect();
      try {
        await client.query(`set time zone '${zone}'`);
        await client.query('set role service_role');
        const { rows } = await client.query<{ n: number }>('select public.finalize_due_sessions() as n');
        expect(rows[0].n, zone).toBe(0);
      } finally {
        await client.query('reset role');
        await client.query('reset time zone');
        client.release();
      }
    }
    expect((await getSession(session.id)).status).toBe('scheduled');
  });

  // DEFECT Q1-5 (low): the zone is validated against pg_timezone_names, which also lists names
  // that are not IANA zone identifiers a client can display with Intl / date-fns-tz.
  it.fails('DEFECT Q1-5: only IANA zone identifiers are accepted as a session time zone', async () => {
    const { communityId, organizerId } = await createPack();
    const { rows } = await admin.query<{ name: string }>(
      "select name from pg_timezone_names where name in ('Factory', 'posixrules', 'localtime', 'posix/Europe/Bucharest', 'right/Europe/Bucharest')",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const { name } of rows) {
      await expect(create(organizerId, communityId, trainingInput({ timezone: name })), name).rejects.toMatchObject(
        raised('validation_failed:timezone'),
      );
    }
  });
});
