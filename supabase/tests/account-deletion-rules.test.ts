import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { confirmedSession, recordAttendance, finalizeAttendance } from './attendance-helpers';
import {
  deleteMyAccount,
  myDeletionBlockers,
  packWithTwoOrganizers,
  referencesTo,
  removeMember,
  setMemberRole,
} from './account-deletion-helpers';
import { asNobody } from './creator-codes-helpers';
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
  INSUFFICIENT_PRIVILEGE,
  resetData,
  setRsvp,
} from './helpers';
import { createAnnouncement } from './notifications-helpers';
import { errorKey } from './qa-helpers';

/**
 * GDPR G2: the rules around delete_my_account. The last organizer of a community that still has
 * members is refused (with the list of communities); a community where the user is the last active
 * member is deleted with them; members, users without a profile and organizers with a co-organizer
 * can delete; only `authenticated` can call it.
 */

beforeEach(resetData);
afterAll(closeDb);

interface PgError {
  code?: string;
  message?: string;
  detail?: string;
}

async function deletionError(userId: string): Promise<PgError> {
  try {
    await deleteMyAccount(userId);
  } catch (error) {
    return error as PgError;
  }
  throw new Error('delete_my_account succeeded');
}

describe('last organizer', () => {
  it('is refused while other active members remain, with the communities in the error detail', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    await admin.query("update public.communities set name = 'Lonely Leader' where id = $1", [communityId]);
    const before = await referencesTo(organizerId);

    const error = await deletionError(organizerId);
    expect(error.code).toBe('P0001');
    expect(error.message).toBe('last_organizer');
    expect(JSON.parse(error.detail!)).toEqual({
      communities: [{ community_id: communityId, name: 'Lonely Leader', active_members: 3 }],
    });
    // Nothing happened.
    expect(await referencesTo(organizerId)).toEqual(before);

    expect(await myDeletionBlockers(organizerId)).toEqual({
      can_delete: false,
      last_organizer: [{ community_id: communityId, name: 'Lonely Leader', active_members: 3 }],
      deleted_with_account: [],
    });

    // Hand over, then it works.
    await setMemberRole(organizerId, communityId, memberIds[0], 'organizer');
    expect((await myDeletionBlockers(organizerId)).can_delete).toBe(true);
    await deleteMyAccount(organizerId);
    expect(await referencesTo(organizerId)).toEqual({});
    expect(await countRows('memberships', "community_id = $1 and status = 'active' and role = 'organizer'", [communityId])).toBe(1);
  });

  it('lists every blocking community, and a removed co-organizer does not count', async () => {
    const a = await createPack(1);
    const b = await packWithTwoOrganizers(1);
    const c = await createPack(1);
    // The victim leads a and c alone; in b there is a second organizer.
    const victim = a.organizerId;
    await admin.query(
      "insert into public.memberships (community_id, user_id, role) values ($1, $2, 'organizer'), ($3, $2, 'organizer')",
      [b.communityId, victim, c.communityId],
    );
    // c's own organizer is removed: the victim is c's last active organizer.
    await admin.query("update public.memberships set status = 'removed' where community_id = $1 and user_id = $2", [
      c.communityId,
      c.organizerId,
    ]);

    const blockers = await myDeletionBlockers(victim);
    expect(blockers.can_delete).toBe(false);
    expect(blockers.last_organizer.map((x) => x.community_id).sort()).toEqual([a.communityId, c.communityId].sort());
    const error = await deletionError(victim);
    expect(error.message).toBe('last_organizer');
    expect((JSON.parse(error.detail!) as { communities: { community_id: string }[] }).communities).toHaveLength(2);
  });

  it('private.erase_user refuses too, whoever calls it (the G3 job reuses it)', async () => {
    const { organizerId } = await createPack(1);
    await expect(
      admin.query('select private.erase_user($1)', [organizerId]).catch(errorKey),
    ).resolves.toBe('P0001:last_organizer');
    expect(await countRows('profiles', 'id = $1', [organizerId])).toBe(1);
  });

  it('an organizer with a co-organizer and an ordinary member can delete', async () => {
    const pack = await packWithTwoOrganizers(2);
    expect(await myDeletionBlockers(pack.organizerId)).toEqual({
      can_delete: true,
      last_organizer: [],
      deleted_with_account: [],
    });
    await deleteMyAccount(pack.organizerId);
    await deleteMyAccount(pack.memberIds[0]);
    expect(await referencesTo(pack.organizerId)).toEqual({});
    expect(await referencesTo(pack.memberIds[0])).toEqual({});
    expect(await countRows('memberships', 'community_id = $1', [pack.communityId])).toBe(2);
    expect(await countRows('communities', 'id = $1', [pack.communityId])).toBe(1);
  });
});

describe('last active member', () => {
  it('takes the whole community with them, including removed members history', async () => {
    const { communityId, organizerId, memberIds, session } = await confirmedSession(1, 1);
    await recordAttendance(organizerId, session.id, memberIds[0], 'present');
    await finalizeAttendance(organizerId, session.id);
    await createAnnouncement(organizerId, communityId);
    const open = await createTraining(organizerId, communityId);
    await setRsvp(memberIds[0], open.id, 'going');
    await asUser(organizerId, (db) => db.query('select public.create_invitation($1)', [communityId]));
    // The member is removed: the organizer is now the only active member.
    await removeMember(organizerId, communityId, memberIds[0]);

    // The removed member is also in another community, which must not be touched.
    const other = await createPack(0);
    await admin.query('insert into public.memberships (community_id, user_id) values ($1, $2)', [
      other.communityId,
      memberIds[0],
    ]);

    expect(await myDeletionBlockers(organizerId)).toEqual({
      can_delete: true,
      last_organizer: [],
      deleted_with_account: [{ community_id: communityId, name: 'Test Pack' }],
    });
    const result = await deleteMyAccount(organizerId);
    expect(result.communities_deleted).toEqual([communityId]);

    // Nothing anywhere refers to the community any more.
    expect(await referencesTo(communityId)).toEqual({});
    expect(await referencesTo(organizerId)).toEqual({});
    // The removed member keeps their account and their other membership.
    expect(await countRows('profiles', 'id = $1', [memberIds[0]])).toBe(1);
    expect(await countRows('memberships', 'user_id = $1', [memberIds[0]])).toBe(1);
    expect(await countRows('communities', 'id = $1', [other.communityId])).toBe(1);
  });

  it('a community whose only active member is an ordinary member is deleted too', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [organizerId]);
    expect((await myDeletionBlockers(memberIds[0])).deleted_with_account).toEqual([
      { community_id: communityId, name: 'Test Pack' },
    ]);
    await deleteMyAccount(memberIds[0]);
    expect(await countRows('communities', 'id = $1', [communityId])).toBe(0);
    expect(await countRows('profiles', 'id = $1', [organizerId])).toBe(1);
  });
});

describe('accounts without data', () => {
  it('a user who only accepted the terms (no profile) is deleted with the consent ledger', async () => {
    const userId = await createUser();
    await asUser(userId, (db) => db.query("select public.record_consent('push_notifications')"));
    expect(await countRows('consent_records', 'user_id = $1', [userId])).toBe(3);

    const result = await deleteMyAccount(userId);
    expect(result).toEqual({
      user_id: userId,
      communities_deleted: [],
      memberships_deleted: 0,
      rsvps_deleted: 0,
      attendance_records_anonymized: 0,
      attendance_changes_anonymized: 0,
      notifications_deleted: 0,
    });
    expect(await referencesTo(userId)).toEqual({});
    // The ledger is still append-only for everybody else.
    const other = await createUser();
    await expect(
      admin.query('delete from public.consent_records where user_id = $1', [other]).catch(errorKey),
    ).resolves.toBe('P0001:consent_ledger_append_only');
  });

  it('a second call with the same (still valid) JWT is not_authenticated', async () => {
    const pack = await createPack(1);
    await deleteMyAccount(pack.memberIds[0]);
    await expect(deleteMyAccount(pack.memberIds[0]).catch(errorKey)).resolves.toBe('P0001:not_authenticated');
    await expect(myDeletionBlockers(pack.memberIds[0]).catch(errorKey)).resolves.toBe('P0001:not_authenticated');
  });
});

describe('who can call it', () => {
  it('anon and service_role cannot execute the G2 user functions; a JWT without a user is not_authenticated', async () => {
    for (const fn of ['delete_my_account', 'export_my_data', 'my_deletion_blockers']) {
      await expect(asAnon((db) => db.query(`select public.${fn}()`)).catch((e: PgError) => e.code)).resolves.toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      await expect(
        asService((db) => db.query(`select public.${fn}()`)).catch((e: PgError) => e.code),
      ).resolves.toBe(INSUFFICIENT_PRIVILEGE);
      await expect(asNobody((db) => db.query(`select public.${fn}()`)).catch(errorKey)).resolves.toBe(
        'P0001:not_authenticated',
      );
    }
    for (const fn of ['erase_user', 'lock_user_for_erasure', 'deletion_blockers']) {
      const user = await addMember((await createPack(0)).communityId);
      await expect(
        asUser(user, (db) => db.query(`select private.${fn}($1)`, [user])).catch((e: PgError) => e.code),
      ).resolves.toBe(INSUFFICIENT_PRIVILEGE);
      await expect(
        asService((db) => db.query(`select private.${fn}($1)`, [user])).catch((e: PgError) => e.code),
      ).resolves.toBe(INSUFFICIENT_PRIVILEGE);
    }
  });
});
