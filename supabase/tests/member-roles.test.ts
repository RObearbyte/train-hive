import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  goingCountMismatches,
  leaveCommunity,
  packWithTwoOrganizers,
  removeMember,
  setMemberRole,
} from './account-deletion-helpers';
import { confirmedSession, recordAttendance } from './attendance-helpers';
import { asNobody, openUserTransaction } from './creator-codes-helpers';
import {
  addMember,
  admin,
  asAnon,
  asService,
  asUser,
  closeDb,
  countRows,
  createPack,
  createTraining,
  createUser,
  getSession,
  INSUFFICIENT_PRIVILEGE,
  insertInvitation,
  resetData,
  rpc,
  setRsvp,
} from './helpers';
import { errorKey, waitForBlocked } from './qa-helpers';

/**
 * GDPR G2 organizer tools: set_member_role, remove_member, leave_community. The invariant they
 * share with account deletion: a community with active members always keeps an active organizer,
 * also under concurrency.
 */

beforeEach(resetData);
afterAll(closeDb);

async function membership(communityId: string, userId: string) {
  const { rows } = await admin.query<{ role: string; status: string }>(
    'select role, status from public.memberships where community_id = $1 and user_id = $2',
    [communityId, userId],
  );
  return rows[0];
}

async function activeOrganizers(communityId: string): Promise<number> {
  return countRows('memberships', "community_id = $1 and status = 'active' and role = 'organizer'", [communityId]);
}

/** A community with an organizer, a second member, an outsider pack, a removed organizer. */
async function world() {
  const pack = await createPack(2);
  const other = await createPack(0);
  const outsider = await createUser();
  const removedOrganizer = await addMember(pack.communityId, { role: 'organizer', status: 'removed', name: 'Gone Organizer' });
  return {
    communityId: pack.communityId,
    organizerId: pack.organizerId,
    target: pack.memberIds[0],
    otherMember: pack.memberIds[1],
    otherOrganizer: other.organizerId,
    outsider,
    removedOrganizer,
  };
}

describe('set_member_role and remove_member: who may call them', () => {
  it('only an active organizer of the community; everybody else is refused and nothing changes', async () => {
    const w = await world();
    const callers: [string, string][] = [
      ['target themself', w.target],
      ['another member', w.otherMember],
      ['outsider', w.outsider],
      ['organizer of another community', w.otherOrganizer],
      ['removed organizer', w.removedOrganizer],
    ];
    for (const [label, caller] of callers) {
      await expect(setMemberRole(caller, w.communityId, w.target, 'organizer').catch(errorKey), label).resolves.toBe(
        'P0001:forbidden',
      );
      await expect(removeMember(caller, w.communityId, w.target).catch(errorKey), label).resolves.toBe(
        'P0001:forbidden',
      );
    }
    // Unknown community: same answer as a foreign one.
    await expect(
      setMemberRole(w.organizerId, '00000000-0000-0000-0000-000000000000', w.target, 'organizer').catch(errorKey),
    ).resolves.toBe('P0001:forbidden');
    await expect(setMemberRole(w.organizerId, null, w.target, 'organizer').catch(errorKey)).resolves.toBe(
      'P0001:forbidden',
    );
    // No user in the JWT.
    await expect(
      asNobody((db) => db.query('select public.set_member_role($1, $2, $3)', [w.communityId, w.target, 'organizer'])).catch(
        errorKey,
      ),
    ).resolves.toBe('P0001:not_authenticated');
    await expect(
      asNobody((db) => db.query('select public.remove_member($1, $2)', [w.communityId, w.target])).catch(errorKey),
    ).resolves.toBe('P0001:not_authenticated');
    await expect(
      asNobody((db) => db.query('select public.leave_community($1)', [w.communityId])).catch(errorKey),
    ).resolves.toBe('P0001:not_authenticated');
    // anon and service_role cannot execute them at all.
    for (const sql of [
      ['select public.set_member_role($1, $2, $3)', [w.communityId, w.target, 'organizer']],
      ['select public.remove_member($1, $2)', [w.communityId, w.target]],
      ['select public.leave_community($1)', [w.communityId]],
    ] as [string, unknown[]][]) {
      await expect(asAnon((db) => db.query(sql[0], sql[1])).catch((e: { code: string }) => e.code)).resolves.toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      await expect(asService((db) => db.query(sql[0], sql[1])).catch((e: { code: string }) => e.code)).resolves.toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    }
    expect(await membership(w.communityId, w.target)).toEqual({ role: 'member', status: 'active' });
  });
});

describe('set_member_role', () => {
  it('promotes and demotes another active member; the same role again changes nothing', async () => {
    const w = await world();
    const promoted = await setMemberRole(w.organizerId, w.communityId, w.target, 'organizer');
    expect(promoted).toMatchObject({ user_id: w.target, role: 'organizer', status: 'active' });
    const again = await setMemberRole(w.organizerId, w.communityId, w.target, 'organizer');
    expect(again).toEqual(promoted);
    // The new organizer can act as one.
    await expect(asUser(w.target, (db) => rpc<boolean>(db, 'is_organizer', [w.communityId]))).resolves.toBe(true);
    // And demote the original organizer (there is still one left).
    await setMemberRole(w.target, w.communityId, w.organizerId, 'member');
    expect(await membership(w.communityId, w.organizerId)).toEqual({ role: 'member', status: 'active' });
    expect(await activeOrganizers(w.communityId)).toBe(1);
  });

  it('refuses invalid input, oneself, and targets that are not active members here', async () => {
    const w = await world();
    const foreign = await addMember((await createPack(0)).communityId);
    await expect(setMemberRole(w.organizerId, w.communityId, null, 'organizer').catch(errorKey)).resolves.toBe(
      'P0001:validation_failed:user_id',
    );
    await expect(setMemberRole(w.organizerId, w.communityId, w.target, null).catch(errorKey)).resolves.toBe(
      'P0001:validation_failed:role',
    );
    await expect(setMemberRole(w.organizerId, w.communityId, w.organizerId, 'member').catch(errorKey)).resolves.toBe(
      'P0001:cannot_change_own_role',
    );
    for (const target of [w.outsider, foreign, w.removedOrganizer, '00000000-0000-0000-0000-000000000000']) {
      await expect(setMemberRole(w.organizerId, w.communityId, target, 'organizer').catch(errorKey)).resolves.toBe(
        'P0001:not_found',
      );
    }
    expect(await membership(w.communityId, w.removedOrganizer)).toEqual({ role: 'organizer', status: 'removed' });
  });
});

describe('remove_member', () => {
  it('removes another member: open RSVPs released, history kept, no rejoining, idempotent', async () => {
    const { communityId, organizerId, memberIds, session: past } = await confirmedSession(2, 2);
    await recordAttendance(organizerId, past.id, memberIds[0], 'present');
    const open = await createTraining(organizerId, communityId);
    await setRsvp(memberIds[0], open.id, 'going');
    expect((await getSession(open.id)).going_count).toBe(1);

    const removed = await removeMember(organizerId, communityId, memberIds[0]);
    expect(removed).toMatchObject({ user_id: memberIds[0], status: 'removed', role: 'member' });
    expect(await removeMember(organizerId, communityId, memberIds[0])).toEqual(removed);

    expect((await getSession(open.id)).going_count).toBe(0);
    expect(await goingCountMismatches()).toEqual([]);
    expect(await countRows('attendance_records', 'user_id = $1', [memberIds[0]])).toBe(1);
    await expect(asUser(memberIds[0], (db) => rpc<boolean>(db, 'is_active_member', [communityId]))).resolves.toBe(false);

    const code = await insertInvitation(communityId, 'RJ2345AB');
    const rejoin = await asUser(memberIds[0], (db) =>
      rpc<{ ok: boolean; error?: string }>(db, 'redeem_invitation', [code.code, 'Back Again']),
    );
    expect(rejoin).toEqual({ ok: false, error: 'invalid_code' });
  });

  it('can remove a co-organizer, never oneself; unknown targets are not_found', async () => {
    const pack = await packWithTwoOrganizers(1);
    await expect(removeMember(pack.organizerId, pack.communityId, pack.organizerId).catch(errorKey)).resolves.toBe(
      'P0001:cannot_remove_self',
    );
    await expect(removeMember(pack.organizerId, pack.communityId, null).catch(errorKey)).resolves.toBe(
      'P0001:validation_failed:user_id',
    );
    await expect(removeMember(pack.organizerId, pack.communityId, await createUser()).catch(errorKey)).resolves.toBe(
      'P0001:not_found',
    );
    await removeMember(pack.organizerId, pack.communityId, pack.secondOrganizerId);
    expect(await membership(pack.communityId, pack.secondOrganizerId)).toEqual({ role: 'organizer', status: 'removed' });
    expect(await activeOrganizers(pack.communityId)).toBe(1);
    // The removed organizer has lost every organizer right.
    await expect(removeMember(pack.secondOrganizerId, pack.communityId, pack.memberIds[0]).catch(errorKey)).resolves.toBe(
      'P0001:forbidden',
    );
  });
});

describe('leave_community', () => {
  it('a member leaves (RSVPs on open sessions released); a second call changes nothing', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const open = await createTraining(organizerId, communityId);
    await setRsvp(memberIds[0], open.id, 'going');

    const left = await leaveCommunity(memberIds[0], communityId);
    expect(left).toMatchObject({ community_id: communityId, status: 'removed', changed: true, invitations_revoked: 0 });
    expect((await getSession(open.id)).going_count).toBe(0);
    expect(await leaveCommunity(memberIds[0], communityId)).toMatchObject({ changed: false });
    await expect(setRsvp(memberIds[0], open.id, 'going').catch(errorKey)).resolves.toBe('P0001:not_a_member');
  });

  it('the last organizer cannot leave while others remain; with a co-organizer they can', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    await expect(leaveCommunity(organizerId, communityId).catch(errorKey)).resolves.toBe('P0001:last_organizer');
    expect(await membership(communityId, organizerId)).toEqual({ role: 'organizer', status: 'active' });

    await setMemberRole(organizerId, communityId, memberIds[0], 'organizer');
    await expect(leaveCommunity(organizerId, communityId)).resolves.toMatchObject({ changed: true });
    expect(await activeOrganizers(communityId)).toBe(1);
  });

  it('the last member leaves: the community is left with nobody, so its open codes are revoked', async () => {
    const { communityId, organizerId } = await createPack(0);
    await insertInvitation(communityId, 'KV2345AB');
    await insertInvitation(communityId, 'KV2345AC', { revoked: true });
    const result = await leaveCommunity(organizerId, communityId);
    // createPack's bootstrap code + KV2345AB.
    expect(result).toMatchObject({ changed: true, invitations_revoked: 2 });
    expect(await countRows('invitation_codes', 'community_id = $1 and revoked_at is null', [communityId])).toBe(0);
    const stranger = await createUser();
    const join = await asUser(stranger, (db) => rpc<{ ok: boolean; error?: string }>(db, 'redeem_invitation', ['KV2345AB', 'Late']));
    expect(join).toEqual({ ok: false, error: 'revoked' });
  });

  it('outsiders, unknown communities and users without a profile are not_a_member', async () => {
    const { communityId } = await createPack(0);
    const outsider = await addMember((await createPack(0)).communityId);
    await expect(leaveCommunity(outsider, communityId).catch(errorKey)).resolves.toBe('P0001:not_a_member');
    await expect(leaveCommunity(outsider, null).catch(errorKey)).resolves.toBe('P0001:not_a_member');
    await expect(leaveCommunity(await createUser(), communityId).catch(errorKey)).resolves.toBe('P0001:not_a_member');
  });
});

describe('concurrency: never zero organizers', () => {
  it('two organizers demoting each other at the same time: exactly one wins, every round', async () => {
    for (let round = 0; round < 8; round += 1) {
      const pack = await packWithTwoOrganizers(1);
      const results = await Promise.all([
        setMemberRole(pack.organizerId, pack.communityId, pack.secondOrganizerId, 'member').then(() => 'ok', errorKey),
        setMemberRole(pack.secondOrganizerId, pack.communityId, pack.organizerId, 'member').then(() => 'ok', errorKey),
      ]);
      expect(results.sort()).toEqual(['P0001:forbidden', 'ok']);
      expect(await activeOrganizers(pack.communityId)).toBe(1);
    }
  });

  it('a demotion waiting for the role lock re-checks the caller after it (deterministic order)', async () => {
    const pack = await packWithTwoOrganizers(1);
    const first = await openUserTransaction(pack.organizerId);
    await first.db.query('select public.set_member_role($1, $2, $3)', [pack.communityId, pack.secondOrganizerId, 'member']);
    const second = setMemberRole(pack.secondOrganizerId, pack.communityId, pack.organizerId, 'member').then(
      () => 'ok',
      errorKey,
    );
    await waitForBlocked('set_member_role');
    await first.finish(true);
    await expect(second).resolves.toBe('P0001:forbidden');
    expect(await activeOrganizers(pack.communityId)).toBe(1);
  });

  it('mixed storm of demotions, removals and departures keeps an organizer in every community', async () => {
    for (let round = 0; round < 5; round += 1) {
      const pack = await packWithTwoOrganizers(2);
      const third = await addMember(pack.communityId, { role: 'organizer', name: 'Third Organizer' });
      const orgs = [pack.organizerId, pack.secondOrganizerId, third];
      const ops: Promise<string>[] = [];
      for (const caller of orgs) {
        ops.push(leaveCommunity(caller, pack.communityId).then(() => 'ok', errorKey));
        for (const target of orgs.filter((o) => o !== caller)) {
          ops.push(setMemberRole(caller, pack.communityId, target, 'member').then(() => 'ok', errorKey));
          ops.push(removeMember(caller, pack.communityId, target).then(() => 'ok', errorKey));
        }
      }
      const results = await Promise.all(ops);
      const unexpected = results.filter(
        (r) => !['ok', 'P0001:forbidden', 'P0001:last_organizer', 'P0001:not_found', 'P0001:not_a_member'].includes(r),
      );
      expect(unexpected).toEqual([]);
      expect(await activeOrganizers(pack.communityId)).toBeGreaterThanOrEqual(1);
      expect(await goingCountMismatches()).toEqual([]);
    }
  });
});
