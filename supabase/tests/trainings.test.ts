import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addMember,
  admin,
  asAnon,
  asRole,
  asUser,
  cancelTraining,
  closeDb,
  countRows,
  createCommunity,
  createPack,
  createTraining,
  createUser,
  finalize,
  getSession,
  hoursFromNow,
  INSUFFICIENT_PRIVILEGE,
  makeDue,
  RAISED,
  resetData,
  rpcRow,
  type Session,
  setRsvp,
  trainingInput,
  updateTraining,
} from './helpers';

const raised = (message: string) => ({ code: RAISED, message });
const denied = { code: INSUFFICIENT_PRIVILEGE };
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

/** The form a client would send back for an existing session (every key, ISO instants). */
function formOf(session: Session, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: session.title,
    description: session.description,
    activity_type: session.activity_type,
    starts_at: session.starts_at.toISOString(),
    ends_at: session.ends_at?.toISOString() ?? null,
    rsvp_deadline: session.rsvp_deadline.toISOString(),
    timezone: session.timezone,
    location_name: session.location_name,
    address: session.address,
    latitude: session.latitude,
    longitude: session.longitude,
    map_url: session.map_url,
    meeting_instructions: session.meeting_instructions,
    min_participants: session.min_participants,
    max_participants: session.max_participants,
    ...overrides,
  };
}

/** Invalid values per field; each must produce validation_failed:<field>. */
const INVALID_FIELDS: [string, string, Record<string, unknown>][] = [
  ['title', 'missing', { title: null }],
  ['title', 'blank', { title: '   ' }],
  ['title', '81 characters', { title: 'x'.repeat(81) }],
  ['title', 'not a string', { title: 42 }],
  ['description', '2001 characters', { description: 'x'.repeat(2001) }],
  ['description', 'not a string', { description: { text: 'hi' } }],
  ['activity_type', 'unknown', { activity_type: 'underwater_chess' }],
  ['activity_type', 'not a string', { activity_type: 7 }],
  ['starts_at', 'missing', { starts_at: null }],
  ['starts_at', 'not a timestamp', { starts_at: 'next tuesday' }],
  ['starts_at', 'impossible date', { starts_at: '2099-02-30T10:00:00Z' }],
  ['starts_at', 'no UTC offset', { starts_at: '2099-05-01T10:00:00' }],
  ['starts_at', 'a number', { starts_at: 4102444800 }],
  ['starts_at', 'infinity', { starts_at: 'infinity' }],
  ['ends_at', 'not a timestamp', { ends_at: 'later' }],
  ['ends_at', 'equal to start', { starts_at: hoursFromNow(72), ends_at: hoursFromNow(72) }],
  ['ends_at', 'before start', { ends_at: hoursFromNow(71) }],
  ['rsvp_deadline', 'not a timestamp', { rsvp_deadline: 'soon' }],
  ['rsvp_deadline', 'after start', { rsvp_deadline: hoursFromNow(73) }],
  ['timezone', 'unknown', { timezone: 'Mars/Phobos' }],
  ['timezone', 'not a string', { timezone: 2 }],
  ['location_name', 'missing', { location_name: null }],
  ['location_name', 'blank', { location_name: ' ' }],
  ['location_name', '121 characters', { location_name: 'x'.repeat(121) }],
  ['address', '201 characters', { address: 'x'.repeat(201) }],
  ['latitude', 'out of range', { latitude: 90.01 }],
  ['latitude', 'a string', { latitude: '44.4' }],
  ['latitude', 'missing while longitude is set', { latitude: null }],
  ['longitude', 'out of range', { longitude: -180.5 }],
  ['longitude', 'absurdly large', { longitude: 1e400 }],
  ['longitude', 'missing while latitude is set', { longitude: null }],
  ['map_url', 'not http(s)', { map_url: 'javascript:alert(1)' }],
  ['map_url', 'no host', { map_url: 'https://' }],
  ['map_url', 'contains a space', { map_url: 'https://maps.example.com/a b' }],
  ['map_url', '2049 characters', { map_url: `https://e.com/${'x'.repeat(2049)}` }],
  ['meeting_instructions', '1001 characters', { meeting_instructions: 'x'.repeat(1001) }],
  ['min_participants', 'missing', { min_participants: null }],
  ['min_participants', 'zero', { min_participants: 0 }],
  ['min_participants', 'fractional', { min_participants: 2.5 }],
  ['min_participants', 'a string', { min_participants: '2' }],
  ['min_participants', 'beyond int range', { min_participants: 3_000_000_000 }],
  ['max_participants', 'below min', { min_participants: 3, max_participants: 2 }],
  ['max_participants', 'a boolean', { max_participants: true }],
];

beforeEach(resetData);
afterAll(closeDb);

describe('create_training', () => {
  it('creates a scheduled session with every field stored', async () => {
    const { communityId, organizerId } = await createPack();
    const input = trainingInput({ max_participants: 12 });

    const session = await createTraining(organizerId, communityId, { max_participants: 12 });

    expect(session).toMatchObject({
      community_id: communityId,
      organizer_id: organizerId,
      title: 'Morning run',
      description: 'Easy pace, everyone welcome.',
      activity_type: 'running',
      timezone: 'Europe/Bucharest',
      location_name: 'Herastrau Park',
      address: 'Main gate',
      latitude: 44.4702,
      longitude: 26.0826,
      map_url: 'https://maps.example.com/?q=44.4702,26.0826',
      meeting_instructions: 'Meet at the fountain.',
      min_participants: 2,
      max_participants: 12,
      going_count: 0,
      status: 'scheduled',
      cancel_reason: null,
      decided_at: null,
      cancelled_at: null,
      cancelled_by: null,
    });
    expect(session.starts_at.toISOString()).toBe(input.starts_at);
    expect(session.ends_at?.toISOString()).toBe(input.ends_at);
    expect(session.rsvp_deadline.toISOString()).toBe(input.rsvp_deadline);
    expect(await getSession(session.id)).toEqual(session);
  });

  it('applies defaults: deadline = start - 2h, community timezone, activity "other", nulls', async () => {
    const { communityId } = await createCommunity('Tokyo Pack', 'Asia/Tokyo');
    const organizerId = await addMember(communityId, { role: 'organizer' });
    const startsAt = hoursFromNow(100);

    // Explicit nulls and missing keys behave the same.
    const session = await asUser(organizerId, (db) =>
      rpcRow<Session>(db, 'create_training', [
        communityId,
        JSON.stringify({
          title: 'Minimal',
          starts_at: startsAt,
          location_name: 'Somewhere',
          min_participants: 1,
          activity_type: null,
          timezone: null,
          rsvp_deadline: null,
          description: null,
        }),
      ]),
    );

    expect(session.rsvp_deadline.getTime()).toBe(new Date(startsAt).getTime() - 2 * 3_600_000);
    expect(session).toMatchObject({
      timezone: 'Asia/Tokyo',
      activity_type: 'other',
      description: null,
      ends_at: null,
      address: null,
      latitude: null,
      longitude: null,
      map_url: null,
      meeting_instructions: null,
      max_participants: null,
    });
  });

  it('ignores unknown keys and server-owned fields', async () => {
    const { communityId, organizerId } = await createPack();
    const intruder = await createUser();

    const session = await createTraining(organizerId, communityId, {
      going_count: 99,
      status: 'confirmed',
      organizer_id: intruder,
      community_id: UNKNOWN_ID,
      decided_at: hoursFromNow(1),
      cancel_reason: 'organizer',
      cancelled_at: hoursFromNow(1),
      cancelled_by: intruder,
      id: UNKNOWN_ID,
      nonsense: [1, 2, 3],
    });

    expect(session).toMatchObject({
      community_id: communityId,
      organizer_id: organizerId,
      going_count: 0,
      status: 'scheduled',
      decided_at: null,
      cancel_reason: null,
      cancelled_at: null,
      cancelled_by: null,
    });
    expect(session.id).not.toBe(UNKNOWN_ID);
  });

  it('trims text, collapses whitespace in single-line fields and measures length after trim', async () => {
    const { communityId, organizerId } = await createPack();

    const session = await createTraining(organizerId, communityId, {
      title: `  ${'x'.repeat(80)}  `,
      location_name: '  Central \n  Park ',
      description: '  line one\n\nline two  \n',
      address: '   ',
      meeting_instructions: '',
    });

    expect(session.title).toBe('x'.repeat(80));
    expect(session.location_name).toBe('Central Park');
    expect(session.description).toBe('line one\n\nline two');
    expect(session.address).toBeNull();
    expect(session.meeting_instructions).toBeNull();
  });

  it('accepts boundary values', async () => {
    const { communityId, organizerId } = await createPack();
    const startsAt = hoursFromNow(72);

    const session = await createTraining(organizerId, communityId, {
      latitude: -90,
      longitude: 180,
      min_participants: 1,
      max_participants: 1,
      rsvp_deadline: new Date(new Date(startsAt).getTime() - 1).toISOString(),
      starts_at: startsAt,
      map_url: 'HTTP://maps.example.com',
    });

    expect(session).toMatchObject({ latitude: -90, longitude: 180, min_participants: 1, max_participants: 1 });
    expect(session.starts_at.getTime() - session.rsvp_deadline.getTime()).toBe(1);
  });

  it('requires the deadline to be strictly before the start (RPCs and table check)', async () => {
    const { communityId, organizerId } = await createPack();
    const startsAt = hoursFromNow(72);

    await expect(
      createTraining(organizerId, communityId, { starts_at: startsAt, rsvp_deadline: startsAt }),
    ).rejects.toMatchObject(raised('validation_failed:rsvp_deadline'));

    const session = await createTraining(organizerId, communityId);
    await expect(
      updateTraining(organizerId, session.id, formOf(session, { rsvp_deadline: session.starts_at.toISOString() })),
    ).rejects.toMatchObject(raised('validation_failed:rsvp_deadline'));
    await expect(
      admin.query('update public.training_sessions set rsvp_deadline = starts_at where id = $1', [session.id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'training_sessions_rsvp_deadline_check' });
    expect(await getSession(session.id)).toEqual(session);
  });

  it.each(['UTC', 'Etc/UTC', 'Etc/GMT+3', 'America/Argentina/Buenos_Aires', 'Asia/Kolkata'])(
    'accepts the IANA time zone %s',
    async (timezone) => {
      const { communityId, organizerId } = await createPack();

      const session = await createTraining(organizerId, communityId, { timezone });

      expect(session.timezone).toBe(timezone);
    },
  );

  it.each(['EST', 'EET', 'GMT', 'utc', 'Factory', 'posix/Europe/Bucharest', 'right/Europe/Bucharest', 'UTC+3', 'europe/bucharest'])(
    'rejects %s, which is not a strict IANA Area/Location zone',
    async (timezone) => {
      const { communityId, organizerId } = await createPack();
      const session = await createTraining(organizerId, communityId);

      await expect(createTraining(organizerId, communityId, { timezone })).rejects.toMatchObject(
        raised('validation_failed:timezone'),
      );
      await expect(
        updateTraining(organizerId, session.id, formOf(session, { timezone })),
      ).rejects.toMatchObject(raised('validation_failed:timezone'));
    },
  );

  it.each(INVALID_FIELDS)('rejects %s that is %s', async (field, _label, overrides) => {
    const { communityId, organizerId } = await createPack();

    await expect(createTraining(organizerId, communityId, overrides)).rejects.toMatchObject(
      raised(`validation_failed:${field}`),
    );
    expect(await countRows('training_sessions')).toBe(0);
  });

  it('rejects a start or a deadline that is not in the future', async () => {
    const { communityId, organizerId } = await createPack();

    await expect(
      createTraining(organizerId, communityId, { starts_at: hoursFromNow(-1), ends_at: null, rsvp_deadline: null }),
    ).rejects.toMatchObject(raised('validation_failed:starts_at'));
    await expect(
      createTraining(organizerId, communityId, { rsvp_deadline: hoursFromNow(-1) }),
    ).rejects.toMatchObject(raised('validation_failed:rsvp_deadline'));
    // The default deadline (start - 2h) is already past for a session starting in one hour.
    await expect(
      createTraining(organizerId, communityId, { starts_at: hoursFromNow(1), ends_at: null, rsvp_deadline: null }),
    ).rejects.toMatchObject(raised('validation_failed:rsvp_deadline'));
  });

  it.each([null, '"a string"', '[1,2]', '42'])('rejects a p_input of %s', async (input) => {
    const { communityId, organizerId } = await createPack();

    await expect(
      asUser(organizerId, (db) => rpcRow(db, 'create_training', [communityId, input])),
    ).rejects.toMatchObject(raised('validation_failed:input'));
  });

  it('is forbidden for members, removed organizers, outsiders, other organizers and unknown communities', async () => {
    const { communityId, memberIds } = await createPack(1);
    const other = await createPack();
    const removedOrganizer = await addMember(communityId, { role: 'organizer', status: 'removed' });
    const outsider = await createUser();

    for (const userId of [memberIds[0], removedOrganizer, outsider, other.organizerId]) {
      await expect(createTraining(userId, communityId)).rejects.toMatchObject(raised('forbidden'));
    }
    await expect(createTraining(other.organizerId, UNKNOWN_ID)).rejects.toMatchObject(raised('forbidden'));
    expect(await countRows('training_sessions')).toBe(0);
  });

  it('requires a user and is denied to anon', async () => {
    const { communityId } = await createPack();
    const input = JSON.stringify(trainingInput());

    await expect(
      asRole('authenticated', null, (db) => rpcRow(db, 'create_training', [communityId, input])),
    ).rejects.toMatchObject(raised('not_authenticated'));
    await expect(
      asAnon((db) => rpcRow(db, 'create_training', [communityId, input])),
    ).rejects.toMatchObject(denied);
  });
});

describe('time zones', () => {
  /** The last Sunday of March (start of DST in Europe/Bucharest) two years from now. */
  function springForwardDay(): { day: string; previousDay: string } {
    const date = new Date(Date.UTC(new Date().getUTCFullYear() + 2, 2, 31));
    date.setUTCDate(31 - date.getUTCDay());
    const previous = new Date(date.getTime() - 86_400_000);
    return { day: date.toISOString().slice(0, 10), previousDay: previous.toISOString().slice(0, 10) };
  }

  it('stores instants in UTC and round-trips them whatever offset the client used', async () => {
    const { communityId, organizerId } = await createPack();
    const year = new Date().getUTCFullYear() + 2;

    const session = await createTraining(organizerId, communityId, {
      starts_at: `${year}-07-10T18:30:00+03:00`,
      ends_at: `${year}-07-10 20:00:00.250+03`,
      rsvp_deadline: `${year}-07-10T09:00:00-05:00`,
      timezone: 'America/New_York',
    });

    expect(session.starts_at.toISOString()).toBe(`${year}-07-10T15:30:00.000Z`);
    expect(session.ends_at?.toISOString()).toBe(`${year}-07-10T17:00:00.250Z`);
    expect(session.rsvp_deadline.toISOString()).toBe(`${year}-07-10T14:00:00.000Z`);
    // The session keeps its own IANA zone, independent of the community's.
    expect(session.timezone).toBe('America/New_York');
    const { rows } = await admin.query(
      `select to_char(starts_at at time zone timezone, 'YYYY-MM-DD HH24:MI') as local_start
       from public.training_sessions where id = $1`,
      [session.id],
    );
    expect(rows[0].local_start).toBe(`${year}-07-10 11:30`);
  });

  it('defaults the deadline to exactly start - 2h across the Europe/Bucharest DST change', async () => {
    const { communityId, organizerId } = await createPack();
    const { day, previousDay } = springForwardDay();

    // 04:30 local on the spring-forward day: clocks jumped from 03:00 to 04:00 that night.
    const session = await createTraining(organizerId, communityId, {
      starts_at: `${day}T04:30:00+03:00`,
      ends_at: null,
      rsvp_deadline: null,
      timezone: 'Europe/Bucharest',
    });

    expect(session.starts_at.toISOString()).toBe(`${day}T01:30:00.000Z`);
    expect(session.rsvp_deadline.toISOString()).toBe(`${previousDay}T23:30:00.000Z`);
    expect(session.starts_at.getTime() - session.rsvp_deadline.getTime()).toBe(2 * 3_600_000);
    // Two elapsed hours are three wall-clock hours here: 01:30 EET -> 04:30 EEST.
    const { rows } = await admin.query(
      `select to_char(starts_at at time zone timezone, 'YYYY-MM-DD HH24:MI') as local_start,
              to_char(rsvp_deadline at time zone timezone, 'YYYY-MM-DD HH24:MI') as local_deadline
       from public.training_sessions where id = $1`,
      [session.id],
    );
    expect(rows[0]).toEqual({ local_start: `${day} 04:30`, local_deadline: `${day} 01:30` });
  });
});

describe('update_training on an open scheduled session', () => {
  it('replaces every editable field and clears optional fields sent as null', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId);
    const startsAt = hoursFromNow(200);

    const updated = await updateTraining(organizerId, session.id, {
      title: 'Evening hills',
      description: null,
      activity_type: null,
      starts_at: startsAt,
      ends_at: null,
      rsvp_deadline: null,
      timezone: null,
      location_name: 'The hill',
      address: null,
      latitude: null,
      longitude: null,
      map_url: null,
      meeting_instructions: null,
      min_participants: 4,
      max_participants: 8,
    });

    expect(updated).toMatchObject({
      id: session.id,
      title: 'Evening hills',
      description: null,
      activity_type: 'other',
      ends_at: null,
      timezone: 'Europe/Bucharest',
      location_name: 'The hill',
      address: null,
      latitude: null,
      longitude: null,
      map_url: null,
      meeting_instructions: null,
      min_participants: 4,
      max_participants: 8,
      status: 'scheduled',
      organizer_id: organizerId,
    });
    expect(updated.starts_at.toISOString()).toBe(startsAt);
    expect(updated.rsvp_deadline.getTime()).toBe(new Date(startsAt).getTime() - 2 * 3_600_000);
    expect(updated.updated_at.getTime()).toBeGreaterThanOrEqual(session.updated_at.getTime());
    expect(updated.created_at).toEqual(session.created_at);
  });

  it('treats missing optional keys like null', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId);

    const updated = await updateTraining(organizerId, session.id, {
      title: 'Bare',
      starts_at: session.starts_at.toISOString(),
      location_name: 'Bare place',
      min_participants: 1,
    });

    expect(updated).toMatchObject({ description: null, address: null, map_url: null, activity_type: 'other', max_participants: null });
  });

  it('ignores server-owned fields', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId);

    const updated = await updateTraining(
      organizerId,
      session.id,
      formOf(session, { going_count: 50, status: 'confirmed', decided_at: hoursFromNow(1), cancel_reason: 'organizer' }),
    );

    expect(updated).toMatchObject({ going_count: 0, status: 'scheduled', decided_at: null, cancel_reason: null });
  });

  it.each(INVALID_FIELDS)('rejects %s that is %s', async (field, _label, overrides) => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId);

    await expect(
      updateTraining(organizerId, session.id, trainingInput(overrides)),
    ).rejects.toMatchObject(raised(`validation_failed:${field}`));
    expect(await getSession(session.id)).toEqual(session);
  });

  it('rejects a new start or deadline in the past', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId);

    await expect(
      updateTraining(organizerId, session.id, formOf(session, { starts_at: hoursFromNow(-1), ends_at: null, rsvp_deadline: null })),
    ).rejects.toMatchObject(raised('validation_failed:starts_at'));
    await expect(
      updateTraining(organizerId, session.id, formOf(session, { rsvp_deadline: hoursFromNow(-1) })),
    ).rejects.toMatchObject(raised('validation_failed:rsvp_deadline'));
  });

  it('does not let max_participants drop below going_count, and keeps the status when min changes', async () => {
    const { communityId, organizerId, memberIds } = await createPack(3);
    const session = await createTraining(organizerId, communityId, { min_participants: 2, max_participants: 5 });
    for (const memberId of memberIds) await setRsvp(memberId, session.id, 'going');

    await expect(
      updateTraining(organizerId, session.id, formOf(session, { max_participants: 2 })),
    ).rejects.toMatchObject(raised('validation_failed:max_participants'));

    const exact = await updateTraining(organizerId, session.id, formOf(session, { max_participants: 3 }));
    expect(exact).toMatchObject({ max_participants: 3, going_count: 3, status: 'scheduled' });

    // Raising the minimum above the current count does not cancel anything: the label is derived.
    const raisedMin = await updateTraining(organizerId, session.id, formOf(session, { min_participants: 5, max_participants: null }));
    expect(raisedMin).toMatchObject({ min_participants: 5, max_participants: null, going_count: 3, status: 'scheduled' });
    const loweredMin = await updateTraining(organizerId, session.id, formOf(session, { min_participants: 1 }));
    expect(loweredMin).toMatchObject({ min_participants: 1, going_count: 3, status: 'scheduled', decided_at: null });
  });
});

describe('update_training on a frozen session', () => {
  async function confirmedSession() {
    const pack = await createPack(2);
    const created = await createTraining(pack.organizerId, pack.communityId, { min_participants: 2, max_participants: 10 });
    for (const memberId of pack.memberIds) await setRsvp(memberId, created.id, 'going');
    await makeDue(created.id);
    expect(await finalize()).toBe(1);
    const session = await getSession(created.id);
    expect(session.status).toBe('confirmed');
    return { ...pack, session };
  }

  it('confirmed: descriptive fields and the start / end can be edited', async () => {
    const { organizerId, session } = await confirmedSession();
    const startsAt = hoursFromNow(90);

    const updated = await updateTraining(
      organizerId,
      session.id,
      formOf(session, {
        title: 'New title',
        description: 'New description',
        location_name: 'New place',
        activity_type: 'ocr',
        timezone: 'Europe/London',
        starts_at: startsAt,
        ends_at: hoursFromNow(92),
        map_url: null,
      }),
    );

    expect(updated).toMatchObject({
      title: 'New title',
      description: 'New description',
      location_name: 'New place',
      activity_type: 'ocr',
      timezone: 'Europe/London',
      map_url: null,
      status: 'confirmed',
      going_count: 2,
    });
    expect(updated.starts_at.toISOString()).toBe(startsAt);
    expect(updated.rsvp_deadline).toEqual(session.rsvp_deadline);
    expect(updated.decided_at).toEqual(session.decided_at);
  });

  it('confirmed: deadline, min and max are frozen', async () => {
    const { organizerId, session } = await confirmedSession();

    await expect(
      updateTraining(organizerId, session.id, formOf(session, { rsvp_deadline: hoursFromNow(10) })),
    ).rejects.toMatchObject(raised('validation_failed:rsvp_deadline'));
    await expect(
      updateTraining(organizerId, session.id, formOf(session, { min_participants: 1 })),
    ).rejects.toMatchObject(raised('validation_failed:min_participants'));
    await expect(
      updateTraining(organizerId, session.id, formOf(session, { max_participants: 20 })),
    ).rejects.toMatchObject(raised('validation_failed:max_participants'));
    await expect(
      updateTraining(organizerId, session.id, formOf(session, { max_participants: null })),
    ).rejects.toMatchObject(raised('validation_failed:max_participants'));
    expect(await getSession(session.id)).toEqual(session);
  });

  it('confirmed: frozen fields are compared by instant, not by text', async () => {
    const { organizerId, session } = await confirmedSession();
    // Whole-second deadline so that every notation below denotes the stored instant exactly.
    await admin.query(
      "update public.training_sessions set rsvp_deadline = date_trunc('second', rsvp_deadline) where id = $1",
      [session.id],
    );
    const stored = await getSession(session.id);
    const iso = stored.rsvp_deadline.toISOString();
    const notations = [
      iso,
      iso.replace('.000Z', 'Z'),
      iso.replace('T', ' ').replace('.000Z', '+00'),
      iso.replace('.000Z', '+00:00'),
      new Date(stored.rsvp_deadline.getTime() + 3 * 3_600_000).toISOString().replace('.000Z', '+03:00'),
    ];

    for (const notation of notations) {
      const updated = await updateTraining(organizerId, session.id, formOf(stored, { rsvp_deadline: notation }));
      expect(updated.rsvp_deadline, notation).toEqual(stored.rsvp_deadline);
    }
  });

  it('confirmed: a moved start must be in the future; an unchanged past start is fine', async () => {
    const { organizerId, session } = await confirmedSession();

    await expect(
      updateTraining(organizerId, session.id, formOf(session, { starts_at: hoursFromNow(-1), ends_at: null })),
    ).rejects.toMatchObject(raised('validation_failed:starts_at'));

    // Time travel: the session has started. Editing the description must still work.
    await admin.query(
      `update public.training_sessions
       set rsvp_deadline = date_trunc('second', now()) - interval '5 hours',
           starts_at = date_trunc('second', now()) - interval '3 hours',
           ends_at = date_trunc('second', now()) - interval '1 hour'
       where id = $1`,
      [session.id],
    );
    const started = await getSession(session.id);

    const updated = await updateTraining(organizerId, session.id, formOf(started, { description: 'It was great.' }));

    expect(updated.description).toBe('It was great.');
    expect(updated.starts_at).toEqual(started.starts_at);
    expect(updated.ends_at).toEqual(started.ends_at);
  });

  it('scheduled but past its deadline: the pending decision cannot be escaped', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const session = await createTraining(organizerId, communityId, { min_participants: 2, max_participants: 10 });
    await setRsvp(memberIds[0], session.id, 'going');
    await makeDue(session.id);
    const due = await getSession(session.id);

    // Moving the deadline into the future, or lowering the minimum to the current count,
    // would dodge the cancellation that is about to happen.
    await expect(
      updateTraining(organizerId, session.id, formOf(due, { rsvp_deadline: hoursFromNow(24) })),
    ).rejects.toMatchObject(raised('validation_failed:rsvp_deadline'));
    await expect(
      updateTraining(organizerId, session.id, formOf(due, { min_participants: 1 })),
    ).rejects.toMatchObject(raised('validation_failed:min_participants'));
    await expect(
      updateTraining(organizerId, session.id, formOf(due, { max_participants: 11 })),
    ).rejects.toMatchObject(raised('validation_failed:max_participants'));

    // Descriptive edits still work, and a null deadline means "unchanged" here.
    const edited = await updateTraining(organizerId, session.id, formOf(due, { title: 'Still pending', rsvp_deadline: null }));
    expect(edited.title).toBe('Still pending');
    expect(edited.rsvp_deadline).toEqual(due.rsvp_deadline);
    expect(edited.status).toBe('scheduled');

    expect(await finalize()).toBe(1);
    expect(await getSession(session.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'insufficient_participation',
      title: 'Still pending',
    });
  });

  it('cancelled and completed sessions are not editable', async () => {
    const { communityId, organizerId } = await createPack();
    const cancelled = await createTraining(organizerId, communityId);
    await cancelTraining(organizerId, cancelled.id);
    const completed = await createTraining(organizerId, communityId);
    await admin.query("update public.training_sessions set status = 'completed', attendance_finalized_at = now() where id = $1", [completed.id]);

    for (const session of [cancelled, completed]) {
      await expect(
        updateTraining(organizerId, session.id, formOf(session, { title: 'Nope' })),
      ).rejects.toMatchObject(raised('session_not_editable'));
    }
    expect(await countRows('training_sessions', "title = 'Nope'")).toBe(0);
  });
});

describe('update_training / cancel_training access', () => {
  it('only an organizer of that community may edit or cancel', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const other = await createPack();
    const outsider = await createUser();
    const session = await createTraining(organizerId, communityId);

    for (const userId of [memberIds[0], other.organizerId, outsider]) {
      await expect(
        updateTraining(userId, session.id, formOf(session, { title: 'Hijacked' })),
      ).rejects.toMatchObject(raised('forbidden'));
      await expect(cancelTraining(userId, session.id)).rejects.toMatchObject(raised('forbidden'));
    }
    expect(await getSession(session.id)).toEqual(session);
  });

  it('another organizer of the same community may edit and cancel', async () => {
    const { communityId, organizerId } = await createPack();
    const coOrganizer = await addMember(communityId, { role: 'organizer' });
    const session = await createTraining(organizerId, communityId);

    const updated = await updateTraining(coOrganizer, session.id, formOf(session, { title: 'Co-edited' }));
    const cancelled = await cancelTraining(coOrganizer, session.id);

    expect(updated).toMatchObject({ title: 'Co-edited', organizer_id: organizerId });
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelled_by: coOrganizer });
  });

  it('raises not_found for an unknown session, not_authenticated without a user, and denies anon', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId);
    const input = JSON.stringify(formOf(session));

    await expect(updateTraining(organizerId, UNKNOWN_ID, formOf(session))).rejects.toMatchObject(raised('not_found'));
    await expect(cancelTraining(organizerId, UNKNOWN_ID)).rejects.toMatchObject(raised('not_found'));
    await expect(
      asRole('authenticated', null, (db) => rpcRow(db, 'update_training', [session.id, input])),
    ).rejects.toMatchObject(raised('not_authenticated'));
    await expect(
      asRole('authenticated', null, (db) => rpcRow(db, 'cancel_training', [session.id])),
    ).rejects.toMatchObject(raised('not_authenticated'));
    await expect(asAnon((db) => rpcRow(db, 'update_training', [session.id, input]))).rejects.toMatchObject(denied);
    await expect(asAnon((db) => rpcRow(db, 'cancel_training', [session.id]))).rejects.toMatchObject(denied);
  });
});

describe('cancel_training', () => {
  it('cancels a scheduled session and is idempotent', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const session = await createTraining(organizerId, communityId);
    await setRsvp(memberIds[0], session.id, 'going');

    const first = await cancelTraining(organizerId, session.id);
    const second = await cancelTraining(organizerId, session.id);

    expect(first).toMatchObject({ status: 'cancelled', cancel_reason: 'organizer', cancelled_by: organizerId, going_count: 1 });
    expect(first.cancelled_at).toBeInstanceOf(Date);
    expect(second).toEqual(first);
  });

  it('cancels a confirmed session', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const session = await createTraining(organizerId, communityId, { min_participants: 1 });
    await setRsvp(memberIds[0], session.id, 'going');
    await makeDue(session.id);
    await finalize();

    const cancelled = await cancelTraining(organizerId, session.id);

    expect(cancelled).toMatchObject({ status: 'cancelled', cancel_reason: 'organizer', cancelled_by: organizerId });
    expect(cancelled.decided_at).toBeInstanceOf(Date);
  });

  it('returns a session cancelled for insufficient participation unchanged', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId);
    await makeDue(session.id);
    await finalize();
    const before = await getSession(session.id);

    const result = await cancelTraining(organizerId, session.id);

    expect(result).toEqual(before);
    expect(result).toMatchObject({ cancel_reason: 'insufficient_participation', cancelled_by: null });
  });

  it('refuses a completed session', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId);
    await admin.query("update public.training_sessions set status = 'completed', attendance_finalized_at = now() where id = $1", [session.id]);

    await expect(cancelTraining(organizerId, session.id)).rejects.toMatchObject(raised('session_not_cancellable'));
    expect((await getSession(session.id)).status).toBe('completed');
  });
});
