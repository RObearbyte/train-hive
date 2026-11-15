import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addMember,
  admin,
  asAnon,
  asService,
  asUser,
  closeDb,
  countRows,
  createCommunity,
  createPack,
  createTraining,
  createUser,
  INSUFFICIENT_PRIVILEGE,
  insertInvitation,
  RAISED,
  resetData,
  rpc,
  rpcRow,
} from './helpers';
import {
  asNobody,
  codeRow,
  createWithCode,
  type CreatorResult,
  failedAttempts,
  issueCode,
  listMyCommunities,
  previewCode,
  updateCommunity,
} from './creator-codes-helpers';

const denied = { code: INSUFFICIENT_PRIVILEGE };
const raised = (message: string) => ({ code: RAISED, message });

const previewInvitation = (userId: string, code: string) =>
  asUser(userId, (db) => rpc<CreatorResult>(db, 'preview_invitation', [code]));
const redeemInvitation = (userId: string, code: string) =>
  asUser(userId, (db) => rpc<CreatorResult>(db, 'redeem_invitation', [code, 'Ana Runner']));

beforeEach(resetData);
afterAll(closeDb);

describe('admin_create_creator_code', () => {
  it('issues an 8-character code with the requested expiry and uses', async () => {
    const before = Date.now();
    const issued = await issueCode({ note: '  for Alex  ', days: 14, maxUses: 1 });

    expect(issued.code).toMatch(/^[2-9A-HJKMNP-TV-Z]{8}$/);
    expect(issued.max_uses).toBe(1);
    const expires = new Date(issued.expires_at).getTime();
    expect(expires - before).toBeGreaterThan(14 * 86_400_000 - 60_000);
    expect(expires - before).toBeLessThan(14 * 86_400_000 + 60_000);

    const row = await codeRow(issued.code);
    expect(row).toMatchObject({ note: 'for Alex', use_count: 0, max_uses: 1, revoked_at: null, created_by: null });
  });

  it('uses the defaults (14 days, 1 use, no note) and runs from the SQL editor role', async () => {
    // `admin` is the superuser the SQL editor stands for (postgres).
    const { rows } = await admin.query<{ r: { code: string; max_uses: number; expires_at: string } }>(
      'select public.admin_create_creator_code() as r',
    );
    expect(rows[0].r.max_uses).toBe(1);
    const days = (new Date(rows[0].r.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
    expect((await codeRow(rows[0].r.code)).note).toBeNull();

    const named = await admin.query<{ r: { max_uses: number } }>(
      "select public.admin_create_creator_code('for Alex', 30, 3) as r",
    );
    expect(named.rows[0].r.max_uses).toBe(3);
  });

  it('validates the ranges and the note', async () => {
    const cases: [string | null, number | null, number | null, string][] = [
      [null, 0, 1, 'validation_failed:expires_in_days'],
      [null, 366, 1, 'validation_failed:expires_in_days'],
      [null, null, 1, 'validation_failed:expires_in_days'],
      [null, 14, 0, 'validation_failed:max_uses'],
      [null, 14, 51, 'validation_failed:max_uses'],
      [null, 14, null, 'validation_failed:max_uses'],
      ['x'.repeat(101), 14, 1, 'validation_failed:note'],
      ['​​', 14, 1, 'validation_failed:note'],
    ];
    for (const [note, days, uses, error] of cases) {
      await expect(
        asService((db) => rpc(db, 'admin_create_creator_code', [note, days, uses])),
        error,
      ).rejects.toMatchObject(raised(error));
    }
    expect(await countRows('community_creator_codes')).toBe(0);

    // The bounds themselves are accepted; a blank note is stored as null.
    const max = await issueCode({ note: '   ', days: 365, maxUses: 50 });
    expect(max.max_uses).toBe(50);
    expect((await codeRow(max.code)).note).toBeNull();
    await issueCode({ note: 'x'.repeat(100), days: 1, maxUses: 1 });
  });

  it('is denied to anon, members and organizers', async () => {
    const { organizerId, memberIds } = await createPack(1);
    for (const userId of [organizerId, memberIds[0]]) {
      await expect(
        asUser(userId, (db) => db.query('select public.admin_create_creator_code()')),
      ).rejects.toMatchObject(denied);
      await expect(
        asUser(userId, (db) => db.query("select public.admin_revoke_creator_code('AAAAAAAA')")),
      ).rejects.toMatchObject(denied);
    }
    await expect(asAnon((db) => db.query('select public.admin_create_creator_code()'))).rejects.toMatchObject(denied);
    await expect(
      asAnon((db) => db.query("select public.admin_revoke_creator_code('AAAAAAAA')")),
    ).rejects.toMatchObject(denied);
    expect(await countRows('community_creator_codes')).toBe(0);
  });
});

describe('admin_revoke_creator_code', () => {
  it('revokes idempotently and accepts the code in any spelling', async () => {
    const { code } = await issueCode();
    const spelled = `${code.slice(0, 4).toLowerCase()} – ${code.slice(4)}`;

    const first = await asService((db) =>
      rpc<{ code: string; revoked_at: string; changed: boolean }>(db, 'admin_revoke_creator_code', [spelled]),
    );
    expect(first).toMatchObject({ code, changed: true });
    expect(first.revoked_at).toBeTruthy();

    const again = await asService((db) =>
      rpc<{ revoked_at: string; changed: boolean }>(db, 'admin_revoke_creator_code', [code]),
    );
    expect(again).toMatchObject({ changed: false, revoked_at: first.revoked_at });
  });

  it('reports not_found for an unknown code', async () => {
    await expect(
      asService((db) => rpc(db, 'admin_revoke_creator_code', ['ZZZZ2222'])),
    ).rejects.toMatchObject(raised('not_found'));
  });
});

describe('preview_creator_code', () => {
  it('accepts a valid code in any spelling without consuming it', async () => {
    const { code } = await issueCode();
    const userId = await createUser();
    for (const spelled of [code, code.toLowerCase(), ` ${code.slice(0, 4)}-${code.slice(4)} `, `${code.slice(0, 4)}—${code.slice(4)}`]) {
      expect(await previewCode(userId, spelled)).toEqual({ ok: true });
    }
    expect((await codeRow(code)).use_count).toBe(0);
    expect(await countRows('invitation_attempts', 'user_id = $1 and success', [userId])).toBe(4);
  });

  it('reports invalid_code, revoked, expired and exhausted, and records each failure', async () => {
    const userId = await createUser();
    const revoked = await issueCode();
    await asService((db) => rpc(db, 'admin_revoke_creator_code', [revoked.code]));
    const expired = await issueCode();
    await admin.query(
      "update public.community_creator_codes set expires_at = now() - interval '1 second' where code = $1",
      [expired.code],
    );
    const exhausted = await issueCode({ maxUses: 2 });
    await admin.query('update public.community_creator_codes set use_count = 2 where code = $1', [exhausted.code]);

    expect(await previewCode(userId, 'NOPE2222')).toEqual({ ok: false, error: 'invalid_code' });
    expect(await previewCode(userId, null)).toEqual({ ok: false, error: 'invalid_code' });
    expect(await previewCode(userId, revoked.code)).toEqual({ ok: false, error: 'revoked' });
    expect(await previewCode(userId, expired.code)).toEqual({ ok: false, error: 'expired' });
    expect(await previewCode(userId, exhausted.code)).toEqual({ ok: false, error: 'exhausted' });
    expect(await failedAttempts(userId)).toBe(5);
  });

  it('does not accept an invitation code, and redeem_invitation does not accept a creator code', async () => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'MEMBER22');
    const { code } = await issueCode();
    const userId = await createUser();

    expect(await previewCode(userId, 'MEMBER22')).toEqual({ ok: false, error: 'invalid_code' });
    expect(await createWithCode(userId, 'MEMBER22')).toEqual({ ok: false, error: 'invalid_code' });
    expect(await redeemInvitation(userId, code)).toEqual({ ok: false, error: 'invalid_code' });
    expect(await countRows('communities')).toBe(1);
    expect((await codeRow(code)).use_count).toBe(0);
  });

  it('answers not_authenticated without a user, and is denied to anon and service_role', async () => {
    const { code } = await issueCode();
    expect(await asNobody((db) => rpc(db, 'preview_creator_code', [code]))).toEqual({
      ok: false,
      error: 'not_authenticated',
    });
    await expect(asAnon((db) => rpc(db, 'preview_creator_code', [code]))).rejects.toMatchObject(denied);
    await expect(asService((db) => rpc(db, 'preview_creator_code', [code]))).rejects.toMatchObject(denied);
  });
});

describe('shared failed-attempt limiter (invitation and creator codes together)', () => {
  it('3 invitation failures + 2 creator failures exhaust the budget for both kinds', async () => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'GXXD2222');
    const { code } = await issueCode();
    const userId = await createUser();

    for (let i = 0; i < 3; i += 1) {
      expect(await previewInvitation(userId, 'BAD22222')).toMatchObject({ ok: false, error: 'invalid_code' });
    }
    for (let i = 0; i < 2; i += 1) {
      expect(await previewCode(userId, 'BAD33333')).toMatchObject({ ok: false, error: 'invalid_code' });
    }
    expect(await failedAttempts(userId)).toBe(5);

    // Valid codes of either kind are now refused, and nothing is created.
    expect(await previewCode(userId, code)).toEqual({ ok: false, error: 'rate_limited' });
    expect(await createWithCode(userId, code)).toEqual({ ok: false, error: 'rate_limited' });
    expect(await previewInvitation(userId, 'GXXD2222')).toEqual({ ok: false, error: 'rate_limited' });
    expect(await redeemInvitation(userId, 'GXXD2222')).toEqual({ ok: false, error: 'rate_limited' });
    expect(await countRows('communities')).toBe(1);
    expect(await countRows('memberships')).toBe(0);
    expect((await codeRow(code)).use_count).toBe(0);
    // rate_limited answers are not themselves counted; the 5 failures persisted.
    expect(await failedAttempts(userId)).toBe(5);

    // Another user is not affected.
    expect(await previewCode(await createUser(), code)).toEqual({ ok: true });

    // 15 minutes later the window has passed.
    await admin.query(
      "update public.invitation_attempts set attempted_at = attempted_at - interval '16 minutes' where user_id = $1",
      [userId],
    );
    expect(await createWithCode(userId, code)).toMatchObject({ ok: true });
  });

  it('5 creator-code failures block invitation redemption, and failures from create_community_with_code count', async () => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'GXXD2222');
    const userId = await createUser();
    for (let i = 0; i < 4; i += 1) {
      expect(await previewCode(userId, 'BAD33333')).toMatchObject({ error: 'invalid_code' });
    }
    expect(await createWithCode(userId, 'BAD44444')).toEqual({ ok: false, error: 'invalid_code' });
    expect(await failedAttempts(userId)).toBe(5);
    expect(await redeemInvitation(userId, 'GXXD2222')).toEqual({ ok: false, error: 'rate_limited' });
  });
});

describe('create_community_with_code', () => {
  it('creates the community, the profile and an organizer membership, and consumes one use', async () => {
    const { code } = await issueCode({ maxUses: 1 });
    const userId = await createUser();
    const requestId = randomUUID();

    const result = await createWithCode(userId, code.toLowerCase(), {
      name: '  Făget   Trail Pack ',
      timezone: 'Europe/Bucharest',
      displayName: ' Alex  Creator ',
      requestId,
    });

    expect(result).toMatchObject({ ok: true, already_created: false });
    const community = await admin.query('select name, timezone from public.communities where id = $1', [
      result.community_id,
    ]);
    expect(community.rows).toEqual([{ name: 'Făget Trail Pack', timezone: 'Europe/Bucharest' }]);
    const memberships = await admin.query(
      'select id, community_id, role, status from public.memberships where user_id = $1',
      [userId],
    );
    expect(memberships.rows).toEqual([
      { id: result.membership_id, community_id: result.community_id, role: 'organizer', status: 'active' },
    ]);
    const profile = await admin.query('select display_name from public.profiles where id = $1', [userId]);
    expect(profile.rows).toEqual([{ display_name: 'Alex Creator' }]);
    const redemptions = await admin.query(
      'select user_id, community_id, membership_id, request_id from public.community_creator_redemptions',
    );
    expect(redemptions.rows).toEqual([
      { user_id: userId, community_id: result.community_id, membership_id: result.membership_id, request_id: requestId },
    ]);
    expect((await codeRow(code)).use_count).toBe(1);
    expect(await countRows('invitation_attempts', 'user_id = $1 and success', [userId])).toBe(1);

    // The new organizer can work in the community right away.
    const visible = await asUser(userId, (db) => db.query('select id from public.communities'));
    expect(visible.rows).toEqual([{ id: result.community_id }]);
    const invitation = await asUser(userId, (db) => rpcRow<{ role: string }>(db, 'create_invitation', [result.community_id]));
    expect(invitation.role).toBe('member');
    const session = await createTraining(userId, result.community_id!);
    expect(session.community_id).toBe(result.community_id);

    // The single use is gone.
    expect(await createWithCode(await createUser(), code)).toEqual({ ok: false, error: 'exhausted' });
    expect(await countRows('communities')).toBe(1);
  });

  it('updates the display name of an existing profile', async () => {
    const { communityId } = await createCommunity();
    const userId = await addMember(communityId, { name: 'Old Name' });
    const { code } = await issueCode();
    expect(await createWithCode(userId, code, { displayName: 'New Name' })).toMatchObject({ ok: true });
    const profile = await admin.query('select display_name from public.profiles where id = $1', [userId]);
    expect(profile.rows).toEqual([{ display_name: 'New Name' }]);
  });

  it('serves max_uses communities from one code, then exhausted', async () => {
    const { code } = await issueCode({ maxUses: 2 });
    expect(await createWithCode(await createUser(), code)).toMatchObject({ ok: true });
    expect(await createWithCode(await createUser(), code)).toMatchObject({ ok: true });
    const third = await createUser();
    expect(await createWithCode(third, code)).toEqual({ ok: false, error: 'exhausted' });
    expect(await failedAttempts(third)).toBe(1);
    expect(await countRows('communities')).toBe(2);
  });

  it('refuses invalid, revoked and expired codes, records the failure and creates nothing', async () => {
    const userId = await createUser();
    const revoked = await issueCode();
    await asService((db) => rpc(db, 'admin_revoke_creator_code', [revoked.code]));
    const expired = await issueCode();
    await admin.query(
      "update public.community_creator_codes set expires_at = now() - interval '1 second' where code = $1",
      [expired.code],
    );

    expect(await createWithCode(userId, 'NOPE2222')).toEqual({ ok: false, error: 'invalid_code' });
    expect(await createWithCode(userId, null)).toEqual({ ok: false, error: 'invalid_code' });
    expect(await createWithCode(userId, revoked.code)).toEqual({ ok: false, error: 'revoked' });
    expect(await createWithCode(userId, expired.code)).toEqual({ ok: false, error: 'expired' });
    expect(await failedAttempts(userId)).toBe(4);
    expect(await countRows('communities')).toBe(0);
    expect(await countRows('profiles')).toBe(0);
    expect(await countRows('memberships')).toBe(0);
  });

  it('validates name, timezone, display name and request id without counting an attempt or using the code', async () => {
    const { code } = await issueCode();
    const userId = await createUser();
    const cases: [Parameters<typeof createWithCode>[2], string][] = [
      [{ name: '' }, 'validation_failed:name'],
      [{ name: '   ' }, 'validation_failed:name'],
      [{ name: null }, 'validation_failed:name'],
      [{ name: '​⁠ ' }, 'validation_failed:name'],
      [{ name: '\u0007‮' }, 'validation_failed:name'],
      [{ name: 'x'.repeat(81) }, 'validation_failed:name'],
      [{ timezone: 'Mars/Olympus_Mons' }, 'validation_failed:timezone'],
      [{ timezone: 'EST' }, 'validation_failed:timezone'],
      [{ timezone: 'Factory' }, 'validation_failed:timezone'],
      [{ timezone: 'posix/Europe/Bucharest' }, 'validation_failed:timezone'],
      [{ timezone: 'europe/bucharest' }, 'validation_failed:timezone'],
      [{ timezone: null }, 'validation_failed:timezone'],
      [{ displayName: 'A' }, 'validation_failed:display_name'],
      [{ displayName: 'x'.repeat(41) }, 'validation_failed:display_name'],
      [{ displayName: null }, 'validation_failed:display_name'],
      [{ requestId: null }, 'validation_failed:request_id'],
    ];
    for (const [input, error] of cases) {
      expect(await createWithCode(userId, code, input), error).toEqual({ ok: false, error });
    }
    expect(await failedAttempts(userId)).toBe(0);
    expect(await countRows('invitation_attempts')).toBe(0);
    expect((await codeRow(code)).use_count).toBe(0);
    expect(await countRows('communities')).toBe(0);

    // Control and bidi characters are stripped, whitespace collapsed; 80 characters fit.
    const ok = await createWithCode(userId, code, { name: 'Trail\u0007 ‮Pack\t 2026', timezone: 'UTC' });
    expect(ok).toMatchObject({ ok: true });
    const stored = await admin.query('select name, timezone from public.communities');
    expect(stored.rows).toEqual([{ name: 'Trail Pack 2026', timezone: 'UTC' }]);
    const long = await issueCode();
    expect(await createWithCode(userId, long.code, { name: 'y'.repeat(80) })).toMatchObject({ ok: true });
  });

  it('is idempotent per request id: a retry returns the first result, even once the code is used up or revoked', async () => {
    const { code } = await issueCode({ maxUses: 1 });
    const userId = await createUser();
    const requestId = randomUUID();

    const first = await createWithCode(userId, code, { requestId });
    expect(first).toMatchObject({ ok: true, already_created: false });
    const retry = await createWithCode(userId, code, { requestId });
    expect(retry).toEqual({
      ok: true,
      community_id: first.community_id,
      membership_id: first.membership_id,
      already_created: true,
    });
    await asService((db) => rpc(db, 'admin_revoke_creator_code', [code]));
    expect(await createWithCode(userId, code, { requestId })).toEqual(retry);

    expect(await countRows('communities')).toBe(1);
    expect(await countRows('memberships')).toBe(1);
    expect((await codeRow(code)).use_count).toBe(1);
    expect(await failedAttempts(userId)).toBe(0);

    // A NEW request from the same user is a new community, and the code is gone.
    expect(await createWithCode(userId, code)).toEqual({ ok: false, error: 'revoked' });
    // Another user's request with the same id is not a replay of this one.
    const other = await createUser();
    const fresh = await issueCode();
    const theirs = await createWithCode(other, fresh.code, { requestId });
    expect(theirs).toMatchObject({ ok: true, already_created: false });
    expect(theirs.community_id).not.toBe(first.community_id);
  });

  it('lets one user create at most 5 communities', async () => {
    const { code } = await issueCode({ maxUses: 10 });
    const userId = await createUser();
    // An organizer role obtained by invitation does not count toward the limit.
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'XRGA2222', { role: 'organizer' });
    expect(await redeemInvitation(userId, 'XRGA2222')).toMatchObject({ ok: true, role: 'organizer' });

    for (let i = 1; i <= 5; i += 1) {
      expect(await createWithCode(userId, code, { name: `Pack ${i}` }), `community ${i}`).toMatchObject({ ok: true });
    }
    expect(await createWithCode(userId, code, { name: 'Pack 6' })).toEqual({
      ok: false,
      error: 'community_limit_reached',
    });
    expect(await failedAttempts(userId)).toBe(0);
    expect((await codeRow(code)).use_count).toBe(5);
    expect(await countRows('memberships', "user_id = $1 and role = 'organizer'", [userId])).toBe(6);

    // The limit is per user.
    expect(await createWithCode(await createUser(), code)).toMatchObject({ ok: true });
  });

  it('answers not_authenticated without a user, and is denied to anon and service_role', async () => {
    const { code } = await issueCode();
    const args = [code, 'Pack', 'UTC', 'Alex Creator', randomUUID()];
    expect(await asNobody((db) => rpc(db, 'create_community_with_code', args))).toEqual({
      ok: false,
      error: 'not_authenticated',
    });
    await expect(asAnon((db) => rpc(db, 'create_community_with_code', args))).rejects.toMatchObject(denied);
    await expect(asService((db) => rpc(db, 'create_community_with_code', args))).rejects.toMatchObject(denied);
    expect(await countRows('communities')).toBe(0);
  });

  it('keeps admin_create_community working as the first-organizer bootstrap', async () => {
    const result = await asService((db) =>
      rpc<{ community_id: string; organizer_code: string }>(db, 'admin_create_community', ['Bootstrap Pack', 'UTC']),
    );
    const userId = await createUser();
    expect(await redeemInvitation(userId, result.organizer_code)).toMatchObject({
      ok: true,
      community_id: result.community_id,
      role: 'organizer',
    });
  });
});

describe('update_community', () => {
  it('renames and changes the time zone; existing sessions keep their own zone and instants', async () => {
    const { communityId, organizerId } = await createPack();
    const before = await createTraining(organizerId, communityId);
    expect(before.timezone).toBe('Europe/Bucharest');

    const row = await updateCommunity(organizerId, communityId, '  New\u0007  Name ', 'America/New_York');
    expect(row).toMatchObject({ id: communityId, name: 'New Name', timezone: 'America/New_York' });

    const after = await admin.query('select timezone, starts_at, rsvp_deadline from public.training_sessions where id = $1', [
      before.id,
    ]);
    expect(after.rows).toEqual([
      { timezone: 'Europe/Bucharest', starts_at: before.starts_at, rsvp_deadline: before.rsvp_deadline },
    ]);

    // New trainings default to the new zone.
    const created = await createTraining(organizerId, communityId, { timezone: undefined });
    expect(created.timezone).toBe('America/New_York');

    // Statistics are computed in the community's current zone.
    const stats = await asUser(organizerId, (db) =>
      rpc<{ timezone: string }>(db, 'get_community_statistics', [communityId, 'all']),
    );
    expect(stats.timezone).toBe('America/New_York');
  });

  it('returns the row unchanged when nothing changes', async () => {
    const { communityId, organizerId } = await createPack();
    const row = await updateCommunity(organizerId, communityId, 'Test Pack', 'Europe/Bucharest');
    expect(row).toMatchObject({ id: communityId, name: 'Test Pack', timezone: 'Europe/Bucharest' });
  });

  it('validates the name and the time zone', async () => {
    const { communityId, organizerId } = await createPack();
    const cases: [string | null, string | null, string][] = [
      ['', 'UTC', 'validation_failed:name'],
      [null, 'UTC', 'validation_failed:name'],
      ['​', 'UTC', 'validation_failed:name'],
      ['x'.repeat(81), 'UTC', 'validation_failed:name'],
      ['Pack', 'Mars/Base', 'validation_failed:timezone'],
      ['Pack', 'EST', 'validation_failed:timezone'],
      ['Pack', null, 'validation_failed:timezone'],
    ];
    for (const [name, timezone, error] of cases) {
      await expect(updateCommunity(organizerId, communityId, name, timezone), error).rejects.toMatchObject(raised(error));
    }
    const stored = await admin.query('select name, timezone from public.communities where id = $1', [communityId]);
    expect(stored.rows).toEqual([{ name: 'Test Pack', timezone: 'Europe/Bucharest' }]);
  });

  it('is forbidden to members, other organizers, removed or demoted organizers, outsiders and unknown ids', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const other = await createPack();
    const removedOrganizer = await addMember(communityId, { role: 'organizer', status: 'removed' });
    const outsider = await createUser();
    const forbidden = raised('forbidden');

    await expect(updateCommunity(memberIds[0], communityId, 'Hijack', 'UTC')).rejects.toMatchObject(forbidden);
    await expect(updateCommunity(other.organizerId, communityId, 'Hijack', 'UTC')).rejects.toMatchObject(forbidden);
    await expect(updateCommunity(removedOrganizer, communityId, 'Hijack', 'UTC')).rejects.toMatchObject(forbidden);
    await expect(updateCommunity(outsider, communityId, 'Hijack', 'UTC')).rejects.toMatchObject(forbidden);
    await expect(updateCommunity(organizerId, randomUUID(), 'Hijack', 'UTC')).rejects.toMatchObject(forbidden);
    await expect(updateCommunity(organizerId, null, 'Hijack', 'UTC')).rejects.toMatchObject(forbidden);
    // Authorization comes before validation: bad input from a non-organizer is still forbidden.
    await expect(updateCommunity(memberIds[0], communityId, '', 'Mars/Base')).rejects.toMatchObject(forbidden);

    await admin.query("update public.memberships set role = 'member' where user_id = $1", [organizerId]);
    await expect(updateCommunity(organizerId, communityId, 'Hijack', 'UTC')).rejects.toMatchObject(forbidden);

    await expect(
      asNobody((db) => rpcRow(db, 'update_community', [communityId, 'Hijack', 'UTC'])),
    ).rejects.toMatchObject(raised('not_authenticated'));
    await expect(
      asAnon((db) => rpcRow(db, 'update_community', [communityId, 'Hijack', 'UTC'])),
    ).rejects.toMatchObject(denied);
    await expect(
      asService((db) => rpcRow(db, 'update_community', [communityId, 'Hijack', 'UTC'])),
    ).rejects.toMatchObject(denied);

    const stored = await admin.query('select name from public.communities where id = $1', [communityId]);
    expect(stored.rows).toEqual([{ name: 'Test Pack' }]);
  });
});

describe('list_my_communities', () => {
  it('is empty without memberships, raises without a user, and is denied to anon and service_role', async () => {
    expect(await listMyCommunities(await createUser())).toEqual([]);
    await expect(asNobody((db) => rpc(db, 'list_my_communities'))).rejects.toMatchObject(raised('not_authenticated'));
    await expect(asAnon((db) => rpc(db, 'list_my_communities'))).rejects.toMatchObject(denied);
    await expect(asService((db) => rpc(db, 'list_my_communities'))).rejects.toMatchObject(denied);
  });
});

describe('creator code tables', () => {
  it('have RLS on, no policy, and no privilege for any API role', async () => {
    const tables = ['community_creator_codes', 'community_creator_redemptions'];
    const rls = await admin.query<{ relname: string; relrowsecurity: boolean }>(
      'select relname, relrowsecurity from pg_class where oid = any($1::regclass[]) order by 1',
      [tables.map((t) => `public.${t}`)],
    );
    expect(rls.rows).toEqual(tables.map((relname) => ({ relname, relrowsecurity: true })));
    const policies = await admin.query('select policyname from pg_policies where tablename = any($1)', [tables]);
    expect(policies.rows).toEqual([]);
    const privileges = await admin.query(
      `select r.role, t.name, p.privilege
       from unnest(array['anon', 'authenticated', 'service_role']) as r(role),
            unnest($1::text[]) as t(name),
            unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege)
       where has_table_privilege(r.role, 'public.' || t.name, p.privilege)
          or (p.privilege in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
              and has_any_column_privilege(r.role, 'public.' || t.name, p.privilege))`,
      [tables],
    );
    expect(privileges.rows).toEqual([]);
  });

  it('cannot be read or written by a creator, an organizer, anon or service_role', async () => {
    const { code } = await issueCode();
    const creator = await createUser();
    expect(await createWithCode(creator, code)).toMatchObject({ ok: true });
    const { organizerId } = await createPack();
    const statements = (table: string) => [
      `select * from public.${table}`,
      `insert into public.${table} default values`,
      `update public.${table} set id = id`,
      `delete from public.${table}`,
    ];
    for (const table of ['community_creator_codes', 'community_creator_redemptions']) {
      for (const sql of statements(table)) {
        for (const userId of [creator, organizerId]) {
          await expect(asUser(userId, (db) => db.query(sql)), sql).rejects.toMatchObject(denied);
        }
        await expect(asAnon((db) => db.query(sql)), sql).rejects.toMatchObject(denied);
        await expect(asService((db) => db.query(sql)), sql).rejects.toMatchObject(denied);
      }
    }
    expect(await countRows('community_creator_codes')).toBe(1);
    expect(await countRows('community_creator_redemptions')).toBe(1);
  });
});
