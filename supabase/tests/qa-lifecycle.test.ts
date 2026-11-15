import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  admin,
  asService,
  asUser,
  closeDb,
  countRows,
  createPack,
  createTraining,
  finalize,
  getSession,
  makeDue,
  realGoingCount,
  resetData,
  rpcRow,
  setRsvp,
  trainingInput,
} from './helpers';

/**
 * QA (M1-Q1): paths that bypass the RPCs (member removal, user deletion, admin deletes) and
 * what they do to counts and to the deadline decision.
 */

beforeEach(resetData);
afterAll(closeDb);

describe('QA deletion and removal paths', () => {
  it('deleting a community removes its sessions and RSVPs without tripping the count trigger', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const other = await createPack(1);
    const session = await createTraining(organizerId, communityId, { min_participants: 1 });
    const kept = await createTraining(other.organizerId, other.communityId, { min_participants: 1 });
    for (const id of memberIds) await setRsvp(id, session.id, 'going');
    await setRsvp(other.memberIds[0], kept.id, 'going');

    await asService((db) => db.query('delete from public.communities where id = $1', [communityId]));

    expect(await countRows('training_sessions', 'community_id = $1', [communityId])).toBe(0);
    expect(await countRows('training_rsvps', 'community_id = $1', [communityId])).toBe(0);
    expect(await countRows('memberships', 'community_id = $1', [communityId])).toBe(0);
    expect(await getSession(kept.id)).toMatchObject({ going_count: 1 });
    expect(await realGoingCount(kept.id)).toBe(1);
  });

  it('deleting a member with RSVPs on several open sessions keeps every count exact', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const sessions = [];
    for (let i = 0; i < 3; i += 1) sessions.push(await createTraining(organizerId, communityId, { min_participants: 1 }));
    for (const session of sessions) for (const id of memberIds) await setRsvp(id, session.id, 'going');
    await setRsvp(memberIds[0], sessions[2].id, 'not_going');

    await admin.query('delete from auth.users where id = $1', [memberIds[0]]);

    for (const session of sessions) {
      expect(await getSession(session.id)).toMatchObject({ going_count: 1 });
      expect(await realGoingCount(session.id)).toBe(1);
    }
  });

  // DEFECT Q1-2 (low): training_sessions.organizer_id references profiles with no ON DELETE
  // action, so the account of anyone who ever created a training cannot be deleted.
  it.fails('DEFECT Q1-2: the account of a user who created a training can be deleted', async () => {
    const { communityId, organizerId } = await createPack();
    await createTraining(organizerId, communityId);

    // Actual: 23503 foreign key violation "training_sessions_organizer_id_fkey".
    await admin.query('delete from auth.users where id = $1', [organizerId]);

    expect(await countRows('profiles', 'id = $1', [organizerId])).toBe(0);
  });

  // DEFECT Q1-3 (low): between the deadline and the finalizer run (up to a minute with pg_cron,
  // longer if the job is late) removing a member still changes going_count, so the decision is
  // not taken from the count at the deadline.
  it.fails('DEFECT Q1-3: the decision uses the count at the deadline, even if a member is removed before the finalizer runs', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const session = await createTraining(organizerId, communityId, { min_participants: 2 });
    for (const id of memberIds) await setRsvp(id, session.id, 'going');
    await makeDue(session.id);

    // The deadline has passed with 2 going (minimum reached). RSVPs are closed for everyone.
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [memberIds[0]]);
    await finalize();

    // Actual: cancelled / insufficient_participation with going_count 1.
    expect(await getSession(session.id)).toMatchObject({ status: 'confirmed', going_count: 2 });
  });

  // DEFECT Q1-4 (low): the safety nets cover "membership set to removed" and "RSVP row deleted",
  // but not every path. Two paths leave going_count different from the real state.
  it.fails('DEFECT Q1-4a: deleting a user keeps going_count equal to the going rows on decided sessions too', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const session = await createTraining(organizerId, communityId, { min_participants: 2 });
    for (const id of memberIds) await setRsvp(id, session.id, 'going');
    await makeDue(session.id);
    await finalize();

    await admin.query('delete from auth.users where id = $1', [memberIds[0]]);

    // Actual: going_count stays 2 while only 1 going row is left (the participant list and
    // the count shown for a confirmed session disagree).
    expect((await getSession(session.id)).going_count).toBe(await realGoingCount(session.id));
  });

  it.fails('DEFECT Q1-4b: deleting a membership row does not leave a non-member counted as going', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const session = await createTraining(organizerId, communityId, { min_participants: 1 });
    await setRsvp(memberIds[0], session.id, 'going');

    // An admin (service_role) deletes the membership instead of setting status = 'removed'.
    await asService((db) => db.query('delete from public.memberships where user_id = $1', [memberIds[0]]));

    // Actual: the RSVP stays `going` and still counts; the session can be confirmed by someone
    // who is no longer a member.
    expect(await getSession(session.id)).toMatchObject({ going_count: 0 });
  });
});

describe('QA non-idempotent operations', () => {
  // OBSERVATION Q1-O1: create_training has no idempotency key. A client retry after a lost
  // response creates a duplicate. Documented here so that a future change is deliberate.
  it('create_training called twice with the same input creates two sessions', async () => {
    const { communityId, organizerId } = await createPack();
    const input = JSON.stringify(trainingInput());

    const [first, second] = await Promise.all([
      asUser(organizerId, (db) => rpcRow<{ id: string }>(db, 'create_training', [communityId, input])),
      asUser(organizerId, (db) => rpcRow<{ id: string }>(db, 'create_training', [communityId, input])),
    ]);

    expect(first.id).not.toBe(second.id);
    expect(await countRows('training_sessions', 'community_id = $1', [communityId])).toBe(2);
  });

  it('cancel_training, revoke_invitation and set_rsvp are idempotent under concurrent duplicates', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const session = await createTraining(organizerId, communityId, { min_participants: 1 });
    const invitation = await asUser(organizerId, (db) => rpcRow<{ id: string }>(db, 'create_invitation', [communityId]));

    const rsvps = await Promise.all(Array.from({ length: 6 }, () => setRsvp(memberIds[0], session.id, 'going')));
    expect(rsvps.map((r) => r.going_count)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(await countRows('training_rsvps', 'session_id = $1', [session.id])).toBe(1);

    const revokes = await Promise.all(
      Array.from({ length: 4 }, () =>
        asUser(organizerId, (db) => rpcRow<{ revoked_at: Date }>(db, 'revoke_invitation', [invitation.id])),
      ),
    );
    expect(new Set(revokes.map((r) => r.revoked_at.getTime())).size).toBe(1);

    const cancels = await Promise.all(
      Array.from({ length: 4 }, () =>
        asUser(organizerId, (db) => rpcRow<{ cancelled_at: Date; status: string }>(db, 'cancel_training', [session.id])),
      ),
    );
    expect(new Set(cancels.map((c) => c.cancelled_at.getTime())).size).toBe(1);
    expect(await getSession(session.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'organizer', going_count: 1 });
  });
});
