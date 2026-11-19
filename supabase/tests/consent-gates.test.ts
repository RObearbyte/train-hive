import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createWithCode, failedAttempts, issueCode, previewCode } from './creator-codes-helpers';
import {
  addMember,
  admin,
  asService,
  asUser,
  closeDb,
  countRows,
  createCommunity,
  createUser,
  grantConsents,
  insertInvitation,
  RAISED,
  resetData,
  rpc,
  rpcRow,
} from './helpers';
import { expoToken } from './notifications-helpers';

/**
 * GDPR G1 gates: joining a community (redeem_invitation, create_community_with_code) needs current
 * terms_privacy and age_16 consent; registering a push token needs push_notifications consent;
 * withdrawing push consent removes the caller's tokens.
 */

type Joined = { ok: boolean; error?: string; community_id?: string };

const raised = (message: string) => ({ code: RAISED, message });

const redeem = (userId: string, code: string, name = 'Ana Runner') =>
  asUser(userId, (db) => rpc<Joined>(db, 'redeem_invitation', [code, name]));
const record = (userId: string, purpose: string, version: string | null = null) =>
  asUser(userId, (db) => rpc(db, 'record_consent', [purpose, version]));
const withdraw = (userId: string, purpose: string) =>
  asUser(userId, (db) => rpc<{ changed: boolean }>(db, 'withdraw_consent', [purpose]));
const register = (userId: string, token: string) =>
  asUser(userId, (db) => rpcRow(db, 'register_push_token', [token, 'android', null]));

beforeEach(resetData);
afterAll(closeDb);

describe('join gate: redeem_invitation', () => {
  it('refuses a user without consent before touching the code, the limiter or the profile', async () => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'GATEKEEP', { maxRedemptions: 1 });
    const user = await createUser({ consent: false });

    expect(await redeem(user, 'GATEKEEP')).toEqual({ ok: false, error: 'consent_required' });
    // A wrong code gives the same answer and is not counted as a failed attempt.
    for (let i = 0; i < 7; i += 1) {
      expect(await redeem(user, 'WRONG999')).toEqual({ ok: false, error: 'consent_required' });
    }
    expect(await countRows('invitation_attempts', 'user_id = $1', [user])).toBe(0);
    expect(await countRows('profiles', 'id = $1', [user])).toBe(0);
    expect(await countRows('memberships', 'user_id = $1', [user])).toBe(0);
    const { rows } = await admin.query("select redemption_count from public.invitation_codes where code = 'GATEKEEP'");
    expect(rows[0].redemption_count).toBe(0);

    // Previewing stays open (it only reveals the community name).
    expect(await asUser(user, (db) => rpc(db, 'preview_invitation', ['GATEKEEP']))).toMatchObject({ ok: true });
  });

  it('needs both terms_privacy and age_16; then joins', async () => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'BTHGATE2');
    const user = await createUser({ consent: false });

    await record(user, 'terms_privacy', 'terms:1|privacy:1');
    expect(await redeem(user, 'BTHGATE2')).toEqual({ ok: false, error: 'consent_required' });

    const ageOnly = await createUser({ consent: false });
    await record(ageOnly, 'age_16');
    expect(await redeem(ageOnly, 'BTHGATE2')).toEqual({ ok: false, error: 'consent_required' });

    await record(user, 'age_16');
    expect(await redeem(user, 'BTHGATE2')).toMatchObject({ ok: true, community_id: communityId });
    // Optional consents are not required to join.
    expect(await countRows('consent_records', "user_id = $1 and purpose not in ('terms_privacy', 'age_16')", [user])).toBe(0);
  });

  it('a version bump gates new joins until the new version is accepted; existing members keep using the app', async () => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'BMPJ2345');
    const member = await addMember(communityId);
    const user = await createUser();

    await asService((db) => rpc(db, 'admin_set_legal_version', ['terms', '2']));
    expect(await redeem(user, 'BMPJ2345')).toEqual({ ok: false, error: 'consent_required' });
    // Already an active member: re-redeeming is a join attempt too and is gated the same way.
    expect(await redeem(member, 'BMPJ2345')).toEqual({ ok: false, error: 'consent_required' });
    // The existing member is not blocked from the app itself.
    expect(await asUser(member, (db) => rpc(db, 'list_my_communities'))).toHaveLength(1);

    await record(user, 'terms_privacy', 'terms:2|privacy:1');
    expect(await redeem(user, 'BMPJ2345')).toMatchObject({ ok: true });
  });

  it('an existing member from before G1 (no records at all) is gated on joins only', async () => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'XTMR2345');
    const legacy = await createUser({ consent: false });
    await admin.query('insert into public.profiles (id, display_name) values ($1, $2)', [legacy, 'Legacy']);
    await admin.query('insert into public.memberships (community_id, user_id, role) values ($1, $2, $3)', [
      communityId,
      legacy,
      'member',
    ]);
    expect(await asUser(legacy, (db) => rpc<unknown[]>(db, 'list_my_communities'))).toHaveLength(1);
    expect(await redeem(legacy, 'XTMR2345')).toEqual({ ok: false, error: 'consent_required' });
    expect((await asUser(legacy, (db) => rpc<{ needs_terms_acceptance: boolean }>(db, 'my_consents'))).needs_terms_acceptance).toBe(true);
  });
});

describe('join gate: create_community_with_code', () => {
  it('refuses without consent before the request id, the limiter and the code', async () => {
    const issued = await issueCode();
    const user = await createUser({ consent: false });

    expect(await createWithCode(user, issued.code)).toEqual({ ok: false, error: 'consent_required' });
    expect(await createWithCode(user, issued.code, { requestId: null })).toEqual({ ok: false, error: 'consent_required' });
    for (let i = 0; i < 6; i += 1) {
      expect(await createWithCode(user, 'WRONG999')).toEqual({ ok: false, error: 'consent_required' });
    }
    expect(await failedAttempts(user)).toBe(0);
    const { rows } = await admin.query('select use_count from public.community_creator_codes where code = $1', [issued.code]);
    expect(rows[0].use_count).toBe(0);
    expect(await countRows('communities')).toBe(0);

    // Previewing stays open.
    expect(await previewCode(user, issued.code)).toEqual({ ok: true });

    await grantConsents(user, ['terms_privacy', 'age_16']);
    expect(await createWithCode(user, issued.code)).toMatchObject({ ok: true, already_created: false });
  });

  it('a version bump gates community creation too', async () => {
    const issued = await issueCode();
    const user = await createUser();
    await asService((db) => rpc(db, 'admin_set_legal_version', ['privacy', '2']));
    expect(await createWithCode(user, issued.code)).toEqual({ ok: false, error: 'consent_required' });
    await record(user, 'terms_privacy', 'terms:1|privacy:2');
    expect(await createWithCode(user, issued.code)).toMatchObject({ ok: true });
  });
});

describe('push consent', () => {
  it('register_push_token requires push_notifications consent', async () => {
    const { communityId } = await createCommunity();
    const user = await addMember(communityId);
    await expect(register(user, expoToken('p1'))).rejects.toMatchObject(raised('consent_required'));
    expect(await countRows('device_push_tokens')).toBe(0);

    await record(user, 'push_notifications');
    expect(await register(user, expoToken('p1'))).toMatchObject({ user_id: user });

    // No profile yet: not_a_member still comes first.
    const stranger = await createUser();
    await record(stranger, 'push_notifications');
    await expect(register(stranger, expoToken('p2'))).rejects.toMatchObject(raised('not_a_member'));
    const noConsentStranger = await createUser();
    await expect(register(noConsentStranger, expoToken('p3'))).rejects.toMatchObject(raised('not_a_member'));
  });

  it('withdrawing push consent removes the caller’s tokens only, and blocks new registrations', async () => {
    const { communityId } = await createCommunity();
    const [ana, bob] = [await addMember(communityId), await addMember(communityId)];
    await record(ana, 'push_notifications');
    await record(bob, 'push_notifications');
    await register(ana, expoToken('ana-1'));
    await register(ana, expoToken('ana-2'));
    await register(bob, expoToken('bob-1'));

    expect(await withdraw(ana, 'push_notifications')).toMatchObject({ changed: true });
    expect(await countRows('device_push_tokens', 'user_id = $1', [ana])).toBe(0);
    expect(await countRows('device_push_tokens', 'user_id = $1', [bob])).toBe(1);
    await expect(register(ana, expoToken('ana-3'))).rejects.toMatchObject(raised('consent_required'));

    await record(ana, 'push_notifications');
    expect(await register(ana, expoToken('ana-3'))).toMatchObject({ user_id: ana });
  });

  it('concurrent registrations and a withdrawal never leave a token without consent', async () => {
    const { communityId } = await createCommunity();
    const user = await addMember(communityId);
    for (let round = 0; round < 4; round += 1) {
      await record(user, 'push_notifications');
      const outcomes = await Promise.allSettled([
        register(user, expoToken(`r${round}-a`)),
        withdraw(user, 'push_notifications'),
        register(user, expoToken(`r${round}-b`)),
        register(user, expoToken(`r${round}-c`)),
      ]);
      for (const o of outcomes) {
        if (o.status === 'rejected') expect(o.reason).toMatchObject(raised('consent_required'));
      }
      // The withdrawal is the latest event, so no token may remain.
      expect(await countRows('device_push_tokens', 'user_id = $1', [user]), `round ${round}`).toBe(0);
    }
  });
});
