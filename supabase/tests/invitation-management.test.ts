import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addMember,
  admin,
  asAnon,
  asRole,
  asService,
  asUser,
  closeDb,
  countRows,
  createCommunity,
  createUser,
  INSUFFICIENT_PRIVILEGE,
  insertInvitation,
  RAISED,
  resetData,
  rpc,
  rpcRow,
} from './helpers';

type Invitation = {
  id: string;
  community_id: string;
  code: string;
  role: string;
  created_by: string | null;
  expires_at: Date | null;
  max_redemptions: number | null;
  redemption_count: number;
  revoked_at: Date | null;
};

const raised = (message: string) => ({ code: RAISED, message });

beforeEach(resetData);
afterAll(closeDb);

describe('admin_create_community', () => {
  it('creates a community and a single-use organizer invitation valid for 7 days', async () => {
    const result = await asService((db) =>
      rpc<{ community_id: string; organizer_code: string }>(db, 'admin_create_community', [
        '  Wolf Pack  ',
        'Europe/Bucharest',
      ]),
    );

    expect(Object.keys(result).sort()).toEqual(['community_id', 'organizer_code']);
    expect(result.organizer_code).toMatch(/^[2-9A-HJKMNP-TV-Z]{8}$/);
    const { rows: communities } = await admin.query('select id, name, timezone from public.communities');
    expect(communities).toEqual([
      { id: result.community_id, name: 'Wolf Pack', timezone: 'Europe/Bucharest' },
    ]);
    const { rows: invitations } = await admin.query(
      `select community_id, code, role, created_by, max_redemptions, redemption_count, revoked_at,
              expires_at > now() + interval '7 days' - interval '1 minute' as lasts_7_days,
              expires_at <= now() + interval '7 days' as at_most_7_days
       from public.invitation_codes`,
    );
    expect(invitations).toEqual([
      {
        community_id: result.community_id,
        code: result.organizer_code,
        role: 'organizer',
        created_by: null,
        max_redemptions: 1,
        redemption_count: 0,
        revoked_at: null,
        lasts_7_days: true,
        at_most_7_days: true,
      },
    ]);
  });

  it.each(['Mars/Phobos', '', 'europe/bucharest ', null])('rejects the timezone %j', async (timezone) => {
    await expect(
      asService((db) => rpc(db, 'admin_create_community', ['Wolf Pack', timezone])),
    ).rejects.toMatchObject(raised('validation_failed:timezone'));
    expect(await countRows('communities')).toBe(0);
    expect(await countRows('invitation_codes')).toBe(0);
  });

  it.each(['', '   ', null, 'x'.repeat(81)])('rejects the name %j', async (name) => {
    await expect(
      asService((db) => rpc(db, 'admin_create_community', [name, 'Europe/Bucharest'])),
    ).rejects.toMatchObject(raised('validation_failed:name'));
    expect(await countRows('communities')).toBe(0);
  });

  it('is denied to authenticated users, including organizers', async () => {
    const { communityId } = await createCommunity();
    const organizerId = await addMember(communityId, { role: 'organizer' });
    const outsiderId = await createUser();

    for (const userId of [organizerId, outsiderId]) {
      await expect(
        asUser(userId, (db) => rpc(db, 'admin_create_community', ['Mine', 'Europe/Bucharest'])),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    }
    // A forged "service_role" claim does not help: the database role is what is checked.
    await expect(
      asRole('authenticated', { sub: outsiderId, role: 'service_role' }, (db) =>
        rpc(db, 'admin_create_community', ['Mine', 'Europe/Bucharest']),
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    expect(await countRows('communities')).toBe(1);
  });

  it('is denied to anon', async () => {
    await expect(
      asAnon((db) => rpc(db, 'admin_create_community', ['Mine', 'Europe/Bucharest'])),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    expect(await countRows('communities')).toBe(0);
  });
});

describe('create_invitation', () => {
  it('lets an organizer create an unlimited member invitation', async () => {
    const { communityId } = await createCommunity();
    const organizerId = await addMember(communityId, { role: 'organizer' });

    const invitation = await asUser(organizerId, (db) =>
      rpcRow<Invitation>(db, 'create_invitation', [communityId]),
    );

    expect(invitation).toMatchObject({
      community_id: communityId,
      role: 'member',
      created_by: organizerId,
      expires_at: null,
      max_redemptions: null,
      redemption_count: 0,
      revoked_at: null,
    });
    expect(invitation.code).toMatch(/^[2-9A-HJKMNP-TV-Z]{8}$/);
  });

  it('stores expiry and max redemptions, and the code can be redeemed as member', async () => {
    const { communityId } = await createCommunity();
    const organizerId = await addMember(communityId, { role: 'organizer' });
    const expiresAt = new Date(Date.now() + 3_600_000);

    const invitation = await asUser(organizerId, (db) =>
      rpcRow<Invitation>(db, 'create_invitation', [communityId, expiresAt.toISOString(), 3]),
    );
    const joinerId = await createUser();
    const redeemed = await asUser(joinerId, (db) =>
      rpc(db, 'redeem_invitation', [invitation.code, 'New Member']),
    );

    expect(invitation.max_redemptions).toBe(3);
    expect(invitation.expires_at?.getTime()).toBe(expiresAt.getTime());
    expect(redeemed).toMatchObject({ ok: true, role: 'member', community_id: communityId });
  });

  it('generates distinct codes', async () => {
    const { communityId } = await createCommunity();
    const organizerId = await addMember(communityId, { role: 'organizer' });

    const codes = await asUser(organizerId, async (db) => {
      const created: string[] = [];
      for (let i = 0; i < 25; i += 1) {
        created.push((await rpcRow<Invitation>(db, 'create_invitation', [communityId])).code);
      }
      return created;
    });

    expect(new Set(codes).size).toBe(25);
  });

  it('is forbidden for members, removed organizers, outsiders and other organizers', async () => {
    const { communityId } = await createCommunity();
    const other = await createCommunity('Other Pack');
    const memberId = await addMember(communityId);
    const removedOrganizerId = await addMember(communityId, { role: 'organizer', status: 'removed' });
    const otherOrganizerId = await addMember(other.communityId, { role: 'organizer' });
    const outsiderId = await createUser();
    const before = await countRows('invitation_codes');

    for (const userId of [memberId, removedOrganizerId, otherOrganizerId, outsiderId]) {
      await expect(
        asUser(userId, (db) => rpcRow(db, 'create_invitation', [communityId])),
      ).rejects.toMatchObject(raised('forbidden'));
    }
    expect(await countRows('invitation_codes')).toBe(before);
  });

  it('is forbidden for an unknown or null community', async () => {
    const { communityId } = await createCommunity();
    const organizerId = await addMember(communityId, { role: 'organizer' });

    await expect(
      asUser(organizerId, (db) =>
        rpcRow(db, 'create_invitation', ['00000000-0000-4000-8000-000000000000']),
      ),
    ).rejects.toMatchObject(raised('forbidden'));
    await expect(
      asUser(organizerId, (db) => rpcRow(db, 'create_invitation', [null])),
    ).rejects.toMatchObject(raised('forbidden'));
  });

  it('validates expiry and max redemptions', async () => {
    const { communityId } = await createCommunity();
    const organizerId = await addMember(communityId, { role: 'organizer' });
    const past = new Date(Date.now() - 60_000).toISOString();

    await expect(
      asUser(organizerId, (db) => rpcRow(db, 'create_invitation', [communityId, past, null])),
    ).rejects.toMatchObject(raised('validation_failed:expires_at'));
    for (const max of [0, -1]) {
      await expect(
        asUser(organizerId, (db) => rpcRow(db, 'create_invitation', [communityId, null, max])),
      ).rejects.toMatchObject(raised('validation_failed:max_redemptions'));
    }
  });

  it('requires a user and is denied to anon', async () => {
    const { communityId } = await createCommunity();

    await expect(
      asRole('authenticated', { role: 'authenticated' }, (db) =>
        rpcRow(db, 'create_invitation', [communityId]),
      ),
    ).rejects.toMatchObject(raised('not_authenticated'));
    await expect(
      asAnon((db) => rpcRow(db, 'create_invitation', [communityId])),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });
});

describe('revoke_invitation', () => {
  it('lets an organizer revoke, is idempotent, and the code stops working', async () => {
    const { communityId } = await createCommunity();
    const organizerId = await addMember(communityId, { role: 'organizer' });
    const invitation = await insertInvitation(communityId, 'MEMBER22');

    const first = await asUser(organizerId, (db) =>
      rpcRow<Invitation>(db, 'revoke_invitation', [invitation.id]),
    );
    const second = await asUser(organizerId, (db) =>
      rpcRow<Invitation>(db, 'revoke_invitation', [invitation.id]),
    );
    const redeemed = await asUser(await createUser(), (db) =>
      rpc(db, 'redeem_invitation', ['MEMBER22', 'Too Late']),
    );

    expect(first.id).toBe(invitation.id);
    expect(first.revoked_at).toBeInstanceOf(Date);
    expect(second.revoked_at).toEqual(first.revoked_at);
    expect(redeemed).toEqual({ ok: false, error: 'revoked' });
  });

  it('is forbidden for members, outsiders and organizers of another community', async () => {
    const { communityId } = await createCommunity();
    const other = await createCommunity('Other Pack');
    const invitation = await insertInvitation(communityId, 'MEMBER22');
    const memberId = await addMember(communityId);
    const otherOrganizerId = await addMember(other.communityId, { role: 'organizer' });
    const outsiderId = await createUser();

    for (const userId of [memberId, otherOrganizerId, outsiderId]) {
      await expect(
        asUser(userId, (db) => rpcRow(db, 'revoke_invitation', [invitation.id])),
      ).rejects.toMatchObject(raised('forbidden'));
    }
    expect(await countRows('invitation_codes', 'id = $1 and revoked_at is null', [invitation.id])).toBe(1);
  });

  it('raises not_found for an unknown invitation', async () => {
    const { communityId } = await createCommunity();
    const organizerId = await addMember(communityId, { role: 'organizer' });

    await expect(
      asUser(organizerId, (db) =>
        rpcRow(db, 'revoke_invitation', ['00000000-0000-4000-8000-000000000000']),
      ),
    ).rejects.toMatchObject(raised('not_found'));
  });

  it('requires a user and is denied to anon', async () => {
    const { communityId } = await createCommunity();
    const invitation = await insertInvitation(communityId, 'MEMBER22');

    await expect(
      asRole('authenticated', null, (db) => rpcRow(db, 'revoke_invitation', [invitation.id])),
    ).rejects.toMatchObject(raised('not_authenticated'));
    await expect(
      asAnon((db) => rpcRow(db, 'revoke_invitation', [invitation.id])),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });
});

describe('update_display_name', () => {
  it('updates only the caller profile and stores the cleaned name', async () => {
    const { communityId } = await createCommunity();
    const userId = await addMember(communityId, { name: 'Old Name' });
    const otherId = await addMember(communityId, { name: 'Other Person' });

    const profile = await asUser(userId, (db) =>
      rpcRow<{ id: string; display_name: string; created_at: Date; updated_at: Date }>(
        db,
        'update_display_name',
        ['  New   Name '],
      ),
    );

    expect(profile).toMatchObject({ id: userId, display_name: 'New Name' });
    expect(profile.updated_at.getTime()).toBeGreaterThanOrEqual(profile.created_at.getTime());
    expect(await countRows('profiles', "id = $1 and display_name = 'Other Person'", [otherId])).toBe(1);
  });

  it.each(['', 'A', '   ', 'x'.repeat(41), null])('rejects the name %j', async (name) => {
    const { communityId } = await createCommunity();
    const userId = await addMember(communityId, { name: 'Old Name' });

    await expect(
      asUser(userId, (db) => rpcRow(db, 'update_display_name', [name])),
    ).rejects.toMatchObject(raised('validation_failed:display_name'));
    expect(await countRows('profiles', "id = $1 and display_name = 'Old Name'", [userId])).toBe(1);
  });

  it('raises not_found without a profile, not_authenticated without a user, and denies anon', async () => {
    const userId = await createUser();

    await expect(
      asUser(userId, (db) => rpcRow(db, 'update_display_name', ['Some Name'])),
    ).rejects.toMatchObject(raised('not_found'));
    await expect(
      asRole('authenticated', null, (db) => rpcRow(db, 'update_display_name', ['Some Name'])),
    ).rejects.toMatchObject(raised('not_authenticated'));
    await expect(
      asAnon((db) => rpcRow(db, 'update_display_name', ['Some Name'])),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    expect(await countRows('profiles')).toBe(0);
  });
});
