import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addMember,
  admin,
  asUser,
  cancelTraining,
  closeDb,
  createPack,
  createTraining,
  getSession,
  insertInvitation,
  realGoingCount,
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
 * QA (M1-Q1): authorization holes. Role is per community, removal is immediate, and no input
 * can move data across communities.
 */

const TABLES = [
  'communities',
  'memberships',
  'invitation_codes',
  'invitation_redemptions',
  'training_sessions',
  'training_rsvps',
];

async function visibleRows(userId: string, table: string): Promise<number> {
  return asUser(userId, async (db) => {
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`);
    return rows[0].n;
  });
}

beforeEach(resetData);
afterAll(closeDb);

describe('QA role is per community', () => {
  /** `dual` is a plain member of A and the organizer of B. */
  async function arrange() {
    const a = await createPack(1);
    const b = await createPack(1);
    const dual = b.organizerId;
    await admin.query(
      "insert into public.memberships (community_id, user_id, role) values ($1, $2, 'member')",
      [a.communityId, dual],
    );
    const sessionA = await createTraining(a.organizerId, a.communityId);
    const sessionB = await createTraining(dual, b.communityId);
    const invitationA = await insertInvitation(a.communityId, 'AAAAAA22');
    const invitationB = await insertInvitation(b.communityId, 'BBBBBB22');
    return { a, b, dual, sessionA, sessionB, invitationA, invitationB };
  }

  it('an organizer of B who is a member of A cannot act as organizer in A', async () => {
    const { a, dual, sessionA, invitationA } = await arrange();
    const forbidden = raised('forbidden');

    await expect(
      asUser(dual, (db) => rpcRow(db, 'create_training', [a.communityId, JSON.stringify(trainingInput())])),
    ).rejects.toMatchObject(forbidden);
    await expect(updateTraining(dual, sessionA.id, formOf(sessionA, { title: 'Hijacked' }))).rejects.toMatchObject(forbidden);
    await expect(cancelTraining(dual, sessionA.id)).rejects.toMatchObject(forbidden);
    await expect(asUser(dual, (db) => rpcRow(db, 'create_invitation', [a.communityId]))).rejects.toMatchObject(forbidden);
    await expect(asUser(dual, (db) => rpcRow(db, 'revoke_invitation', [invitationA.id]))).rejects.toMatchObject(forbidden);

    expect(await getSession(sessionA.id)).toMatchObject({ title: sessionA.title, status: 'scheduled' });
    const { rows } = await admin.query('select revoked_at from public.invitation_codes where id = $1', [invitationA.id]);
    expect(rows[0].revoked_at).toBeNull();
  });

  it('the same user keeps member rights in A and organizer rights in B', async () => {
    const { a, b, dual, sessionA, sessionB, invitationB } = await arrange();

    expect(await asUser(dual, (db) => rpc<boolean>(db, 'is_organizer', [a.communityId]))).toBe(false);
    expect(await asUser(dual, (db) => rpc<boolean>(db, 'is_organizer', [b.communityId]))).toBe(true);
    expect(await setRsvp(dual, sessionA.id, 'going')).toMatchObject({ going_count: 1 });
    expect((await updateTraining(dual, sessionB.id, formOf(sessionB, { title: 'Mine' }))).title).toBe('Mine');

    // Organizer-only tables show B's rows only.
    const codes = await asUser(dual, (db) => db.query<{ id: string }>('select id from public.invitation_codes'));
    expect(codes.rows.map((row) => row.id)).toContain(invitationB.id);
    const { rows } = await asUser(dual, (db) =>
      db.query<{ community_id: string }>('select distinct community_id from public.invitation_codes'),
    );
    expect(rows).toEqual([{ community_id: b.communityId }]);
  });

  it('input cannot move a session to another community or change who organizes it', async () => {
    const { a, b, dual, sessionB } = await arrange();

    const updated = await updateTraining(
      dual,
      sessionB.id,
      formOf(sessionB, {
        id: '00000000-0000-4000-8000-000000000001',
        community_id: a.communityId,
        organizer_id: a.organizerId,
        going_count: 50,
        status: 'confirmed',
        decided_at: new Date().toISOString(),
        cancel_reason: 'organizer',
      }),
    );

    expect(updated).toMatchObject({
      id: sessionB.id,
      community_id: b.communityId,
      organizer_id: dual,
      going_count: 0,
      status: 'scheduled',
      decided_at: null,
      cancel_reason: null,
    });
    const created = await asUser(dual, (db) =>
      rpcRow<Session>(db, 'create_training', [
        b.communityId,
        JSON.stringify(trainingInput({ community_id: a.communityId, organizer_id: a.organizerId })),
      ]),
    );
    expect(created).toMatchObject({ community_id: b.communityId, organizer_id: dual });
  });

  it('a member of A cannot RSVP to, or read, a session of B by knowing its id', async () => {
    const { a, sessionB } = await arrange();
    const memberOfA = a.memberIds[0];

    await expect(setRsvp(memberOfA, sessionB.id, 'going')).rejects.toMatchObject(raised('not_a_member'));
    const { rows } = await asUser(memberOfA, (db) =>
      db.query('select id from public.training_sessions where id = $1', [sessionB.id]),
    );
    expect(rows).toEqual([]);
    expect(await realGoingCount(sessionB.id)).toBe(0);
  });

  it('training_rsvps.community_id cannot disagree with the session (RLS key integrity)', async () => {
    const { a, sessionB } = await arrange();
    // Even a privileged writer cannot file an RSVP of B's session under community A, which is
    // what the RSVP select policy keys on.
    await expect(
      admin.query(
        "insert into public.training_rsvps (session_id, community_id, user_id, response) values ($1, $2, $3, 'going')",
        [sessionB.id, a.communityId, a.memberIds[0]],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('QA removed members', () => {
  it('a removed member reads nothing and cannot RSVP', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const [removed, stayer] = memberIds;
    const session = await createTraining(organizerId, communityId, { min_participants: 1 });
    await setRsvp(removed, session.id, 'going');
    await setRsvp(stayer, session.id, 'going');
    for (const table of TABLES.filter((t) => !t.startsWith('invitation'))) {
      expect(await visibleRows(removed, table), `${table} before removal`).toBeGreaterThan(0);
    }

    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [removed]);

    for (const table of TABLES) expect(await visibleRows(removed, table), table).toBe(0);
    // Only their own profile stays visible.
    const profiles = await asUser(removed, (db) => db.query<{ id: string }>('select id from public.profiles'));
    expect(profiles.rows).toEqual([{ id: removed }]);
    expect(await asUser(removed, (db) => rpc<boolean>(db, 'is_active_member', [communityId]))).toBe(false);
    for (const response of ['going', 'not_going', 'no_response'] as const) {
      await expect(setRsvp(removed, session.id, response)).rejects.toMatchObject(raised('not_a_member'));
    }
    expect(await getSession(session.id)).toMatchObject({ going_count: 1 });
    expect(await realGoingCount(session.id)).toBe(1);
    // The remaining member no longer sees the removed member's profile.
    const seen = await asUser(stayer, (db) => db.query('select id from public.profiles where id = $1', [removed]));
    expect(seen.rows).toEqual([]);
  });

  it('a removed organizer loses every organizer operation', async () => {
    const { communityId, organizerId } = await createPack();
    const second = await addMember(communityId, { role: 'organizer', name: 'Second Organizer' });
    const session = await createTraining(organizerId, communityId);
    const invitation = await insertInvitation(communityId, 'AAAAAA22');
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [organizerId]);
    const forbidden = raised('forbidden');

    await expect(updateTraining(organizerId, session.id, formOf(session, { title: 'Still mine?' }))).rejects.toMatchObject(forbidden);
    await expect(cancelTraining(organizerId, session.id)).rejects.toMatchObject(forbidden);
    await expect(
      asUser(organizerId, (db) => rpcRow(db, 'create_training', [communityId, JSON.stringify(trainingInput())])),
    ).rejects.toMatchObject(forbidden);
    await expect(asUser(organizerId, (db) => rpcRow(db, 'create_invitation', [communityId]))).rejects.toMatchObject(forbidden);
    await expect(asUser(organizerId, (db) => rpcRow(db, 'revoke_invitation', [invitation.id]))).rejects.toMatchObject(forbidden);

    // The session they created stays manageable by the remaining organizer.
    expect((await cancelTraining(second, session.id)).status).toBe('cancelled');
  });

  it('removal from one community leaves the RSVPs in another community untouched', async () => {
    const a = await createPack(1);
    const b = await createPack();
    const user = a.memberIds[0];
    await admin.query("insert into public.memberships (community_id, user_id) values ($1, $2)", [b.communityId, user]);
    const sessionA = await createTraining(a.organizerId, a.communityId, { min_participants: 1 });
    const sessionB = await createTraining(b.organizerId, b.communityId, { min_participants: 1 });
    await setRsvp(user, sessionA.id, 'going');
    await setRsvp(user, sessionB.id, 'going');

    await admin.query(
      "update public.memberships set status = 'removed' where user_id = $1 and community_id = $2",
      [user, a.communityId],
    );

    expect(await getSession(sessionA.id)).toMatchObject({ going_count: 0 });
    expect(await realGoingCount(sessionA.id)).toBe(0);
    expect(await getSession(sessionB.id)).toMatchObject({ going_count: 1 });
    expect(await realGoingCount(sessionB.id)).toBe(1);
    expect(await setRsvp(user, sessionB.id, 'not_going')).toMatchObject({ going_count: 0 });
  });

  it('a re-activated member starts from a clean RSVP and counts again', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const session = await createTraining(organizerId, communityId, { min_participants: 1, max_participants: 1 });
    await setRsvp(memberIds[0], session.id, 'going');
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [memberIds[0]]);
    await admin.query("update public.memberships set status = 'active' where user_id = $1", [memberIds[0]]);

    expect(await getSession(session.id)).toMatchObject({ going_count: 0 });
    expect(await setRsvp(memberIds[0], session.id, 'going')).toMatchObject({ going_count: 1 });
    expect(await realGoingCount(session.id)).toBe(1);
  });
});
