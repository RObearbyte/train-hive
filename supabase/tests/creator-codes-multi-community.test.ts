import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addMember,
  admin,
  asService,
  asUser,
  closeDb,
  createCommunity,
  createTraining,
  insertInvitation,
  RAISED,
  resetData,
  rpc,
  rpcRow,
  setRsvp,
  trainingInput,
} from './helpers';
import { createWithCode, issueCode, listMyCommunities, updateCommunity } from './creator-codes-helpers';

/**
 * C1 multi-community safety review: one user U is ORGANIZER of A, MEMBER of B and a REMOVED
 * member of C. Every capability must follow the membership of the community it acts on.
 */

const raised = (message: string) => ({ code: RAISED, message });

async function world() {
  const a = await createCommunity('Alpha Pack', 'Europe/Bucharest');
  const b = await createCommunity('Beta Pack', 'Europe/Berlin');
  const c = await createCommunity('Gamma Pack', 'UTC');
  const u = await addMember(a.communityId, { role: 'organizer', name: 'Uma Multi' });
  const organizerA2 = await addMember(a.communityId, { role: 'organizer', name: 'Second Organizer A' });
  const memberA = await addMember(a.communityId, { name: 'Member A' });
  const organizerB = await addMember(b.communityId, { role: 'organizer', name: 'Organizer B' });
  const memberB = await addMember(b.communityId, { name: 'Member B' });
  const organizerC = await addMember(c.communityId, { role: 'organizer', name: 'Organizer C' });
  await admin.query('insert into public.memberships (community_id, user_id, role) values ($1, $2, $3)', [
    b.communityId,
    u,
    'member',
  ]);
  await admin.query('insert into public.memberships (community_id, user_id, role) values ($1, $2, $3)', [
    c.communityId,
    u,
    'member',
  ]);

  // Notifications for U in all three communities, then U is removed from C.
  const sessionA = await createTraining(u, a.communityId);
  const sessionA2 = await createTraining(organizerA2, a.communityId);
  const sessionB = await createTraining(organizerB, b.communityId, { timezone: 'Europe/Berlin' });
  const sessionC = await createTraining(organizerC, c.communityId, { timezone: 'UTC' });
  await admin.query("update public.memberships set status = 'removed' where community_id = $1 and user_id = $2", [
    c.communityId,
    u,
  ]);

  return {
    A: a.communityId,
    B: b.communityId,
    C: c.communityId,
    u,
    organizerA2,
    memberA,
    organizerB,
    memberB,
    organizerC,
    sessionA,
    sessionA2,
    sessionB,
    sessionC,
  };
}

async function ids(userId: string, sql: string, params: unknown[] = []): Promise<string[]> {
  const { rows } = await asUser(userId, (db) => db.query<{ id: string }>(sql, params));
  return rows.map((r) => r.id).sort();
}

const sorted = (...values: string[]) => [...values].sort();

beforeEach(resetData);
afterAll(closeDb);

describe('a user in several communities (organizer of A, member of B, removed from C)', () => {
  it('list_my_communities returns A and B only, with role, zone and join date, and nothing about others', async () => {
    const w = await world();
    const mine = await listMyCommunities(w.u);
    expect(mine.map((m) => [m.name, m.role, m.timezone])).toEqual([
      ['Alpha Pack', 'organizer', 'Europe/Bucharest'],
      ['Beta Pack', 'member', 'Europe/Berlin'],
    ]);
    for (const m of mine) {
      expect(Object.keys(m).sort()).toEqual(['community_id', 'joined_at', 'membership_id', 'name', 'role', 'timezone']);
    }
    const memberships = await admin.query<{ id: string }>(
      "select id from public.memberships where user_id = $1 and status = 'active' order by joined_at",
      [w.u],
    );
    expect(mine.map((m) => m.membership_id)).toEqual(memberships.rows.map((r) => r.id));
    // The plain RLS read the contract documents gives the same picture.
    const rls = await asUser(w.u, (db) =>
      db.query<{ community_id: string; role: string }>(
        "select m.community_id, m.role, c.name from public.memberships m join public.communities c on c.id = m.community_id where m.user_id = $1 and m.status = 'active' order by m.joined_at",
        [w.u],
      ),
    );
    expect(rls.rows.map((r) => r.community_id)).toEqual([w.A, w.B]);
  });

  it('RLS shows A and B data and nothing of C', async () => {
    const w = await world();
    expect(await ids(w.u, 'select id from public.communities')).toEqual(sorted(w.A, w.B));
    const communitiesOfMemberships = await asUser(w.u, (db) =>
      db.query<{ community_id: string }>('select distinct community_id from public.memberships'),
    );
    expect(communitiesOfMemberships.rows.map((r) => r.community_id).sort()).toEqual(sorted(w.A, w.B));
    expect(await ids(w.u, 'select id from public.training_sessions')).toEqual(
      sorted(w.sessionA.id, w.sessionA2.id, w.sessionB.id),
    );
    const profiles = await ids(w.u, 'select id from public.profiles');
    expect(profiles).toContain(w.memberB);
    expect(profiles).not.toContain(w.organizerC);
    // Invitation codes: only those of the community U organizes.
    const codes = await asUser(w.u, (db) => db.query<{ community_id: string }>('select distinct community_id from public.invitation_codes'));
    expect(codes.rows.map((r) => r.community_id)).toEqual([w.A]);
    // Notifications: A and B, never C (one exists, from before the removal).
    const { rows: stored } = await admin.query<{ community_id: string }>(
      'select community_id from public.notifications where user_id = $1',
      [w.u],
    );
    expect(stored.map((r) => r.community_id).sort()).toEqual(sorted(w.A, w.B, w.C));
    const visible = await asUser(w.u, (db) =>
      db.query<{ community_id: string }>('select community_id from public.notifications'),
    );
    expect(visible.rows.map((r) => r.community_id).sort()).toEqual(sorted(w.A, w.B));
  });

  it('helpers answer per community', async () => {
    const w = await world();
    const check = (fn: string, community: string) => asUser(w.u, (db) => rpc<boolean>(db, fn, [community]));
    expect(await check('is_organizer', w.A)).toBe(true);
    expect(await check('is_organizer', w.B)).toBe(false);
    expect(await check('is_organizer', w.C)).toBe(false);
    expect(await check('is_active_member', w.B)).toBe(true);
    expect(await check('is_active_member', w.C)).toBe(false);
  });

  it('organizer capabilities work in A only', async () => {
    const w = await world();
    const forbidden = raised('forbidden');
    const input = JSON.stringify(trainingInput());

    expect(await asUser(w.u, (db) => rpcRow<{ community_id: string }>(db, 'create_training', [w.A, input]))).toMatchObject({
      community_id: w.A,
    });
    for (const community of [w.B, w.C]) {
      await expect(asUser(w.u, (db) => rpcRow(db, 'create_training', [community, input]))).rejects.toMatchObject(forbidden);
      await expect(asUser(w.u, (db) => rpcRow(db, 'create_invitation', [community]))).rejects.toMatchObject(forbidden);
      await expect(updateCommunity(w.u, community, 'Taken', 'UTC')).rejects.toMatchObject(forbidden);
      await expect(
        asUser(w.u, (db) => rpcRow(db, 'create_announcement', [community, 'Hi', 'Body'])),
      ).rejects.toMatchObject(forbidden);
      await expect(
        asUser(w.u, (db) => rpc(db, 'get_community_statistics', [community, '30d'])),
      ).rejects.toMatchObject(forbidden);
      await expect(
        asUser(w.u, (db) => rpc(db, 'list_member_statistics_summary', [community, '30d'])),
      ).rejects.toMatchObject(forbidden);
    }
    expect(await asUser(w.u, (db) => rpcRow<{ community_id: string }>(db, 'create_invitation', [w.A]))).toMatchObject({
      community_id: w.A,
    });
    expect(await updateCommunity(w.u, w.A, 'Alpha Renamed', 'Europe/Bucharest')).toMatchObject({ name: 'Alpha Renamed' });
    expect(await asUser(w.u, (db) => rpcRow<{ community_id: string }>(db, 'create_announcement', [w.A, 'Hi', 'Body']))).toMatchObject({
      community_id: w.A,
    });
    expect(await asUser(w.u, (db) => rpc<{ community_id: string }>(db, 'get_community_statistics', [w.A, '30d']))).toMatchObject({
      community_id: w.A,
    });

    // Organizer actions on B's / C's sessions are refused too.
    for (const session of [w.sessionB, w.sessionC]) {
      await expect(asUser(w.u, (db) => rpcRow(db, 'cancel_training', [session.id]))).rejects.toMatchObject(forbidden);
      await expect(asUser(w.u, (db) => rpc(db, 'get_attendance_sheet', [session.id]))).rejects.toMatchObject(forbidden);
    }
    await expect(
      asUser(w.u, (db) => rpcRow(db, 'update_training', [w.sessionB.id, JSON.stringify(trainingInput({ timezone: 'Europe/Berlin' }))])),
    ).rejects.toMatchObject(forbidden);

    // Member statistics are scoped to the community: B's member is not a member of A.
    expect(await asUser(w.u, (db) => rpc<{ user_id: string }>(db, 'get_member_statistics', [w.A, w.memberA, '30d']))).toBeTruthy();
    await expect(
      asUser(w.u, (db) => rpc(db, 'get_member_statistics', [w.A, w.memberB, '30d'])),
    ).rejects.toMatchObject(raised('not_found'));
    await expect(
      asUser(w.u, (db) => rpc(db, 'get_member_statistics', [w.B, w.memberB, '30d'])),
    ).rejects.toMatchObject(forbidden);
  });

  it('member capabilities work in A and B, not in C', async () => {
    const w = await world();
    expect(await setRsvp(w.u, w.sessionB.id, 'going')).toMatchObject({ response: 'going', going_count: 1 });
    expect(await setRsvp(w.u, w.sessionA2.id, 'going')).toMatchObject({ response: 'going' });
    await expect(setRsvp(w.u, w.sessionC.id, 'going')).rejects.toMatchObject(raised('not_a_member'));

    expect(await asUser(w.u, (db) => rpc(db, 'get_my_statistics', [w.B, '30d']))).toBeTruthy();
    expect(await asUser(w.u, (db) => rpc(db, 'get_my_attendance_history', [w.B, '30d']))).toBeTruthy();
    await expect(asUser(w.u, (db) => rpc(db, 'get_my_statistics', [w.C, '30d']))).rejects.toMatchObject(
      raised('not_a_member'),
    );
    expect(await asUser(w.u, (db) => rpc<number>(db, 'unread_announcement_count', [w.B]))).toBe(0);
    await expect(asUser(w.u, (db) => rpc(db, 'unread_announcement_count', [w.C]))).rejects.toMatchObject(
      raised('not_a_member'),
    );
  });

  it('read state is per community, and the push badge counts only active communities', async () => {
    const w = await world();
    // U's unread: one in A (sessionA2), one in B (sessionB), one in C (hidden: removed).
    expect(await asUser(w.u, (db) => rpc<number>(db, 'mark_all_notifications_read', [w.A]))).toBe(1);
    const unread = await asUser(w.u, (db) =>
      db.query<{ community_id: string }>('select community_id from public.notifications where read_at is null'),
    );
    expect(unread.rows.map((r) => r.community_id)).toEqual([w.B]);
    await expect(
      asUser(w.u, (db) => rpc(db, 'mark_all_notifications_read', [w.C])),
    ).rejects.toMatchObject(raised('not_a_member'));
    const cNotification = await admin.query<{ id: string }>(
      'select id from public.notifications where user_id = $1 and community_id = $2',
      [w.u, w.C],
    );
    await expect(
      asUser(w.u, (db) => rpcRow(db, 'mark_notification_read', [cNotification.rows[0].id])),
    ).rejects.toMatchObject(raised('not_found'));

    const jobs = await asService((db) =>
      db.query<{ j: { user_id: string; community_id: string; unread_count: number; skip_reason: string | null } }>(
        "select j from public.claim_notification_jobs(100, 'multi-test') as j",
      ),
    );
    const mine = jobs.rows.map((r) => r.j).filter((j) => j.user_id === w.u);
    expect(mine.length).toBeGreaterThan(0);
    // Unread now: B only (A was marked read, C does not count).
    for (const job of mine) expect(job.unread_count).toBe(1);
    expect(mine.find((j) => j.community_id === w.C)?.skip_reason).toBe('not_a_member');
  });

  it('redeeming invitations is scoped to the invitation community', async () => {
    const w = await world();
    await insertInvitation(w.B, 'BETA2222');
    await insertInvitation(w.C, 'GAMA2222');
    const d = await createCommunity('Delta Pack', 'UTC');
    await insertInvitation(d.communityId, 'DXTA2222');
    const redeem = (code: string) =>
      asUser(w.u, (db) => rpc<{ ok: boolean; error?: string; role?: string; already_member?: boolean; community_id?: string }>(db, 'redeem_invitation', [code, 'Uma Multi']));

    // Already a member of B: no upgrade, no second membership.
    expect(await redeem('BETA2222')).toMatchObject({ ok: true, community_id: w.B, role: 'member', already_member: true });
    // Removed from C: cannot rejoin by code.
    expect(await redeem('GAMA2222')).toEqual({ ok: false, error: 'invalid_code' });
    // A new community joins alongside the others.
    expect(await redeem('DXTA2222')).toMatchObject({ ok: true, community_id: d.communityId, already_member: false });

    // And a creator code adds a community U organizes.
    const { code } = await issueCode();
    const created = await createWithCode(w.u, code, { name: 'Epsilon Pack', timezone: 'UTC', displayName: 'Uma Multi' });
    expect(created).toMatchObject({ ok: true });

    const mine = await listMyCommunities(w.u);
    expect(mine.map((m) => [m.name, m.role])).toEqual([
      ['Alpha Pack', 'organizer'],
      ['Beta Pack', 'member'],
      ['Delta Pack', 'member'],
      ['Epsilon Pack', 'organizer'],
    ]);
    const roles = await admin.query<{ community_id: string; role: string; status: string }>(
      'select community_id, role, status from public.memberships where user_id = $1',
      [w.u],
    );
    expect(roles.rows.find((r) => r.community_id === w.C)).toMatchObject({ status: 'removed' });
    expect(roles.rows.find((r) => r.community_id === w.A)).toMatchObject({ role: 'organizer', status: 'active' });

    // Organizing E gives nothing in B.
    await expect(
      asUser(w.u, (db) => rpcRow(db, 'create_invitation', [w.B])),
    ).rejects.toMatchObject(raised('forbidden'));
    // Other members of A see U, but not U's other communities.
    const seenByMemberA = await asUser(w.memberA, (db) => db.query<{ id: string }>('select id from public.communities'));
    expect(seenByMemberA.rows.map((r) => r.id)).toEqual([w.A]);
  });
});
