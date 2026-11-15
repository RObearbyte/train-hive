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
  createPack,
  createTraining,
  createUser,
  finalize,
  getSession,
  INSUFFICIENT_PRIVILEGE,
  makeDue,
  RAISED,
  realGoingCount,
  resetData,
  rpc,
  type RsvpResponse,
  setRsvp,
} from './helpers';

const raised = (message: string) => ({ code: RAISED, message });
const denied = { code: INSUFFICIENT_PRIVILEGE };
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

async function rsvpOf(sessionId: string, userId: string) {
  const { rows } = await admin.query<{
    response: RsvpResponse;
    community_id: string;
    responded_at: Date;
    updated_at: Date;
  }>(
    'select response, community_id, responded_at, updated_at from public.training_rsvps where session_id = $1 and user_id = $2',
    [sessionId, userId],
  );
  return rows[0];
}

/** going_count must equal the real number of going rows; returns it. */
async function consistentGoingCount(sessionId: string): Promise<number> {
  const session = await getSession(sessionId);
  expect(session.going_count).toBe(await realGoingCount(sessionId));
  return session.going_count;
}

beforeEach(resetData);
afterAll(closeDb);

describe('set_rsvp', () => {
  it('creates, modifies and clears a response, keeping going_count in step', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [memberId] = memberIds;
    const session = await createTraining(organizerId, communityId);

    expect(await setRsvp(memberId, session.id, 'going')).toEqual({ response: 'going', going_count: 1, status: 'scheduled' });
    expect(await rsvpOf(session.id, memberId)).toMatchObject({ response: 'going', community_id: communityId });
    expect(await consistentGoingCount(session.id)).toBe(1);

    expect(await setRsvp(memberId, session.id, 'not_going')).toEqual({ response: 'not_going', going_count: 0, status: 'scheduled' });
    expect(await consistentGoingCount(session.id)).toBe(0);

    expect(await setRsvp(memberId, session.id, 'going')).toMatchObject({ going_count: 1 });
    expect(await setRsvp(memberId, session.id, 'no_response')).toEqual({ response: 'no_response', going_count: 0, status: 'scheduled' });
    expect((await rsvpOf(session.id, memberId)).response).toBe('no_response');
    expect(await consistentGoingCount(session.id)).toBe(0);
    expect(await countRows('training_rsvps')).toBe(1);
  });

  it('is idempotent: repeating a response succeeds and changes nothing', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [memberId] = memberIds;
    const session = await createTraining(organizerId, communityId);

    const first = await setRsvp(memberId, session.id, 'going');
    const stored = await rsvpOf(session.id, memberId);
    const second = await setRsvp(memberId, session.id, 'going');
    const third = await setRsvp(memberId, session.id, 'going');

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(await rsvpOf(session.id, memberId)).toEqual(stored);
    expect(await consistentGoingCount(session.id)).toBe(1);

    await setRsvp(memberId, session.id, 'not_going');
    expect(await setRsvp(memberId, session.id, 'not_going')).toMatchObject({ response: 'not_going', going_count: 0 });
    expect(await consistentGoingCount(session.id)).toBe(0);
  });

  it('no_response without an existing RSVP succeeds and stores nothing', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const session = await createTraining(organizerId, communityId);

    expect(await setRsvp(memberIds[0], session.id, 'no_response')).toEqual({ response: 'no_response', going_count: 0, status: 'scheduled' });
    expect(await countRows('training_rsvps')).toBe(0);
  });

  it('lets the organizer RSVP too and counts every member separately', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const session = await createTraining(organizerId, communityId);

    await setRsvp(organizerId, session.id, 'going');
    await setRsvp(memberIds[0], session.id, 'going');
    expect(await setRsvp(memberIds[1], session.id, 'not_going')).toMatchObject({ going_count: 2 });
    expect(await consistentGoingCount(session.id)).toBe(2);
  });

  it('rejects non-members: outsiders, removed members and members of another community', async () => {
    const { communityId, organizerId } = await createPack();
    const other = await createPack(1);
    const removed = await addMember(communityId, { status: 'removed' });
    const outsider = await createUser();
    const session = await createTraining(organizerId, communityId);

    for (const userId of [outsider, removed, other.memberIds[0], other.organizerId]) {
      await expect(setRsvp(userId, session.id, 'going')).rejects.toMatchObject(raised('not_a_member'));
    }
    expect(await countRows('training_rsvps')).toBe(0);
    expect(await consistentGoingCount(session.id)).toBe(0);
  });

  it('raises not_found, validation_failed:response and not_authenticated, and denies anon', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const session = await createTraining(organizerId, communityId);

    await expect(setRsvp(memberIds[0], UNKNOWN_ID, 'going')).rejects.toMatchObject(raised('not_found'));
    await expect(
      asUser(memberIds[0], (db) => rpc(db, 'set_rsvp', [session.id, null])),
    ).rejects.toMatchObject(raised('validation_failed:response'));
    await expect(
      asRole('authenticated', null, (db) => rpc(db, 'set_rsvp', [session.id, 'going'])),
    ).rejects.toMatchObject(raised('not_authenticated'));
    await expect(asAnon((db) => rpc(db, 'set_rsvp', [session.id, 'going']))).rejects.toMatchObject(denied);
    expect(await countRows('training_rsvps')).toBe(0);
  });

  it('is closed once the deadline has passed, even before the finalizer runs', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const session = await createTraining(organizerId, communityId);
    await setRsvp(memberIds[0], session.id, 'going');
    await makeDue(session.id);

    await expect(setRsvp(memberIds[1], session.id, 'going')).rejects.toMatchObject(raised('rsvp_closed'));
    await expect(setRsvp(memberIds[0], session.id, 'not_going')).rejects.toMatchObject(raised('rsvp_closed'));
    await expect(setRsvp(memberIds[0], session.id, 'no_response')).rejects.toMatchObject(raised('rsvp_closed'));
    expect((await getSession(session.id)).status).toBe('scheduled');
    expect(await consistentGoingCount(session.id)).toBe(1);
  });

  it('is closed on confirmed, cancelled and completed sessions', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const confirmed = await createTraining(organizerId, communityId, { min_participants: 1 });
    await setRsvp(memberIds[0], confirmed.id, 'going');
    await makeDue(confirmed.id);
    await finalize();
    const cancelled = await createTraining(organizerId, communityId);
    await setRsvp(memberIds[0], cancelled.id, 'going');
    await cancelTraining(organizerId, cancelled.id);
    const completed = await createTraining(organizerId, communityId);
    await admin.query("update public.training_sessions set status = 'completed', attendance_finalized_at = now() where id = $1", [completed.id]);

    for (const session of [confirmed, cancelled, completed]) {
      await expect(setRsvp(memberIds[1], session.id, 'going')).rejects.toMatchObject(raised('rsvp_closed'));
      await expect(setRsvp(memberIds[0], session.id, 'not_going')).rejects.toMatchObject(raised('rsvp_closed'));
    }
    expect((await getSession(confirmed.id)).going_count).toBe(1);
    expect((await getSession(cancelled.id)).going_count).toBe(1);
  });
});

describe('capacity', () => {
  it('rejects going when the session is full and frees the place when someone withdraws', async () => {
    const { communityId, organizerId, memberIds } = await createPack(3);
    const session = await createTraining(organizerId, communityId, { min_participants: 1, max_participants: 2 });

    await setRsvp(memberIds[0], session.id, 'going');
    await setRsvp(memberIds[1], session.id, 'going');
    await expect(setRsvp(memberIds[2], session.id, 'going')).rejects.toMatchObject(raised('session_full'));
    // A member who already has a place can repeat "going"; others can still decline.
    expect(await setRsvp(memberIds[0], session.id, 'going')).toMatchObject({ going_count: 2 });
    expect(await setRsvp(memberIds[2], session.id, 'not_going')).toMatchObject({ going_count: 2 });

    await setRsvp(memberIds[0], session.id, 'not_going');
    expect(await setRsvp(memberIds[2], session.id, 'going')).toMatchObject({ going_count: 2 });
    expect(await consistentGoingCount(session.id)).toBe(2);
  });

  it('gives exactly 3 places to 10 concurrent members when max_participants = 3', async () => {
    const { communityId, organizerId, memberIds } = await createPack(10);
    const session = await createTraining(organizerId, communityId, { min_participants: 1, max_participants: 3 });

    const results = await Promise.allSettled(memberIds.map((id) => setRsvp(id, session.id, 'going')));

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(7);
    for (const failure of rejected) expect(failure.reason).toMatchObject(raised('session_full'));
    expect(await consistentGoingCount(session.id)).toBe(3);
    expect(await countRows('training_rsvps', 'session_id = $1', [session.id])).toBe(3);
  });

  it('keeps going_count equal to the real count under concurrent mixed toggles', async () => {
    const { communityId, organizerId, memberIds } = await createPack(12);
    const session = await createTraining(organizerId, communityId, { min_participants: 1 });
    const cycle: RsvpResponse[] = ['going', 'not_going', 'going', 'no_response', 'going', 'not_going', 'going'];

    // Each member walks through a different-length prefix of the cycle on their own connection.
    const finals = await Promise.all(
      memberIds.map((id, index) =>
        asUser(id, async (db) => {
          const steps = cycle.slice(0, 2 + (index % (cycle.length - 1)));
          for (const response of steps) await rpc(db, 'set_rsvp', [session.id, response]);
          return steps[steps.length - 1];
        }),
      ),
    );

    const expected = finals.filter((response) => response === 'going').length;
    expect(expected).toBeGreaterThan(0);
    expect(await consistentGoingCount(session.id)).toBe(expected);
  });

  it('never exceeds max_participants under concurrent toggles', async () => {
    const { communityId, organizerId, memberIds } = await createPack(12);
    const session = await createTraining(organizerId, communityId, { min_participants: 1, max_participants: 4 });

    await Promise.all(
      memberIds.map((id) =>
        asUser(id, async (db) => {
          for (const response of ['going', 'not_going', 'going'] as const) {
            try {
              await rpc(db, 'set_rsvp', [session.id, response]);
            } catch (error) {
              // Losing the race for a place is expected; anything else is a real failure.
              expect(error).toMatchObject(raised('session_full'));
            }
          }
        }),
      ),
    );

    const count = await consistentGoingCount(session.id);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(4);
  });
});

describe('minimum threshold', () => {
  it('stays scheduled at min - 1, at min, and after withdrawing back below min', async () => {
    const { communityId, organizerId, memberIds } = await createPack(3);
    const session = await createTraining(organizerId, communityId, { min_participants: 3 });

    await setRsvp(memberIds[0], session.id, 'going');
    expect(await setRsvp(memberIds[1], session.id, 'going')).toEqual({ response: 'going', going_count: 2, status: 'scheduled' });
    expect(await setRsvp(memberIds[2], session.id, 'going')).toEqual({ response: 'going', going_count: 3, status: 'scheduled' });
    // Reaching the minimum is provisional: nothing is decided before the deadline.
    expect(await getSession(session.id)).toMatchObject({ status: 'scheduled', decided_at: null, going_count: 3 });

    expect(await setRsvp(memberIds[2], session.id, 'not_going')).toEqual({ response: 'not_going', going_count: 2, status: 'scheduled' });
    expect(await finalize()).toBe(0);
    expect(await getSession(session.id)).toMatchObject({ status: 'scheduled', decided_at: null, going_count: 2 });
  });
});

describe('finalize_due_sessions', () => {
  it('confirms at exactly min and cancels at min - 1 with insufficient_participation', async () => {
    const { communityId, organizerId, memberIds } = await createPack(3);
    const atMin = await createTraining(organizerId, communityId, { min_participants: 2 });
    const belowMin = await createTraining(organizerId, communityId, { min_participants: 2 });
    const aboveMin = await createTraining(organizerId, communityId, { min_participants: 2 });
    for (const id of memberIds.slice(0, 2)) await setRsvp(id, atMin.id, 'going');
    await setRsvp(memberIds[0], belowMin.id, 'going');
    await setRsvp(memberIds[1], belowMin.id, 'not_going');
    for (const id of memberIds) await setRsvp(id, aboveMin.id, 'going');
    for (const session of [atMin, belowMin, aboveMin]) await makeDue(session.id);

    expect(await finalize()).toBe(3);

    const confirmed = await getSession(atMin.id);
    expect(confirmed).toMatchObject({ status: 'confirmed', cancel_reason: null, cancelled_at: null, cancelled_by: null, going_count: 2 });
    expect(confirmed.decided_at).toBeInstanceOf(Date);
    const cancelled = await getSession(belowMin.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', cancel_reason: 'insufficient_participation', cancelled_by: null, going_count: 1 });
    expect(cancelled.decided_at).toBeInstanceOf(Date);
    expect(cancelled.cancelled_at).toEqual(cancelled.decided_at);
    expect((await getSession(aboveMin.id)).status).toBe('confirmed');
  });

  it('is idempotent: a second run decides nothing and changes nothing', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const confirmed = await createTraining(organizerId, communityId, { min_participants: 1 });
    const cancelled = await createTraining(organizerId, communityId, { min_participants: 2 });
    await setRsvp(memberIds[0], confirmed.id, 'going');
    await makeDue(confirmed.id);
    await makeDue(cancelled.id);

    expect(await finalize()).toBe(2);
    const afterFirst = [await getSession(confirmed.id), await getSession(cancelled.id)];
    expect(await finalize()).toBe(0);
    expect(await finalize()).toBe(0);

    expect([await getSession(confirmed.id), await getSession(cancelled.id)]).toEqual(afterFirst);
  });

  it('does not touch sessions that are not due, organizer-cancelled or completed', async () => {
    const { communityId, organizerId } = await createPack();
    const notDue = await createTraining(organizerId, communityId);
    const organizerCancelled = await createTraining(organizerId, communityId);
    await cancelTraining(organizerId, organizerCancelled.id);
    await makeDue(organizerCancelled.id);
    const completed = await createTraining(organizerId, communityId);
    await admin.query("update public.training_sessions set status = 'completed', attendance_finalized_at = now() where id = $1", [completed.id]);
    await makeDue(completed.id);
    const before = [await getSession(notDue.id), await getSession(organizerCancelled.id), await getSession(completed.id)];

    expect(await finalize()).toBe(0);

    expect([await getSession(notDue.id), await getSession(organizerCancelled.id), await getSession(completed.id)]).toEqual(before);
    expect(before[1]).toMatchObject({ cancel_reason: 'organizer', decided_at: null });
  });

  it('decides a session whose deadline is exactly now or earlier, and never one in the future', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId);
    await admin.query(
      "update public.training_sessions set rsvp_deadline = now() + interval '30 seconds' where id = $1",
      [session.id],
    );
    expect(await finalize()).toBe(0);

    await admin.query('update public.training_sessions set rsvp_deadline = now() where id = $1', [session.id]);
    expect(await finalize()).toBe(1);
  });

  it('late RSVPs after the decision cannot change it', async () => {
    const { communityId, organizerId, memberIds } = await createPack(3);
    const confirmed = await createTraining(organizerId, communityId, { min_participants: 2 });
    const cancelled = await createTraining(organizerId, communityId, { min_participants: 2 });
    for (const id of memberIds.slice(0, 2)) await setRsvp(id, confirmed.id, 'going');
    await setRsvp(memberIds[0], cancelled.id, 'going');
    await makeDue(confirmed.id);
    await makeDue(cancelled.id);
    await finalize();
    const decided = [await getSession(confirmed.id), await getSession(cancelled.id)];

    // Withdrawing from the confirmed session, or joining the cancelled one, is refused.
    await expect(setRsvp(memberIds[0], confirmed.id, 'not_going')).rejects.toMatchObject(raised('rsvp_closed'));
    await expect(setRsvp(memberIds[1], confirmed.id, 'no_response')).rejects.toMatchObject(raised('rsvp_closed'));
    await expect(setRsvp(memberIds[1], cancelled.id, 'going')).rejects.toMatchObject(raised('rsvp_closed'));
    await expect(setRsvp(memberIds[2], cancelled.id, 'going')).rejects.toMatchObject(raised('rsvp_closed'));
    expect(await finalize()).toBe(0);

    expect([await getSession(confirmed.id), await getSession(cancelled.id)]).toEqual(decided);
    expect(await realGoingCount(confirmed.id)).toBe(2);
    expect(await realGoingCount(cancelled.id)).toBe(1);
  });

  it('two concurrent runs decide each session exactly once', async () => {
    const { communityId, organizerId } = await createPack();
    const sessions = [];
    for (let i = 0; i < 6; i += 1) sessions.push(await createTraining(organizerId, communityId));
    for (const session of sessions) await makeDue(session.id);

    const counts = await Promise.all([finalize(), finalize(), finalize()]);

    expect(counts.reduce((sum, n) => sum + n, 0)).toBe(6);
    expect(await countRows('training_sessions', "status = 'cancelled' and decided_at is not null")).toBe(6);
    expect(await finalize()).toBe(0);
  });

  it('skips a session locked by another transaction and picks it up on the next run', async () => {
    const { communityId, organizerId } = await createPack();
    const locked = await createTraining(organizerId, communityId);
    const free = await createTraining(organizerId, communityId);
    await makeDue(locked.id);
    await makeDue(free.id);

    const gate = await admin.connect();
    try {
      await gate.query('begin');
      await gate.query('select 1 from public.training_sessions where id = $1 for update', [locked.id]);
      // Does not wait for the locked row.
      expect(await finalize()).toBe(1);
      expect((await getSession(free.id)).status).toBe('cancelled');
      expect((await getSession(locked.id)).status).toBe('scheduled');
      await gate.query('commit');
    } finally {
      await gate.query('rollback');
      gate.release();
    }

    expect(await finalize()).toBe(1);
    expect((await getSession(locked.id)).status).toBe('cancelled');
  });

  it('is denied to authenticated users and anon', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId);
    await makeDue(session.id);

    await expect(asUser(organizerId, (db) => rpc(db, 'finalize_due_sessions'))).rejects.toMatchObject(denied);
    await expect(asAnon((db) => rpc(db, 'finalize_due_sessions'))).rejects.toMatchObject(denied);
    expect((await getSession(session.id)).status).toBe('scheduled');
  });
});

describe('going_count safety nets', () => {
  it('a removed member stops counting on scheduled sessions but not on decided ones', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const [leaver, stayer] = memberIds;
    const open = await createTraining(organizerId, communityId, { min_participants: 1 });
    const confirmed = await createTraining(organizerId, communityId, { min_participants: 1 });
    const declined = await createTraining(organizerId, communityId, { min_participants: 1 });
    for (const session of [open, confirmed]) {
      await setRsvp(leaver, session.id, 'going');
      await setRsvp(stayer, session.id, 'going');
    }
    await setRsvp(leaver, declined.id, 'not_going');
    await makeDue(confirmed.id);
    await finalize();

    await admin.query(
      "update public.memberships set status = 'removed' where community_id = $1 and user_id = $2",
      [communityId, leaver],
    );

    expect(await consistentGoingCount(open.id)).toBe(1);
    expect((await rsvpOf(open.id, leaver)).response).toBe('no_response');
    expect((await rsvpOf(open.id, stayer)).response).toBe('going');
    // History of decided sessions is kept.
    expect(await getSession(confirmed.id)).toMatchObject({ status: 'confirmed', going_count: 2 });
    expect((await rsvpOf(confirmed.id, leaver)).response).toBe('going');
    expect((await rsvpOf(declined.id, leaver)).response).toBe('not_going');
    await expect(setRsvp(leaver, open.id, 'going')).rejects.toMatchObject(raised('not_a_member'));
  });

  it('removal frees a place on a full session', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const session = await createTraining(organizerId, communityId, { min_participants: 1, max_participants: 1 });
    await setRsvp(memberIds[0], session.id, 'going');
    await expect(setRsvp(memberIds[1], session.id, 'going')).rejects.toMatchObject(raised('session_full'));

    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [memberIds[0]]);

    expect(await setRsvp(memberIds[1], session.id, 'going')).toMatchObject({ going_count: 1 });
    expect(await consistentGoingCount(session.id)).toBe(1);
  });

  it('removal racing with set_rsvp never leaves a removed member counted', async () => {
    const { communityId, organizerId, memberIds } = await createPack(8);
    const session = await createTraining(organizerId, communityId, { min_participants: 1 });

    await Promise.all(
      memberIds.flatMap((id) => [
        setRsvp(id, session.id, 'going').catch((error: unknown) => {
          expect(error).toMatchObject(raised('not_a_member'));
        }),
        admin.query("update public.memberships set status = 'removed' where user_id = $1", [id]),
      ]),
    );

    expect(await consistentGoingCount(session.id)).toBe(0);
  });

  it('deleting an organizer account keeps their sessions, with organizer_id cleared', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const coOrganizer = await addMember(communityId, { role: 'organizer' });
    const session = await createTraining(organizerId, communityId, { min_participants: 1 });
    await setRsvp(memberIds[0], session.id, 'going');
    await cancelTraining(organizerId, session.id);

    await admin.query('delete from auth.users where id = $1', [organizerId]);

    expect(await getSession(session.id)).toMatchObject({
      organizer_id: null,
      cancelled_by: null,
      status: 'cancelled',
      cancel_reason: 'organizer',
      going_count: 1,
    });
    // New sessions always get an organizer.
    expect((await createTraining(coOrganizer, communityId)).organizer_id).toBe(coOrganizer);
  });

  it('removal after the deadline leaves the count at the deadline for the finalizer', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const due = await createTraining(organizerId, communityId, { min_participants: 2 });
    const open = await createTraining(organizerId, communityId, { min_participants: 2 });
    for (const session of [due, open]) {
      for (const id of memberIds) await setRsvp(id, session.id, 'going');
    }
    await makeDue(due.id);

    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [memberIds[0]]);

    expect(await getSession(due.id)).toMatchObject({ status: 'scheduled', going_count: 2 });
    expect((await rsvpOf(due.id, memberIds[0])).response).toBe('going');
    expect(await consistentGoingCount(open.id)).toBe(1);
    expect(await finalize()).toBe(1);
    expect(await getSession(due.id)).toMatchObject({ status: 'confirmed', going_count: 2 });
  });

  it('deleting a membership row behaves like removal', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const open = await createTraining(organizerId, communityId, { min_participants: 1 });
    const confirmed = await createTraining(organizerId, communityId, { min_participants: 1 });
    for (const session of [open, confirmed]) {
      for (const id of memberIds) await setRsvp(id, session.id, 'going');
    }
    await makeDue(confirmed.id);
    await finalize();

    await admin.query('delete from public.memberships where user_id = $1', [memberIds[0]]);

    expect(await consistentGoingCount(open.id)).toBe(1);
    expect((await rsvpOf(open.id, memberIds[0])).response).toBe('no_response');
    expect(await getSession(confirmed.id)).toMatchObject({ status: 'confirmed', going_count: 2 });
    await expect(setRsvp(memberIds[0], open.id, 'going')).rejects.toMatchObject(raised('not_a_member'));
  });

  it('deleting a user uncounts their going RSVP on decided sessions too, without changing the status', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const session = await createTraining(organizerId, communityId, { min_participants: 2 });
    for (const id of memberIds) await setRsvp(id, session.id, 'going');
    await makeDue(session.id);
    await finalize();

    await admin.query('delete from auth.users where id = $1', [memberIds[0]]);

    expect(await consistentGoingCount(session.id)).toBe(1);
    expect((await getSession(session.id)).status).toBe('confirmed');
  });

  it('deleting a user uncounts their going RSVP on scheduled sessions', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const session = await createTraining(organizerId, communityId, { min_participants: 1 });
    for (const id of memberIds) await setRsvp(id, session.id, 'going');

    await admin.query('delete from auth.users where id = $1', [memberIds[0]]);

    expect(await consistentGoingCount(session.id)).toBe(1);
  });
});
