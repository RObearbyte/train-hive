import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  admin,
  cancelTraining,
  closeDb,
  createPack,
  createTraining,
  finalize,
  getSession,
  makeDue,
  RAISED,
  realGoingCount,
  resetData,
  setRsvp,
} from './helpers';
import { finalizeAttendance, makeEnded, recordAttendance } from './attendance-helpers';
import { enqueueReminders, notifications, recipients, sorted } from './notifications-helpers';
import { communityStats, history, myStats } from './stats-helpers';
import { createEvent, eventFormOf, type EventKind, type EventSession, KINDS, updateEvent } from './events-helpers';

const raised = (message: string) => ({ code: RAISED, message });

beforeEach(resetData);
afterAll(closeDb);

const NON_TRAINING: EventKind[] = ['race', 'sports_event', 'social'];

describe('set_rsvp per kind and status', () => {
  it.each(NON_TRAINING)('%s: confirmed at creation, takes RSVPs before the deadline', async (kind) => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const event = await createEvent(organizerId, communityId, kind);
    expect(event.status).toBe('confirmed');
    expect(await setRsvp(memberIds[0], event.id, 'going')).toEqual({ response: 'going', going_count: 1, status: 'confirmed' });
    expect(await setRsvp(memberIds[1], event.id, 'not_going')).toEqual({ response: 'not_going', going_count: 1, status: 'confirmed' });
    expect(await setRsvp(memberIds[0], event.id, 'not_going')).toEqual({ response: 'not_going', going_count: 0, status: 'confirmed' });
    expect(await setRsvp(memberIds[0], event.id, 'going')).toMatchObject({ going_count: 1 });
    // Idempotent repeat.
    expect(await setRsvp(memberIds[0], event.id, 'going')).toMatchObject({ going_count: 1 });
    expect(await realGoingCount(event.id)).toBe(1);
  });

  it.each(NON_TRAINING)('%s: closed after the deadline (stays confirmed)', async (kind) => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const event = await createEvent(organizerId, communityId, kind);
    await makeDue(event.id);
    await expect(setRsvp(memberIds[0], event.id, 'going')).rejects.toMatchObject(raised('rsvp_closed'));
    expect((await getSession(event.id)).status).toBe('confirmed');
  });

  it.each(NON_TRAINING)('%s: capacity applies (session_full)', async (kind) => {
    const { communityId, organizerId, memberIds } = await createPack(3);
    const event = await createEvent(organizerId, communityId, kind, { max_participants: 2 });
    await setRsvp(memberIds[0], event.id, 'going');
    await setRsvp(memberIds[1], event.id, 'going');
    await expect(setRsvp(memberIds[2], event.id, 'going')).rejects.toMatchObject(raised('session_full'));
    // Freeing a place lets the next one in.
    await setRsvp(memberIds[0], event.id, 'not_going');
    expect(await setRsvp(memberIds[2], event.id, 'going')).toMatchObject({ going_count: 2 });
  });

  it.each(NON_TRAINING)('%s: cancelled -> rsvp_closed', async (kind) => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const event = await createEvent(organizerId, communityId, kind);
    await cancelTraining(organizerId, event.id);
    await expect(setRsvp(memberIds[0], event.id, 'going')).rejects.toMatchObject(raised('rsvp_closed'));
  });

  it('completed non-training event -> rsvp_closed', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const race = await createEvent(organizerId, communityId, 'race');
    await setRsvp(memberIds[0], race.id, 'going');
    await makeEnded(race.id);
    await finalizeAttendance(organizerId, race.id);
    await expect(setRsvp(memberIds[1], race.id, 'going')).rejects.toMatchObject(raised('rsvp_closed'));
  });

  it('training: open while scheduled; a training confirmed by the finalizer keeps refusing changes', async () => {
    const { communityId, organizerId, memberIds } = await createPack(3);
    const training = await createTraining(organizerId, communityId, { min_participants: 1 });
    expect(await setRsvp(memberIds[0], training.id, 'going')).toEqual({ response: 'going', going_count: 1, status: 'scheduled' });
    await makeDue(training.id);
    // Scheduled but past its deadline: closed (waiting for the finalizer).
    await expect(setRsvp(memberIds[1], training.id, 'going')).rejects.toMatchObject(raised('rsvp_closed'));
    await finalize();
    expect((await getSession(training.id)).status).toBe('confirmed');
    // Confirmed with the deadline moved back into the future (time travel): still closed.
    await admin.query("update public.training_sessions set rsvp_deadline = now() + interval '1 hour' where id = $1", [training.id]);
    await expect(setRsvp(memberIds[1], training.id, 'going')).rejects.toMatchObject(raised('rsvp_closed'));
    await expect(setRsvp(memberIds[0], training.id, 'not_going')).rejects.toMatchObject(raised('rsvp_closed'));
  });
});

describe('finalize_due_sessions only decides trainings', () => {
  it('non-training events past their deadline are never decided or cancelled; trainings are, as before', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const events: EventSession[] = [];
    for (const kind of NON_TRAINING) events.push(await createEvent(organizerId, communityId, kind));
    const reached = await createTraining(organizerId, communityId, { min_participants: 1 });
    const short = await createTraining(organizerId, communityId, { min_participants: 2 });
    await setRsvp(memberIds[0], reached.id, 'going');
    await setRsvp(memberIds[0], short.id, 'going');
    for (const id of [...events.map((e) => e.id), reached.id, short.id]) await makeDue(id);

    expect(await finalize()).toBe(2);
    expect(await finalize()).toBe(0);
    for (const event of events) {
      expect(await getSession(event.id)).toMatchObject({ status: 'confirmed', decided_at: null, cancel_reason: null });
    }
    expect(await getSession(reached.id)).toMatchObject({ status: 'confirmed', cancel_reason: null });
    expect(await getSession(short.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'insufficient_participation' });
    expect(memberIds).toHaveLength(2);
  });
});

describe('removing a member releases their place on an open event', () => {
  it('race open for registration: going released; after the deadline it stands', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const open = await createEvent(organizerId, communityId, 'race', { max_participants: 1 });
    const closed = await createEvent(organizerId, communityId, 'social');
    await setRsvp(memberIds[0], open.id, 'going');
    await setRsvp(memberIds[0], closed.id, 'going');
    await makeDue(closed.id);
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [memberIds[0]]);
    expect((await getSession(open.id)).going_count).toBe(0);
    expect(await realGoingCount(open.id)).toBe(0);
    expect((await getSession(closed.id)).going_count).toBe(1);
    // The freed place can be taken.
    expect(await setRsvp(memberIds[1], open.id, 'going')).toMatchObject({ going_count: 1 });
  });
});

describe('notifications per kind', () => {
  it.each([
    ['training', 'New training: Morning run'],
    ['race', 'New race: Morning run'],
    ['sports_event', 'New sports event: Morning run'],
    ['social', 'New social event: Morning run'],
  ] as const)('%s created -> "%s" to every member but the creator, and nothing else', async (kind, title) => {
    const { communityId, organizerId, memberIds } = await createPack(3);
    const event = await createEvent(organizerId, communityId, kind);
    const rows = await notifications('related_session_id = $1', [event.id]);
    expect(rows.map((n) => n.kind)).toEqual(['training_created', 'training_created', 'training_created']);
    expect(new Set(rows.map((n) => n.title))).toEqual(new Set([title]));
    expect(rows[0].deep_link).toBe(`/trainings/${event.id}`);
    expect(rows[0].dedupe_key).toBe(`training_created:${event.id}`);
    expect(await recipients('training_created', event.id)).toEqual(sorted(memberIds));
  });

  it.each(NON_TRAINING)('%s: never a "confirmed" notification (creation, RSVPs, deadline, finalizer)', async (kind) => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const event = await createEvent(organizerId, communityId, kind);
    await setRsvp(memberIds[0], event.id, 'going');
    await makeDue(event.id);
    await finalize();
    expect(await recipients('training_confirmed', event.id)).toEqual([]);
    const kinds = (await notifications('related_session_id = $1', [event.id])).map((n) => n.kind);
    expect(new Set(kinds)).toEqual(new Set(['training_created']));
  });

  it('training: confirmed and insufficient-participation texts unchanged', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const ok = await createTraining(organizerId, communityId, { min_participants: 1, title: 'Hill reps' });
    const short = await createTraining(organizerId, communityId, { min_participants: 2, title: 'Tempo' });
    await setRsvp(memberIds[0], ok.id, 'going');
    await makeDue(ok.id);
    await makeDue(short.id);
    await finalize();
    const confirmed = await notifications("kind = 'training_confirmed' and related_session_id = $1", [ok.id]);
    expect(sorted(confirmed.map((n) => n.user_id))).toEqual(sorted([memberIds[0], organizerId]));
    expect(confirmed[0].title).toBe('Training confirmed: Hill reps');
    const cancelled = await notifications("kind = 'training_cancelled' and related_session_id = $1", [short.id]);
    expect(cancelled).toHaveLength(3);
    expect(cancelled[0].title).toBe('Training cancelled: Tempo');
    expect(cancelled[0].body).toMatch(/ - not enough participants\.$/);
  });

  it.each([
    ['training', 'Training cancelled: Morning run'],
    ['race', 'Race cancelled: Morning run'],
    ['sports_event', 'Sports event cancelled: Morning run'],
    ['social', 'Social event cancelled: Morning run'],
  ] as const)('%s organizer cancel -> "%s"; not_going members and the canceller excluded', async (kind, title) => {
    const { communityId, organizerId, memberIds } = await createPack(3);
    const event = await createEvent(organizerId, communityId, kind);
    await setRsvp(memberIds[2], event.id, 'not_going');
    await cancelTraining(organizerId, event.id);
    const rows = await notifications("kind = 'training_cancelled' and related_session_id = $1", [event.id]);
    expect(sorted(rows.map((n) => n.user_id))).toEqual(sorted(memberIds.slice(0, 2)));
    expect(new Set(rows.map((n) => n.title))).toEqual(new Set([title]));
    expect(rows[0].body).toMatch(/ - cancelled by the organizer\.$/);
    expect(rows[0].dedupe_key).toBe(`training_cancelled:${event.id}`);
  });

  it.each([
    ['training', 'Training updated: Night run'],
    ['race', 'Race updated: Night run'],
    ['sports_event', 'Sports event updated: Night run'],
    ['social', 'Social event updated: Night run'],
  ] as const)('%s material change -> "%s"; kind-specific fields are silent', async (kind, title) => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const event = await createEvent(organizerId, communityId, kind);
    await updateEvent(organizerId, event.id, eventFormOf(event, { title: 'Night run' }));
    const rows = await notifications("kind = 'training_updated' and related_session_id = $1", [event.id]);
    expect(sorted(rows.map((n) => n.user_id))).toEqual(sorted(memberIds));
    expect(rows[0].title).toBe(title);
    expect(rows[0].body).toMatch(/^New title\. /);
    // Notes and course fields: no notification.
    const renamed = (await getSession(event.id)) as unknown as EventSession;
    await updateEvent(organizerId, event.id, eventFormOf(renamed, { event_notes: 'Changed notes', max_participants: 50 }));
    expect(await notifications("kind = 'training_updated' and related_session_id = $1", [event.id])).toHaveLength(2);
  });
});

describe('reminders per kind', () => {
  /** Moves the event's start `hours` ahead (deadline 30 minutes from now), as superuser. */
  async function startIn(sessionId: string, hours: number): Promise<void> {
    await admin.query(
      `update public.training_sessions
       set rsvp_deadline = now() + interval '30 minutes', starts_at = now() + make_interval(secs => $2::double precision * 3600), ends_at = null
       where id = $1`,
      [sessionId, hours],
    );
  }

  it.each(KINDS)('%s: 24h and 2h reminders for going members of a confirmed event', async (kind) => {
    const { communityId, organizerId, memberIds } = await createPack(3);
    const event = await createEvent(organizerId, communityId, kind, kind === 'training' ? { min_participants: 1 } : {});
    await setRsvp(memberIds[0], event.id, 'going');
    await setRsvp(memberIds[1], event.id, 'going');
    await setRsvp(memberIds[2], event.id, 'not_going');
    if (kind === 'training') {
      await makeDue(event.id);
      await finalize();
    }
    expect((await getSession(event.id)).status).toBe('confirmed');

    await startIn(event.id, 23.5);
    await enqueueReminders();
    const day = await notifications("kind = 'training_reminder' and related_session_id = $1", [event.id]);
    expect(sorted(day.map((n) => n.user_id))).toEqual(sorted(memberIds.slice(0, 2)));
    expect(day[0].title).toBe('Tomorrow: Morning run');

    // Older confirmation (if any) so the 2h skip rule does not apply.
    await admin.query("update public.notifications set created_at = now() - interval '2 hours' where related_session_id = $1", [event.id]);
    await startIn(event.id, 1.5);
    await enqueueReminders();
    const soon = await notifications(
      "kind = 'training_reminder' and related_session_id = $1 and dedupe_key like 'training_reminder_2h:%'",
      [event.id],
    );
    expect(sorted(soon.map((n) => n.user_id))).toEqual(sorted(memberIds.slice(0, 2)));
    expect(soon[0].title).toBe('Starting soon: Morning run');
    expect(await enqueueReminders()).toBe(0);
  });

  it('a scheduled training still gets the 24h reminder, and no 2h reminder', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const training = await createTraining(organizerId, communityId, { min_participants: 3 });
    await setRsvp(memberIds[0], training.id, 'going');
    await startIn(training.id, 23.5);
    await enqueueReminders();
    expect(await recipients('training_reminder', training.id)).toEqual([memberIds[0]]);
    await startIn(training.id, 1.5);
    await enqueueReminders();
    expect(await recipients('training_reminder', training.id)).toEqual([memberIds[0]]);
  });

  it('a cancelled race gets no reminders', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const race = await createEvent(organizerId, communityId, 'race');
    await setRsvp(memberIds[0], race.id, 'going');
    await cancelTraining(organizerId, race.id);
    await startIn(race.id, 23.5);
    await enqueueReminders();
    expect(await recipients('training_reminder', race.id)).toEqual([]);
  });
});

describe('attendance and statistics for every kind', () => {
  it('completed events of every kind count like trainings; cancelled ones do not', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const [ana, ben] = memberIds;
    // Members since before the events (eligibility: joined_at <= starts_at).
    await admin.query(
      "update public.memberships set joined_at = now() - interval '20 days' where community_id = $1",
      [communityId],
    );
    const completed: Record<string, EventSession> = {};
    for (const kind of KINDS) {
      const event = await createEvent(organizerId, communityId, kind, {
        title: `The ${kind}`,
        ...(kind === 'training' ? { min_participants: 1 } : {}),
      });
      await setRsvp(ana, event.id, 'going');
      if (kind === 'training') {
        await makeDue(event.id);
        await finalize();
      }
      await makeEnded(event.id);
      // Spread the starts so ordering is deterministic (newest = social).
      await admin.query(
        "update public.training_sessions set starts_at = starts_at - make_interval(mins => $2), rsvp_deadline = rsvp_deadline - make_interval(mins => $2) where id = $1",
        [event.id, 10 * (4 - KINDS.indexOf(kind))],
      );
      await recordAttendance(organizerId, event.id, ana, 'present');
      const done = await finalizeAttendance(organizerId, event.id);
      expect(done.status).toBe('completed');
      completed[kind] = (await getSession(event.id)) as unknown as EventSession;
    }
    // A cancelled race and a race that was never completed are not in the statistics.
    const cancelled = await createEvent(organizerId, communityId, 'race', { title: 'Cancelled race' });
    await setRsvp(ana, cancelled.id, 'going');
    await cancelTraining(organizerId, cancelled.id);
    await admin.query(
      "update public.training_sessions set starts_at = now() - interval '1 day', rsvp_deadline = now() - interval '2 days', ends_at = null where id = $1",
      [cancelled.id],
    );
    const open = await createEvent(organizerId, communityId, 'social', { title: 'Not completed' });
    await setRsvp(ana, open.id, 'going');
    await makeEnded(open.id);

    const mine = await myStats(ana, communityId, '30d');
    expect(mine).toMatchObject({ eligible: 4, attended: 4, confirmed_rsvps: 4, rsvp_going_present: 4, attendance_rate: 100 });
    const his = await myStats(ben, communityId, '30d');
    expect(his).toMatchObject({ eligible: 4, attended: 0, not_recorded: 4 });

    const community = await communityStats(organizerId, communityId, '30d');
    expect(community).toMatchObject({
      completed_trainings: 4,
      total_attendances: 4,
      cancelled_by_organizer: 1,
      cancelled_insufficient_participation: 0,
    });
    const top = community.top_sessions as unknown as { session_id: string; event_kind: string; min_participants: number | null }[];
    expect(top.map((t) => t.event_kind).sort()).toEqual([...KINDS].sort());
    expect(top.find((t) => t.event_kind === 'race')?.min_participants).toBeNull();
    expect(top.find((t) => t.event_kind === 'training')?.min_participants).toBe(1);

    const page = await history(ana, communityId, 'all');
    const items = page.items as unknown as { title: string; event_kind: string; event_subtype: string; activity_type: string; outcome: string }[];
    expect(items.map((i) => [i.event_kind, i.event_subtype, i.activity_type, i.outcome])).toEqual([
      ['social', 'social_gathering', 'other', 'present'],
      ['sports_event', 'crossfit_event', 'functional_fitness', 'present'],
      ['race', 'trail_running', 'trail_running', 'present'],
      ['training', 'running', 'running', 'present'],
    ]);
    expect(items.map((i) => i.title)).not.toContain('Cancelled race');
    expect(Object.keys(completed)).toHaveLength(4);
  });

  it('cancelled_insufficient_participation only ever concerns trainings', async () => {
    const { communityId, organizerId } = await createPack(1);
    const training = await createTraining(organizerId, communityId, { min_participants: 2 });
    const race = await createEvent(organizerId, communityId, 'race');
    for (const id of [training.id, race.id]) await makeDue(id);
    await finalize();
    for (const id of [training.id, race.id]) {
      await admin.query(
        "update public.training_sessions set starts_at = now() - interval '1 day', rsvp_deadline = now() - interval '2 days', ends_at = null where id = $1",
        [id],
      );
    }
    const community = await communityStats(organizerId, communityId, '30d');
    expect(community).toMatchObject({ cancelled_insufficient_participation: 1, cancelled_by_organizer: 0, completed_trainings: 0 });
    expect((await getSession(race.id)).status).toBe('confirmed');
  });

  it('attendance needs a confirmed, ended event of any kind', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const social = await createEvent(organizerId, communityId, 'social');
    await setRsvp(memberIds[0], social.id, 'going');
    await expect(recordAttendance(organizerId, social.id, memberIds[0], 'present')).rejects.toMatchObject(
      raised('session_not_ended'),
    );
    await makeEnded(social.id);
    const record = await recordAttendance(organizerId, social.id, memberIds[0], 'present');
    expect(record.status).toBe('present');
    // Real attendance blocks cancelling, as for trainings.
    await expect(cancelTraining(organizerId, social.id)).rejects.toMatchObject(raised('session_has_attendance'));
    await finalizeAttendance(organizerId, social.id);
    await expect(cancelTraining(organizerId, social.id)).rejects.toMatchObject(raised('session_not_cancellable'));
  });
});
