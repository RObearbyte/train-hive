import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addMember,
  admin,
  asAnon,
  asUser,
  cancelTraining,
  closeDb,
  createPack,
  createTraining,
  finalize,
  getSession,
  hoursFromNow,
  INSUFFICIENT_PRIVILEGE,
  makeDue,
  RAISED,
  resetData,
  setRsvp,
  trainingInput,
} from './helpers';
import {
  createEvent,
  createRaw,
  eventFormOf,
  eventInput,
  type EventKind,
  type EventSession,
  KINDS,
  legacyFormOf,
  updateEvent,
} from './events-helpers';

const raised = (message: string) => ({ code: RAISED, message });
const denied = { code: INSUFFICIENT_PRIVILEGE };
const CHECK_VIOLATION = '23514';

beforeEach(resetData);
afterAll(closeDb);

describe('event_subtypes lookup', () => {
  it('is seeded per kind with the legacy activity type of each subtype', async () => {
    const { rows } = await admin.query(
      'select s.kind::text as kind, s.key, s.label, s.activity_type from public.event_subtypes s order by s.kind, s.sort_order, s.key',
    );
    expect(rows).toEqual([
      { kind: 'training', key: 'running', label: 'Running', activity_type: 'running' },
      { kind: 'training', key: 'trail_running', label: 'Trail running', activity_type: 'trail_running' },
      { kind: 'training', key: 'strength', label: 'Strength', activity_type: 'strength' },
      { kind: 'training', key: 'functional_fitness', label: 'Functional fitness', activity_type: 'functional_fitness' },
      { kind: 'training', key: 'ocr', label: 'OCR', activity_type: 'ocr' },
      { kind: 'training', key: 'other', label: 'Other', activity_type: 'other' },
      { kind: 'race', key: 'trail_running', label: 'Trail running', activity_type: 'trail_running' },
      { kind: 'race', key: 'asphalt_running', label: 'Asphalt running', activity_type: 'running' },
      { kind: 'race', key: 'ocr', label: 'OCR', activity_type: 'ocr' },
      { kind: 'sports_event', key: 'crossfit_event', label: 'CrossFit event', activity_type: 'functional_fitness' },
      { kind: 'sports_event', key: 'public_training', label: 'Public training', activity_type: 'other' },
      { kind: 'sports_event', key: 'other', label: 'Other', activity_type: 'other' },
      { kind: 'social', key: 'social_gathering', label: 'Social gathering', activity_type: 'other' },
      { kind: 'social', key: 'other', label: 'Other', activity_type: 'other' },
    ]);
  });

  it('is readable by any signed-in user, not by anon, and never writable', async () => {
    const { memberIds } = await createPack(1);
    const outsider = await addMember((await createPack()).communityId);
    for (const userId of [memberIds[0], outsider]) {
      const { rows } = await asUser(userId, (db) => db.query('select key from public.event_subtypes'));
      expect(rows).toHaveLength(14);
    }
    await expect(asAnon((db) => db.query('select key from public.event_subtypes'))).rejects.toMatchObject(denied);
    await expect(
      asUser(memberIds[0], (db) =>
        db.query("insert into public.event_subtypes (kind, key, label, activity_type) values ('race', 'x', 'X', 'other')"),
      ),
    ).rejects.toMatchObject(denied);
    await expect(
      asUser(memberIds[0], (db) => db.query("update public.event_subtypes set label = 'Hacked' where key = 'ocr'")),
    ).rejects.toMatchObject(denied);
    await expect(
      asUser(memberIds[0], (db) => db.query("delete from public.event_subtypes where key = 'ocr'")),
    ).rejects.toMatchObject(denied);
  });
});

describe('create_training: kinds and status at creation', () => {
  it.each([
    ['training', 'running', 'running', 'scheduled', 2],
    ['race', 'trail_running', 'trail_running', 'confirmed', null],
    ['race', 'asphalt_running', 'running', 'confirmed', null],
    ['race', 'ocr', 'ocr', 'confirmed', null],
    ['sports_event', 'crossfit_event', 'functional_fitness', 'confirmed', null],
    ['sports_event', 'public_training', 'other', 'confirmed', null],
    ['sports_event', 'other', 'other', 'confirmed', null],
    ['social', 'social_gathering', 'other', 'confirmed', null],
    ['social', 'other', 'other', 'confirmed', null],
  ] as const)('%s / %s: activity_type %s, status %s', async (kind, subtype, activity, status, min) => {
    const { communityId, organizerId } = await createPack();
    const session = await createEvent(organizerId, communityId, kind, { event_subtype: subtype });
    expect(session).toMatchObject({
      event_kind: kind,
      event_subtype: subtype,
      activity_type: activity,
      status,
      min_participants: min,
      decided_at: null,
      cancel_reason: null,
      going_count: 0,
    });
    expect(await getSession(session.id)).toEqual(session);
  });

  it('a training with every subtype: activity_type equals the subtype', async () => {
    const { communityId, organizerId } = await createPack();
    for (const subtype of ['running', 'trail_running', 'strength', 'functional_fitness', 'ocr', 'other']) {
      const session = await createEvent(organizerId, communityId, 'training', {
        event_subtype: subtype,
        activity_type: undefined,
      });
      expect([session.event_subtype, session.activity_type]).toEqual([subtype, subtype]);
    }
  });

  it('stores the race fields', async () => {
    const { communityId, organizerId } = await createPack();
    const race = await createEvent(organizerId, communityId, 'race', {
      event_subtype: 'ocr',
      distance_km: 21.1,
      elevation_gain_m: 850,
      obstacle_count: 30,
      event_notes: 'Bring gloves.\nKit pickup from 7:00.',
      max_participants: 200,
    });
    expect(race).toMatchObject({
      distance_km: '21.10',
      elevation_gain_m: 850,
      obstacle_count: 30,
      event_notes: 'Bring gloves.\nKit pickup from 7:00.',
      max_participants: 200,
      min_participants: null,
    });
  });

  it('accepts the course fields on running-type subtypes of every kind', async () => {
    const { communityId, organizerId } = await createPack();
    const cases: [EventKind, string][] = [
      ['training', 'running'],
      ['training', 'trail_running'],
      ['training', 'ocr'],
      ['race', 'trail_running'],
      ['race', 'asphalt_running'],
      ['race', 'ocr'],
    ];
    for (const [kind, subtype] of cases) {
      const session = await createEvent(organizerId, communityId, kind, {
        event_subtype: subtype,
        activity_type: undefined,
        distance_km: 10,
        elevation_gain_m: 0,
      });
      expect(session.distance_km, `${kind}/${subtype}`).toBe('10.00');
    }
  });

  it('accepts the range boundaries', async () => {
    const { communityId, organizerId } = await createPack();
    const low = await createEvent(organizerId, communityId, 'race', {
      event_subtype: 'ocr',
      distance_km: 0.01,
      elevation_gain_m: 0,
      obstacle_count: 0,
      event_notes: 'x',
      max_participants: 1,
    });
    expect(low).toMatchObject({ distance_km: '0.01', elevation_gain_m: 0, obstacle_count: 0, max_participants: 1 });
    const high = await createEvent(organizerId, communityId, 'race', {
      event_subtype: 'ocr',
      distance_km: 1000,
      elevation_gain_m: 20000,
      obstacle_count: 500,
      event_notes: 'y'.repeat(1000),
    });
    expect(high).toMatchObject({ distance_km: '1000.00', elevation_gain_m: 20000, obstacle_count: 500 });
    expect(high.event_notes).toHaveLength(1000);
  });

  it('event_notes are allowed for every kind', async () => {
    const { communityId, organizerId } = await createPack();
    for (const kind of KINDS) {
      const session = await createEvent(organizerId, communityId, kind, { event_notes: 'Bring water.' });
      expect(session.event_notes).toBe('Bring water.');
    }
  });

  it('a non-training event ignores a sent activity_type (it is derived)', async () => {
    const { communityId, organizerId } = await createPack();
    const race = await createEvent(organizerId, communityId, 'race', {
      event_subtype: 'asphalt_running',
      activity_type: 'strength',
    });
    expect(race.activity_type).toBe('running');
  });
});

describe('create_training: defaults and backward compatibility', () => {
  it('the Milestone 1 payload (no P1 keys) creates a training with subtype = activity_type', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId, { activity_type: 'strength' });
    const stored = (await getSession(session.id)) as unknown as EventSession;
    expect(stored).toMatchObject({
      event_kind: 'training',
      event_subtype: 'strength',
      activity_type: 'strength',
      status: 'scheduled',
      min_participants: 2,
      distance_km: null,
      elevation_gain_m: null,
      obstacle_count: null,
      event_notes: null,
    });
  });

  it('without activity_type and subtype a training is "other"', async () => {
    const { communityId, organizerId } = await createPack();
    const input = trainingInput();
    delete input.activity_type;
    const session = await createRaw(organizerId, communityId, input);
    expect([session.event_kind, session.event_subtype, session.activity_type]).toEqual(['training', 'other', 'other']);
  });

  it('event_kind null means training', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createRaw(organizerId, communityId, { ...trainingInput(), event_kind: null, event_subtype: null });
    expect([session.event_kind, session.event_subtype]).toEqual(['training', 'running']);
  });

  it('a training may send both activity_type and event_subtype when they agree', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createEvent(organizerId, communityId, 'training', {
      event_subtype: 'ocr',
      activity_type: 'ocr',
    });
    expect(session.event_subtype).toBe('ocr');
  });

  it('default subtypes: sports_event -> other, social -> social_gathering; a race needs one', async () => {
    const { communityId, organizerId } = await createPack();
    const sports = await createEvent(organizerId, communityId, 'sports_event', { event_subtype: undefined });
    expect(sports.event_subtype).toBe('other');
    const social = await createEvent(organizerId, communityId, 'social', { event_subtype: null });
    expect(social.event_subtype).toBe('social_gathering');
    await expect(
      createEvent(organizerId, communityId, 'race', { event_subtype: undefined }),
    ).rejects.toMatchObject(raised('validation_failed:event_subtype'));
  });
});

describe('create_training: validation', () => {
  const INVALID: [EventKind, string, Record<string, unknown>, string][] = [
    ['training', 'unknown kind', { event_kind: 'meetup' }, 'event_kind'],
    ['training', 'kind with wrong case', { event_kind: 'Race' }, 'event_kind'],
    ['training', 'kind not a string', { event_kind: 1 }, 'event_kind'],
    ['race', 'race subtype from another kind', { event_subtype: 'strength' }, 'event_subtype'],
    ['training', 'training subtype from another kind', { event_subtype: 'asphalt_running', activity_type: undefined }, 'event_subtype'],
    ['social', 'social subtype from another kind', { event_subtype: 'ocr' }, 'event_subtype'],
    ['sports_event', 'unknown subtype', { event_subtype: 'chess' }, 'event_subtype'],
    ['race', 'subtype not a string', { event_subtype: 3 }, 'event_subtype'],
    ['training', 'activity_type disagreeing with the subtype', { event_subtype: 'strength', activity_type: 'running' }, 'activity_type'],
    ['training', 'legacy unknown activity_type', { event_subtype: undefined, activity_type: 'chess' }, 'activity_type'],
    ['training', 'minimum missing', { min_participants: null }, 'min_participants'],
    ['training', 'minimum zero', { min_participants: 0 }, 'min_participants'],
    ['race', 'minimum on a race', { min_participants: 1 }, 'min_participants'],
    ['sports_event', 'minimum on a sports event', { min_participants: 3 }, 'min_participants'],
    ['social', 'minimum on a social event', { min_participants: 2 }, 'min_participants'],
    ['race', 'maximum zero', { max_participants: 0 }, 'max_participants'],
    ['training', 'maximum below minimum', { min_participants: 3, max_participants: 2 }, 'max_participants'],
    ['race', 'distance zero', { distance_km: 0 }, 'distance_km'],
    ['race', 'distance negative', { distance_km: -5 }, 'distance_km'],
    ['race', 'distance above 1000', { distance_km: 1000.01 }, 'distance_km'],
    ['race', 'distance with 3 decimals', { distance_km: 10.555 }, 'distance_km'],
    ['race', 'distance as a string', { distance_km: '10' }, 'distance_km'],
    ['training', 'distance on strength', { event_subtype: 'strength', activity_type: undefined, distance_km: 5 }, 'distance_km'],
    ['training', 'distance on functional fitness', { event_subtype: 'functional_fitness', activity_type: undefined, distance_km: 5 }, 'distance_km'],
    ['sports_event', 'distance on a crossfit event', { distance_km: 5 }, 'distance_km'],
    ['social', 'distance on a social event', { distance_km: 5 }, 'distance_km'],
    ['race', 'elevation negative', { elevation_gain_m: -1 }, 'elevation_gain_m'],
    ['race', 'elevation above 20000', { elevation_gain_m: 20001 }, 'elevation_gain_m'],
    ['race', 'elevation fractional', { elevation_gain_m: 1.5 }, 'elevation_gain_m'],
    ['social', 'elevation on a social event', { elevation_gain_m: 100 }, 'elevation_gain_m'],
    ['training', 'elevation on "other" training', { event_subtype: 'other', activity_type: undefined, elevation_gain_m: 100 }, 'elevation_gain_m'],
    ['race', 'obstacles on a trail race', { obstacle_count: 10 }, 'obstacle_count'],
    ['race', 'obstacles on an asphalt race', { event_subtype: 'asphalt_running', obstacle_count: 10 }, 'obstacle_count'],
    ['training', 'obstacles on a running training', { obstacle_count: 1 }, 'obstacle_count'],
    ['race', 'obstacles above 500', { event_subtype: 'ocr', obstacle_count: 501 }, 'obstacle_count'],
    ['race', 'obstacles negative', { event_subtype: 'ocr', obstacle_count: -1 }, 'obstacle_count'],
    ['race', 'obstacles fractional', { event_subtype: 'ocr', obstacle_count: 2.5 }, 'obstacle_count'],
    ['race', 'notes 1001 characters', { event_notes: 'x'.repeat(1001) }, 'event_notes'],
    ['race', 'notes not a string', { event_notes: 42 }, 'event_notes'],
    ['race', 'notes invisible only', { event_notes: '​‍⁠' }, 'event_notes'],
    ['social', 'notes bidi controls only', { event_notes: '‮⁦' }, 'event_notes'],
  ];

  it.each(INVALID)('%s: %s -> validation_failed:%s', async (kind, _label, overrides, field) => {
    const { communityId, organizerId } = await createPack();
    await expect(createEvent(organizerId, communityId, kind, overrides)).rejects.toMatchObject(
      raised(`validation_failed:${field}`),
    );
  });

  it('nothing is stored after a validation failure', async () => {
    const { communityId, organizerId } = await createPack();
    await expect(createEvent(organizerId, communityId, 'race', { min_participants: 1 })).rejects.toThrow();
    const { rows } = await admin.query('select count(*)::int as n from public.training_sessions');
    expect(rows[0].n).toBe(0);
  });

  it('notes get the shared text hygiene: controls and bidi controls stripped, line breaks normalized, blank = null', async () => {
    const { communityId, organizerId } = await createPack();
    const cleaned = await createEvent(organizerId, communityId, 'race', {
      event_notes: '  Start\u0007 at 9‮\r\nfinish by noon ‍🏃 \n\n',
    });
    expect(cleaned.event_notes).toBe('Start at 9\nfinish\nby noon ‍🏃');
    const blank = await createEvent(organizerId, communityId, 'race', { event_notes: ' \n\t ' });
    expect(blank.event_notes).toBeNull();
  });

  it('the start and deadline rules are the same for every kind', async () => {
    const { communityId, organizerId } = await createPack();
    for (const kind of KINDS) {
      await expect(
        createEvent(organizerId, communityId, kind, { starts_at: hoursFromNow(-1), rsvp_deadline: hoursFromNow(-2) }),
      ).rejects.toMatchObject(raised('validation_failed:starts_at'));
      await expect(
        createEvent(organizerId, communityId, kind, { rsvp_deadline: hoursFromNow(-1) }),
      ).rejects.toMatchObject(raised('validation_failed:rsvp_deadline'));
      const defaulted = await createEvent(organizerId, communityId, kind, { rsvp_deadline: null });
      expect(defaulted.rsvp_deadline.getTime()).toBe(defaulted.starts_at.getTime() - 2 * 3_600_000);
    }
  });
});

describe('table rules (legacy rows and direct writes)', () => {
  it('a legacy-shaped insert (no kind, no subtype) becomes a training with subtype = activity_type', async () => {
    const { communityId } = await createPack();
    const { rows } = await admin.query(
      `insert into public.training_sessions (community_id, title, activity_type, starts_at, rsvp_deadline, timezone, location_name, min_participants)
       values ($1, 'Old', 'strength', now() + interval '3 days', now() + interval '2 days', 'UTC', 'Gym', 2)
       returning event_kind::text, event_subtype, activity_type, status::text`,
      [communityId],
    );
    expect(rows[0]).toEqual({ event_kind: 'training', event_subtype: 'strength', activity_type: 'strength', status: 'scheduled' });
  });

  it('a legacy update of activity_type alone moves the training subtype with it', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId);
    await admin.query("update public.training_sessions set activity_type = 'ocr' where id = $1", [session.id]);
    const stored = (await getSession(session.id)) as unknown as EventSession;
    expect([stored.event_subtype, stored.activity_type]).toEqual(['ocr', 'ocr']);
  });

  it('activity_type always follows the subtype, even on a direct write', async () => {
    const { communityId, organizerId } = await createPack();
    const race = await createEvent(organizerId, communityId, 'race');
    await admin.query("update public.training_sessions set activity_type = 'strength' where id = $1", [race.id]);
    expect((await getSession(race.id)).activity_type).toBe('trail_running');
    await admin.query("update public.training_sessions set event_subtype = 'asphalt_running' where id = $1", [race.id]);
    expect((await getSession(race.id)).activity_type).toBe('running');
  });

  it('the kind never changes, even on a direct write', async () => {
    const { communityId, organizerId } = await createPack();
    const race = await createEvent(organizerId, communityId, 'race');
    await expect(
      admin.query("update public.training_sessions set event_kind = 'social', event_subtype = 'other' where id = $1", [race.id]),
    ).rejects.toMatchObject(raised('validation_failed:event_kind'));
  });

  it('checks: minimum exactly for trainings, no scheduled non-trainings, subtype within kind, course fields', async () => {
    const { communityId } = await createPack();
    const insert = (columns: string, values: string) =>
      admin.query(
        `insert into public.training_sessions (community_id, title, starts_at, rsvp_deadline, timezone, location_name, ${columns})
         values ($1, 'X', now() + interval '3 days', now() + interval '2 days', 'UTC', 'Park', ${values})`,
        [communityId],
      );
    await expect(insert('event_kind, event_subtype, min_participants, status', "'race', 'ocr', 1, 'confirmed'")).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert('event_kind, event_subtype, status', "'race', 'ocr', 'scheduled'")).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert('event_kind, event_subtype', "'training', 'running'")).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert('event_kind, event_subtype, status', "'race', 'strength', 'confirmed'")).rejects.toMatchObject({ code: '23503' });
    await expect(insert('event_kind, event_subtype, status', "'race', null, 'confirmed'")).rejects.toMatchObject({ code: '23502' });
    await expect(insert('min_participants, activity_type, distance_km', "1, 'strength', 5")).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert('min_participants, activity_type, obstacle_count', "1, 'running', 5")).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert('min_participants, activity_type, distance_km', "1, 'running', 0")).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert('event_kind, event_subtype, status, max_participants', "'social', 'other', 'confirmed', 0")).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert('min_participants, max_participants', '3, 2')).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
});

describe('update_training per kind', () => {
  it('the kind is immutable; an absent kind keeps the stored one', async () => {
    const { communityId, organizerId } = await createPack();
    const race = await createEvent(organizerId, communityId, 'race');
    for (const kind of ['training', 'social', 'sports_event']) {
      await expect(updateEvent(organizerId, race.id, eventFormOf(race, { event_kind: kind }))).rejects.toMatchObject(
        raised('validation_failed:event_kind'),
      );
    }
    const training = await createTraining(organizerId, communityId);
    await expect(
      updateEvent(organizerId, training.id, { ...legacyFormOf(training as unknown as EventSession), event_kind: 'race', min_participants: null }),
    ).rejects.toMatchObject(raised('validation_failed:event_kind'));

    const form = eventFormOf(race, { title: 'Renamed' });
    delete form.event_kind;
    const updated = await updateEvent(organizerId, race.id, form);
    expect([updated.event_kind, updated.title]).toEqual(['race', 'Renamed']);
  });

  it('the subtype changes only within the kind, and activity_type follows', async () => {
    const { communityId, organizerId } = await createPack();
    const race = await createEvent(organizerId, communityId, 'race');
    const ocr = await updateEvent(organizerId, race.id, eventFormOf(race, { event_subtype: 'ocr', obstacle_count: 12 }));
    expect([ocr.event_subtype, ocr.activity_type, ocr.obstacle_count]).toEqual(['ocr', 'ocr', 12]);
    await expect(updateEvent(organizerId, race.id, eventFormOf(ocr, { event_subtype: 'strength' }))).rejects.toMatchObject(
      raised('validation_failed:event_subtype'),
    );
    const training = (await createTraining(organizerId, communityId)) as unknown as EventSession;
    const strength = await updateEvent(organizerId, training.id, eventFormOf(training, { event_subtype: 'strength' }));
    expect([strength.event_subtype, strength.activity_type]).toEqual(['strength', 'strength']);
  });

  it('the Milestone 1 form keeps working: a training subtype follows activity_type', async () => {
    const { communityId, organizerId } = await createPack();
    const training = (await createTraining(organizerId, communityId)) as unknown as EventSession;
    const updated = await updateEvent(organizerId, training.id, legacyFormOf(training, { activity_type: 'functional_fitness' }));
    expect([updated.event_kind, updated.event_subtype, updated.activity_type]).toEqual([
      'training',
      'functional_fitness',
      'functional_fitness',
    ]);
  });

  it('absent P1 keys keep the stored values (old app editing a race); null clears them', async () => {
    const { communityId, organizerId } = await createPack();
    const race = await createEvent(organizerId, communityId, 'race', {
      event_subtype: 'ocr',
      distance_km: 12.5,
      elevation_gain_m: 400,
      obstacle_count: 20,
      event_notes: 'Mud.',
    });
    const legacy = await updateEvent(organizerId, race.id, legacyFormOf(race, { title: 'Mud run' }));
    expect(legacy).toMatchObject({
      title: 'Mud run',
      event_kind: 'race',
      event_subtype: 'ocr',
      distance_km: '12.50',
      elevation_gain_m: 400,
      obstacle_count: 20,
      event_notes: 'Mud.',
    });
    const cleared = await updateEvent(
      organizerId,
      race.id,
      eventFormOf(legacy, { distance_km: null, elevation_gain_m: null, obstacle_count: null, event_notes: null }),
    );
    expect(cleared).toMatchObject({ distance_km: null, elevation_gain_m: null, obstacle_count: null, event_notes: null });
  });

  it('changing to a subtype that does not take the stored course fields requires clearing them', async () => {
    const { communityId, organizerId } = await createPack();
    const race = await createEvent(organizerId, communityId, 'race', { event_subtype: 'ocr', obstacle_count: 5 });
    const form = eventFormOf(race, { event_subtype: 'trail_running' });
    delete form.obstacle_count;
    await expect(updateEvent(organizerId, race.id, form)).rejects.toMatchObject(raised('validation_failed:obstacle_count'));
    const ok = await updateEvent(organizerId, race.id, { ...form, obstacle_count: null });
    expect([ok.event_subtype, ok.obstacle_count]).toEqual(['trail_running', null]);
  });

  it('non-training, registration open: start, deadline and maximum editable; no minimum', async () => {
    const { communityId, organizerId, memberIds } = await createPack(3);
    const race = await createEvent(organizerId, communityId, 'race', { max_participants: 10 });
    for (const memberId of memberIds) await setRsvp(memberId, race.id, 'going');

    const moved = await updateEvent(
      organizerId,
      race.id,
      eventFormOf(race, {
        starts_at: hoursFromNow(96),
        ends_at: hoursFromNow(98),
        rsvp_deadline: hoursFromNow(90),
        max_participants: 3,
      }),
    );
    expect(moved).toMatchObject({ status: 'confirmed', max_participants: 3, going_count: 3 });
    expect(moved.rsvp_deadline.toISOString()).toBe(hoursFromNow(90));

    await expect(updateEvent(organizerId, race.id, eventFormOf(moved, { max_participants: 2 }))).rejects.toMatchObject(
      raised('validation_failed:max_participants'),
    );
    await expect(updateEvent(organizerId, race.id, eventFormOf(moved, { min_participants: 1 }))).rejects.toMatchObject(
      raised('validation_failed:min_participants'),
    );
    await expect(
      updateEvent(organizerId, race.id, eventFormOf(moved, { rsvp_deadline: hoursFromNow(-1) })),
    ).rejects.toMatchObject(raised('validation_failed:rsvp_deadline'));
    await expect(
      updateEvent(organizerId, race.id, eventFormOf(moved, { rsvp_deadline: moved.starts_at.toISOString() })),
    ).rejects.toMatchObject(raised('validation_failed:rsvp_deadline'));
    const unlimited = await updateEvent(organizerId, race.id, eventFormOf(moved, { max_participants: null }));
    expect(unlimited.max_participants).toBeNull();
  });

  it('non-training after the deadline: deadline frozen, maximum editable (not below going), start may move to the future', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const social = await createEvent(organizerId, communityId, 'social', { max_participants: 5 });
    await setRsvp(memberIds[0], social.id, 'going');
    await setRsvp(memberIds[1], social.id, 'going');
    await makeDue(social.id);
    const due = (await getSession(social.id)) as unknown as EventSession;

    await expect(
      updateEvent(organizerId, social.id, eventFormOf(due, { rsvp_deadline: hoursFromNow(10) })),
    ).rejects.toMatchObject(raised('validation_failed:rsvp_deadline'));
    await expect(updateEvent(organizerId, social.id, eventFormOf(due, { max_participants: 1 }))).rejects.toMatchObject(
      raised('validation_failed:max_participants'),
    );
    const raised2 = await updateEvent(organizerId, social.id, eventFormOf(due, { max_participants: 2 }));
    expect(raised2.max_participants).toBe(2);
    const later = await updateEvent(
      organizerId,
      social.id,
      eventFormOf(raised2, { starts_at: hoursFromNow(100), ends_at: hoursFromNow(101), event_notes: 'Moved' }),
    );
    expect(later.starts_at.toISOString()).toBe(hoursFromNow(100));
    expect(later.event_notes).toBe('Moved');
    await expect(
      updateEvent(organizerId, social.id, eventFormOf(later, { starts_at: hoursFromNow(-0.5), ends_at: null })),
    ).rejects.toMatchObject(raised('validation_failed:starts_at'));
  });

  it('the attendance time freeze applies to every kind', async () => {
    const { communityId, organizerId } = await createPack(1);
    const race = await createEvent(organizerId, communityId, 'race');
    await admin.query(
      `update public.training_sessions
       set rsvp_deadline = now() - interval '4 hours', starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour'
       where id = $1`,
      [race.id],
    );
    const ended = (await getSession(race.id)) as unknown as EventSession;
    await expect(
      updateEvent(organizerId, race.id, eventFormOf(ended, { starts_at: hoursFromNow(5), ends_at: hoursFromNow(6) })),
    ).rejects.toMatchObject(raised('validation_failed:starts_at'));
    const renamed = await updateEvent(organizerId, race.id, eventFormOf(ended, { title: 'Results soon', distance_km: 9 }));
    expect([renamed.title, renamed.distance_km]).toEqual(['Results soon', '9.00']);
  });

  it('trainings keep every Milestone 1/2 rule: a confirmed training freezes its limits', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const training = (await createTraining(organizerId, communityId, { min_participants: 1, max_participants: 5 })) as unknown as EventSession;
    await setRsvp(memberIds[0], training.id, 'going');
    await makeDue(training.id);
    await finalize();
    const confirmed = (await getSession(training.id)) as unknown as EventSession;
    expect(confirmed.status).toBe('confirmed');
    await expect(updateEvent(organizerId, training.id, eventFormOf(confirmed, { max_participants: 6 }))).rejects.toMatchObject(
      raised('validation_failed:max_participants'),
    );
    await expect(updateEvent(organizerId, training.id, eventFormOf(confirmed, { min_participants: 2 }))).rejects.toMatchObject(
      raised('validation_failed:min_participants'),
    );
    await expect(updateEvent(organizerId, training.id, eventFormOf(confirmed, { min_participants: null }))).rejects.toMatchObject(
      raised('validation_failed:min_participants'),
    );
  });

  it('cancelled and completed events of any kind are not editable', async () => {
    const { communityId, organizerId } = await createPack();
    const sports = await createEvent(organizerId, communityId, 'sports_event');
    await cancelTraining(organizerId, sports.id);
    await expect(updateEvent(organizerId, sports.id, eventFormOf(sports))).rejects.toMatchObject(
      raised('session_not_editable'),
    );
  });
});

describe('cancel_training per kind', () => {
  it.each(KINDS)('%s: organizer cancel, idempotent', async (kind) => {
    const { communityId, organizerId } = await createPack();
    const session = await createEvent(organizerId, communityId, kind);
    const cancelled = (await cancelTraining(organizerId, session.id)) as unknown as EventSession;
    expect(cancelled).toMatchObject({ status: 'cancelled', cancel_reason: 'organizer', cancelled_by: organizerId, event_kind: kind });
    const again = (await cancelTraining(organizerId, session.id)) as unknown as EventSession;
    expect(again.cancelled_at).toEqual(cancelled.cancelled_at);
  });
});

describe('authorization matrix for the changed RPCs (unchanged)', () => {
  it('member, outsider, organizer of another community, removed organizer, anon', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const other = await createPack();
    const outsider = await addMember(other.communityId);
    const removedOrganizer = await addMember(communityId, { role: 'organizer', status: 'removed' });
    const race = await createEvent(organizerId, communityId, 'race');
    const input = JSON.stringify(eventInput('race'));
    const form = JSON.stringify(eventFormOf(race, { title: 'Hijacked' }));

    for (const userId of [memberIds[0], outsider, other.organizerId, removedOrganizer]) {
      await expect(
        asUser(userId, (db) => db.query('select public.create_training($1, $2)', [communityId, input])),
      ).rejects.toMatchObject(raised('forbidden'));
      await expect(
        asUser(userId, (db) => db.query('select public.update_training($1, $2)', [race.id, form])),
      ).rejects.toMatchObject(raised('forbidden'));
      await expect(
        asUser(userId, (db) => db.query('select public.cancel_training($1)', [race.id])),
      ).rejects.toMatchObject(raised('forbidden'));
    }
    for (const userId of [outsider, other.organizerId, removedOrganizer]) {
      await expect(setRsvp(userId, race.id, 'going')).rejects.toMatchObject(raised('not_a_member'));
    }
    await expect(
      asAnon((db) => db.query('select public.create_training($1, $2)', [communityId, input])),
    ).rejects.toMatchObject(denied);
    await expect(asAnon((db) => db.query('select public.set_rsvp($1, $2)', [race.id, 'going']))).rejects.toMatchObject(denied);

    const stored = (await getSession(race.id)) as unknown as EventSession;
    expect(stored).toMatchObject({ title: race.title, status: 'confirmed', going_count: 0 });
    const { rows } = await admin.query('select count(*)::int as n from public.training_sessions');
    expect(rows[0].n).toBe(1);
  });

  it('a member reads events of their community (RLS), an outsider does not', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const outsider = await addMember((await createPack()).communityId);
    const race = await createEvent(organizerId, communityId, 'race', { distance_km: 5 });
    const read = (userId: string) =>
      asUser(userId, (db) =>
        db.query('select event_kind::text, event_subtype, distance_km from public.training_sessions where id = $1', [race.id]),
      );
    expect((await read(memberIds[0])).rows).toEqual([{ event_kind: 'race', event_subtype: 'trail_running', distance_km: '5.00' }]);
    expect((await read(outsider)).rows).toEqual([]);
  });
});
