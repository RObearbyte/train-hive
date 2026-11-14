import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addMember,
  admin,
  asRole,
  asUser,
  closeDb,
  countRows,
  createCommunity,
  createUser,
  insertInvitation,
  resetData,
  rpc,
} from './helpers';

type Result = {
  ok: boolean;
  error?: string;
  community_id?: string;
  membership_id?: string;
  role?: string;
  already_member?: boolean;
  community_name?: string;
};

const redeem = (userId: string, code: string | null, name: string | null = 'Ana Runner') =>
  asUser(userId, (db) => rpc<Result>(db, 'redeem_invitation', [code, name]));

const preview = (userId: string, code: string | null) =>
  asUser(userId, (db) => rpc<Result>(db, 'preview_invitation', [code]));

const failedAttempts = (userId: string) =>
  countRows('invitation_attempts', 'user_id = $1 and not success', [userId]);

beforeEach(resetData);
afterAll(closeDb);

describe('redeem_invitation', () => {
  it('creates the profile and an organizer membership from the bootstrap code', async () => {
    const { communityId, organizerCode } = await createCommunity();
    const userId = await createUser();

    const result = await redeem(userId, organizerCode, 'Olga Organizer');

    expect(result).toMatchObject({
      ok: true,
      community_id: communityId,
      role: 'organizer',
      already_member: false,
    });
    const { rows: memberships } = await admin.query(
      'select id, role, status from public.memberships where user_id = $1',
      [userId],
    );
    expect(memberships).toEqual([{ id: result.membership_id, role: 'organizer', status: 'active' }]);
    const { rows: profiles } = await admin.query(
      'select display_name from public.profiles where id = $1',
      [userId],
    );
    expect(profiles).toEqual([{ display_name: 'Olga Organizer' }]);
    expect(await countRows('invitation_redemptions', 'user_id = $1', [userId])).toBe(1);
    expect(await countRows('invitation_codes', 'code = $1 and redemption_count = 1', [organizerCode])).toBe(1);
    expect(await countRows('invitation_attempts', 'user_id = $1 and success', [userId])).toBe(1);
  });

  it('creates a member membership from a member code', async () => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'MEMBER22');
    const userId = await createUser();

    const result = await redeem(userId, 'MEMBER22');

    expect(result).toMatchObject({ ok: true, community_id: communityId, role: 'member', already_member: false });
    expect(await countRows('memberships', "user_id = $1 and role = 'member'", [userId])).toBe(1);
  });

  it('returns already_member without consuming a redemption', async () => {
    const { communityId } = await createCommunity();
    const invitation = await insertInvitation(communityId, 'MEMBER22', { maxRedemptions: 2 });
    const userId = await createUser();

    const first = await redeem(userId, 'MEMBER22');
    const second = await redeem(userId, 'MEMBER22', 'Ana Renamed');

    expect(first.already_member).toBe(false);
    expect(second).toMatchObject({
      ok: true,
      already_member: true,
      membership_id: first.membership_id,
      role: 'member',
    });
    const { rows } = await admin.query(
      'select redemption_count from public.invitation_codes where id = $1',
      [invitation.id],
    );
    expect(rows[0].redemption_count).toBe(1);
    expect(await countRows('invitation_redemptions')).toBe(1);
    expect(await countRows('memberships', 'user_id = $1', [userId])).toBe(1);
  });

  it('lets an existing member re-enter an exhausted single-use code (already_member)', async () => {
    const { organizerCode } = await createCommunity();
    const userId = await createUser();
    await redeem(userId, organizerCode);

    const again = await redeem(userId, organizerCode);

    expect(again).toMatchObject({ ok: true, already_member: true, role: 'organizer' });
    expect(await countRows('invitation_codes', 'redemption_count = 1')).toBe(1);
  });

  it('does not promote an existing member who redeems an organizer code', async () => {
    const { communityId, organizerCode } = await createCommunity();
    const memberId = await addMember(communityId);

    const result = await redeem(memberId, organizerCode);

    expect(result).toMatchObject({ ok: true, already_member: true, role: 'member' });
    expect(await countRows('memberships', "user_id = $1 and role = 'member'", [memberId])).toBe(1);
    expect(await countRows('invitation_codes', 'code = $1 and redemption_count = 0', [organizerCode])).toBe(1);
  });

  it('rejects an unknown code with invalid_code', async () => {
    await createCommunity();
    const userId = await createUser();

    expect(await redeem(userId, 'ZZZZ9999')).toEqual({ ok: false, error: 'invalid_code' });
    expect(await redeem(userId, '')).toEqual({ ok: false, error: 'invalid_code' });
    expect(await redeem(userId, null)).toEqual({ ok: false, error: 'invalid_code' });
    expect(await countRows('profiles')).toBe(0);
    expect(await countRows('memberships')).toBe(0);
  });

  it('rejects an expired code with expired', async () => {
    const { communityId } = await createCommunity();
    const invitation = await insertInvitation(communityId, 'MEMBER22');
    await admin.query(
      "update public.invitation_codes set expires_at = now() - interval '1 second' where id = $1",
      [invitation.id],
    );
    const userId = await createUser();

    expect(await redeem(userId, 'MEMBER22')).toEqual({ ok: false, error: 'expired' });
    expect(await countRows('memberships')).toBe(0);
  });

  it('accepts a code that has not expired yet', async () => {
    const { communityId } = await createCommunity();
    const invitation = await insertInvitation(communityId, 'MEMBER22');
    await admin.query(
      "update public.invitation_codes set expires_at = now() + interval '1 minute' where id = $1",
      [invitation.id],
    );

    expect((await redeem(await createUser(), 'MEMBER22')).ok).toBe(true);
  });

  it('rejects a revoked code with revoked', async () => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'MEMBER22', { revoked: true });
    const userId = await createUser();

    expect(await redeem(userId, 'MEMBER22')).toEqual({ ok: false, error: 'revoked' });
    expect(await countRows('memberships')).toBe(0);
  });

  it('rejects an exhausted code with exhausted', async () => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'MEMBER22', { maxRedemptions: 1 });

    expect((await redeem(await createUser(), 'MEMBER22')).ok).toBe(true);
    const lateUser = await createUser();
    expect(await redeem(lateUser, 'MEMBER22')).toEqual({ ok: false, error: 'exhausted' });
    expect(await countRows('memberships', 'user_id = $1', [lateUser])).toBe(0);
    expect(await countRows('profiles', 'id = $1', [lateUser])).toBe(0);
  });

  it('does not let a removed member rejoin by code', async () => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'MEMBER22');
    const removedId = await addMember(communityId, { status: 'removed' });

    expect(await redeem(removedId, 'MEMBER22')).toEqual({ ok: false, error: 'invalid_code' });
    expect(await preview(removedId, 'MEMBER22')).toEqual({ ok: false, error: 'invalid_code' });
    expect(await countRows('memberships', "user_id = $1 and status = 'removed'", [removedId])).toBe(1);
  });

  it.each(['member22', ' MEMBER22 ', 'memb-er22', 'MEMB ER22', 'm e m b - e r 2 2', 'memb–er22\n'])(
    'normalizes the code %j (case, spaces, dashes)',
    async (typed) => {
      const { communityId } = await createCommunity();
      await insertInvitation(communityId, 'MEMBER22');
      const userId = await createUser();

      expect(await preview(userId, typed)).toMatchObject({ ok: true, role: 'member' });
      expect(await redeem(userId, typed)).toMatchObject({ ok: true, community_id: communityId });
    },
  );

  it.each([
    ['empty', ''],
    ['null', null],
    ['one character', 'A'],
    ['one character after trimming', '   A   '],
    ['only whitespace', '      '],
    ['41 characters', 'x'.repeat(41)],
  ])('rejects a display name that is %s', async (_label, name) => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'MEMBER22');
    const userId = await createUser();

    expect(await redeem(userId, 'MEMBER22', name)).toEqual({ ok: false, error: 'invalid_display_name' });
    expect(await countRows('profiles')).toBe(0);
    expect(await countRows('memberships')).toBe(0);
    // A bad name is not a code guess: it must not count toward the rate limit.
    expect(await failedAttempts(userId)).toBe(0);
  });

  it.each([
    ['2 characters', 'Al', 'Al'],
    ['40 characters', 'x'.repeat(40), 'x'.repeat(40)],
    ['padded', '  Ana   Maria \n', 'Ana Maria'],
    ['non-ASCII', 'Ștefan Țîrcă', 'Ștefan Țîrcă'],
  ])('accepts a display name that is %s and stores it trimmed', async (_label, name, stored) => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'MEMBER22');
    const userId = await createUser();

    expect((await redeem(userId, 'MEMBER22', name)).ok).toBe(true);
    const { rows } = await admin.query('select display_name from public.profiles where id = $1', [userId]);
    expect(rows[0].display_name).toBe(stored);
  });

  it('returns not_authenticated when the JWT carries no user', async () => {
    const { organizerCode } = await createCommunity();

    const result = await asRole('authenticated', { role: 'authenticated' }, (db) =>
      rpc<Result>(db, 'redeem_invitation', [organizerCode, 'No Body']),
    );
    const previewResult = await asRole('authenticated', null, (db) =>
      rpc<Result>(db, 'preview_invitation', [organizerCode]),
    );

    expect(result).toEqual({ ok: false, error: 'not_authenticated' });
    expect(previewResult).toEqual({ ok: false, error: 'not_authenticated' });
    expect(await countRows('memberships')).toBe(0);
  });
});

describe('preview_invitation', () => {
  it('returns the community name and role without redeeming', async () => {
    const { organizerCode } = await createCommunity('Wolf Pack');
    const userId = await createUser();

    expect(await preview(userId, organizerCode)).toEqual({
      ok: true,
      community_name: 'Wolf Pack',
      role: 'organizer',
    });
    expect(await countRows('memberships')).toBe(0);
    expect(await countRows('profiles')).toBe(0);
    expect(await countRows('invitation_redemptions')).toBe(0);
    expect(await countRows('invitation_codes', 'redemption_count = 0')).toBe(1);
  });

  it('reports invalid_code, expired, revoked and exhausted', async () => {
    const { communityId } = await createCommunity();
    const expired = await insertInvitation(communityId, 'EXPRD222');
    await admin.query(
      "update public.invitation_codes set expires_at = now() - interval '1 hour' where id = $1",
      [expired.id],
    );
    await insertInvitation(communityId, 'REVKD222', { revoked: true });
    await insertInvitation(communityId, 'EXHSTD22', { maxRedemptions: 1 });
    await redeem(await createUser(), 'EXHSTD22');
    const userId = await createUser();

    expect(await preview(userId, 'NNNN2222')).toEqual({ ok: false, error: 'invalid_code' });
    expect(await preview(userId, 'EXPRD222')).toEqual({ ok: false, error: 'expired' });
    expect(await preview(userId, 'REVKD222')).toEqual({ ok: false, error: 'revoked' });
    expect(await preview(userId, 'EXHSTD22')).toEqual({ ok: false, error: 'exhausted' });
  });
});

describe('invitation rate limiting', () => {
  it('blocks after 5 failed attempts, even for a valid code, and keeps the attempt rows', async () => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'MEMBER22');
    const userId = await createUser();

    // Failures are shared between preview and redeem.
    expect(await preview(userId, 'WRNG2222')).toEqual({ ok: false, error: 'invalid_code' });
    expect(await redeem(userId, 'WRNG3333')).toEqual({ ok: false, error: 'invalid_code' });
    expect(await preview(userId, 'WRNG4444')).toEqual({ ok: false, error: 'invalid_code' });
    expect(await redeem(userId, 'WRNG5555')).toEqual({ ok: false, error: 'invalid_code' });
    expect(await failedAttempts(userId)).toBe(4);
    expect(await preview(userId, 'WRNG6666')).toEqual({ ok: false, error: 'invalid_code' });

    // The failed attempts were committed although the functions reported an error.
    expect(await failedAttempts(userId)).toBe(5);

    expect(await preview(userId, 'MEMBER22')).toEqual({ ok: false, error: 'rate_limited' });
    expect(await redeem(userId, 'MEMBER22')).toEqual({ ok: false, error: 'rate_limited' });
    expect(await redeem(userId, 'WRNG7777')).toEqual({ ok: false, error: 'rate_limited' });
    expect(await countRows('memberships', 'user_id = $1', [userId])).toBe(0);
    // Rate-limited calls are not logged, so hammering cannot extend the lockout.
    expect(await failedAttempts(userId)).toBe(5);
  });

  it('counts expired, revoked and exhausted codes as failed attempts', async () => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'REVKD222', { revoked: true });
    const userId = await createUser();

    for (let i = 0; i < 5; i += 1) {
      expect(await redeem(userId, 'REVKD222')).toEqual({ ok: false, error: 'revoked' });
    }
    expect(await redeem(userId, 'REVKD222')).toEqual({ ok: false, error: 'rate_limited' });
  });

  it('is per user', async () => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'MEMBER22');
    const blocked = await createUser();
    const other = await createUser();
    for (let i = 0; i < 5; i += 1) await preview(blocked, 'WRNG2222');

    expect(await preview(blocked, 'MEMBER22')).toEqual({ ok: false, error: 'rate_limited' });
    expect((await redeem(other, 'MEMBER22')).ok).toBe(true);
  });

  it('allows 4 failures followed by a success', async () => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'MEMBER22');
    const userId = await createUser();
    for (let i = 0; i < 4; i += 1) await preview(userId, 'WRNG2222');

    expect((await redeem(userId, 'MEMBER22')).ok).toBe(true);
  });

  it('lifts after the 15 minute window and prunes day-old rows', async () => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'MEMBER22');
    const userId = await createUser();
    for (let i = 0; i < 5; i += 1) await preview(userId, 'WRNG2222');
    expect(await preview(userId, 'MEMBER22')).toEqual({ ok: false, error: 'rate_limited' });

    await admin.query(
      "update public.invitation_attempts set attempted_at = attempted_at - interval '14 minutes' where user_id = $1",
      [userId],
    );
    expect(await preview(userId, 'MEMBER22')).toEqual({ ok: false, error: 'rate_limited' });

    await admin.query(
      "update public.invitation_attempts set attempted_at = attempted_at - interval '2 minutes' where user_id = $1",
      [userId],
    );
    expect((await preview(userId, 'MEMBER22')).ok).toBe(true);
    expect(await countRows('invitation_attempts', 'user_id = $1', [userId])).toBe(6);

    await admin.query(
      "update public.invitation_attempts set attempted_at = attempted_at - interval '2 days' where user_id = $1",
      [userId],
    );
    expect((await preview(userId, 'MEMBER22')).ok).toBe(true);
    expect(await countRows('invitation_attempts', 'user_id = $1', [userId])).toBe(1);
  });

  it('cannot be bypassed with parallel requests', async () => {
    await createCommunity();
    const userId = await createUser();

    const results = await Promise.all(
      Array.from({ length: 12 }, () => preview(userId, 'WRNG2222')),
    );

    expect(results.filter((r) => r.error === 'invalid_code')).toHaveLength(5);
    expect(results.filter((r) => r.error === 'rate_limited')).toHaveLength(7);
    expect(await failedAttempts(userId)).toBe(5);
  });
});

describe('redeem_invitation concurrency', () => {
  /** Resolves once `count` backends are blocked waiting for a lock. */
  async function waitForBlockedBackends(count: number): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const { rows } = await admin.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like '%redeem_invitation%'",
      );
      if (rows[0].n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${count} blocked redeem_invitation calls`);
  }

  it('gives a max_redemptions = 1 code to exactly one of 5 simultaneous users', async () => {
    const { communityId } = await createCommunity();
    const invitation = await insertInvitation(communityId, 'MEMBER22', { maxRedemptions: 1 });
    const users = await Promise.all(Array.from({ length: 5 }, () => createUser()));

    // Hold the invitation row so that all 5 calls are queued on it at the same moment,
    // then release them together.
    const gate = await admin.connect();
    let pending: Promise<Result[]>;
    try {
      await gate.query('begin');
      await gate.query('select 1 from public.invitation_codes where id = $1 for update', [invitation.id]);
      pending = Promise.all(users.map((userId) => redeem(userId, 'MEMBER22')));
      await waitForBlockedBackends(5);
      await gate.query('commit');
    } finally {
      // No-op after the commit; releases the row lock if anything above threw.
      await gate.query('rollback');
      gate.release();
    }
    const results = await pending;

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.error === 'exhausted')).toHaveLength(4);
    expect(await countRows('memberships', 'community_id = $1', [communityId])).toBe(1);
    expect(await countRows('invitation_redemptions', 'invitation_id = $1', [invitation.id])).toBe(1);
    expect(await countRows('profiles')).toBe(1);
    const { rows } = await admin.query(
      'select redemption_count from public.invitation_codes where id = $1',
      [invitation.id],
    );
    expect(rows[0].redemption_count).toBe(1);
  });

  it('never exceeds max_redemptions = 3 with 10 free-running users', async () => {
    const { communityId } = await createCommunity();
    const invitation = await insertInvitation(communityId, 'MEMBER22', { maxRedemptions: 3 });
    const users = await Promise.all(Array.from({ length: 10 }, () => createUser()));

    const results = await Promise.all(users.map((userId) => redeem(userId, 'MEMBER22')));

    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => r.error === 'exhausted')).toHaveLength(7);
    expect(await countRows('memberships', 'community_id = $1', [communityId])).toBe(3);
    expect(await countRows('invitation_codes', 'id = $1 and redemption_count = 3', [invitation.id])).toBe(1);
  });

  it('creates one membership when the same user redeems 5 times in parallel', async () => {
    const { communityId } = await createCommunity();
    const invitation = await insertInvitation(communityId, 'MEMBER22');
    const userId = await createUser();

    const results = await Promise.all(Array.from({ length: 5 }, () => redeem(userId, 'MEMBER22')));

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.already_member === false)).toHaveLength(1);
    expect(results.filter((r) => r.already_member === true)).toHaveLength(4);
    expect(await countRows('memberships', 'user_id = $1', [userId])).toBe(1);
    expect(await countRows('invitation_codes', 'id = $1 and redemption_count = 1', [invitation.id])).toBe(1);
  });

  it('does not redeem a code that is revoked while the call is waiting', async () => {
    const { communityId } = await createCommunity();
    const invitation = await insertInvitation(communityId, 'MEMBER22');
    const userId = await createUser();

    const gate = await admin.connect();
    let pending: Promise<Result>;
    try {
      await gate.query('begin');
      await gate.query('update public.invitation_codes set revoked_at = now() where id = $1', [invitation.id]);
      pending = redeem(userId, 'MEMBER22');
      await waitForBlockedBackends(1);
      await gate.query('commit');
    } finally {
      // No-op after the commit; releases the row lock if anything above threw.
      await gate.query('rollback');
      gate.release();
    }

    expect(await pending).toEqual({ ok: false, error: 'revoked' });
    expect(await countRows('memberships', 'user_id = $1', [userId])).toBe(0);
  });
});
