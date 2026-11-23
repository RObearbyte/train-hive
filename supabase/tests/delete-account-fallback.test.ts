import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  bearerToken,
  handleDeleteAccount,
  RpcFailure,
  type DeleteAccountDeps,
  type DeletionBlockers,
} from '../functions/delete-account/deleteAccount';
import { buildFullLife, deleteMyAccount, referencesTo } from './account-deletion-helpers';
import {
  addMember,
  admin,
  asAnon,
  asService,
  asUser,
  closeDb,
  countRows,
  createPack,
  createUser,
  INSUFFICIENT_PRIVILEGE,
  RAISED,
  resetData,
  rpc,
} from './helpers';

/**
 * GDPR G2 fallback: the Edge Function `delete-account` (deleteAccount.ts, the pure handler) against
 * the real database functions. Supabase Auth is not part of the embedded harness, so two edges are
 * stand-ins: `verifyUser` maps test tokens to user ids (Auth's token check), and `deleteAuthUser`
 * is the hard delete of the `auth.users` row that `auth.admin.deleteUser` performs. Everything in
 * between (my_deletion_blockers as the caller, admin_erase_user_data as service_role) is real.
 */

beforeEach(resetData);
afterAll(closeDb);

interface PgError {
  code?: string;
  message: string;
  detail?: string;
}

const tokenOf = (userId: string) => `test-token-${userId}`;

/** A pg error from a real RPC, as supabase-js reports it (message = code, details = DETAIL). */
function asRpcFailure(error: unknown): never {
  const e = error as PgError;
  throw new RpcFailure({ message: e.message, details: e.detail ?? null });
}

function realDeps(overrides: Partial<DeleteAccountDeps> = {}): DeleteAccountDeps & { deletedAuthUsers: string[] } {
  const deletedAuthUsers: string[] = [];
  return {
    deletedAuthUsers,
    async verifyUser(accessToken) {
      const match = /^test-token-([0-9a-f-]{36})$/.exec(accessToken);
      return match ? match[1] : null;
    },
    async deletionBlockers(accessToken) {
      const userId = accessToken.replace('test-token-', '');
      return asUser(userId, (db) => rpc<DeletionBlockers>(db, 'my_deletion_blockers')).catch(asRpcFailure);
    },
    async eraseUserData(userId) {
      return asService((db) => rpc(db, 'admin_erase_user_data', [userId])).catch(asRpcFailure);
    },
    async deleteAuthUser(userId) {
      await admin.query('delete from auth.users where id = $1', [userId]);
      deletedAuthUsers.push(userId);
    },
    ...overrides,
  };
}

function request(token: string | null, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers ?? {}) };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request('https://example.test/functions/v1/delete-account', {
    method: init.method ?? 'POST',
    headers,
    body: init.method === 'GET' ? undefined : JSON.stringify(init.body ?? {}),
  });
}

async function authUserExists(userId: string): Promise<boolean> {
  const { rows } = await admin.query('select 1 from auth.users where id = $1', [userId]);
  return rows.length > 0;
}

/** Tables whose rows go with the auth user's cascade (foreign key to auth.users ON DELETE CASCADE). */
async function cascadingFromAuthUsers(): Promise<Set<string>> {
  const { rows } = await admin.query<{ ref: string }>(
    `select n.nspname || '.' || c.relname || '.' || a.attname as ref
     from pg_constraint k
     join pg_class c on c.oid = k.conrelid
     join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
     where k.contype = 'f' and k.confrelid = 'auth.users'::regclass and k.confdeltype = 'c'`,
  );
  return new Set(rows.map((r) => r.ref));
}

describe('bearerToken', () => {
  it('reads only a well-formed Bearer header', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('  Bearer   abc  ')).toBe('abc');
    for (const bad of [null, undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'abc', 'Bearer a b']) {
      expect(bearerToken(bad), String(bad)).toBeNull();
    }
  });
});

describe('delete-account fallback: the happy path', () => {
  it('erases a full-life member exactly like delete_my_account, then the auth user; nothing refers to them', async () => {
    const life = await buildFullLife();
    const { victim } = life;
    const deps = realDeps();

    const response = await handleDeleteAccount(request(tokenOf(victim)), deps);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, user_id: victim, memberships_deleted: 5 });
    expect(deps.deletedAuthUsers).toEqual([victim]);
    expect(await referencesTo(victim)).toEqual({});
    // The other members of the fixture are still there.
    expect(await authUserExists(life.alpha.organizerId)).toBe(true);
  });

  it('before the auth delete, only rows that cascade from auth.users are left (consent ledger, activity)', async () => {
    const life = await buildFullLife();
    const { victim } = life;
    const summary = await asService((db) => rpc(db, 'admin_erase_user_data', [victim]));
    expect(summary).toMatchObject({ user_id: victim, memberships_deleted: 5 });

    const left = Object.keys(await referencesTo(victim));
    const cascading = await cascadingFromAuthUsers();
    expect(left).toContain('auth.users.id');
    expect(left).toContain('public.consent_records.user_id');
    expect(left.filter((ref) => ref !== 'auth.users.id' && !cascading.has(ref))).toEqual([]);
    expect(await countRows('profiles', 'id = $1', [victim])).toBe(0);

    // What auth.admin.deleteUser does in the database: the consent ledger guard lets the cascade through.
    await admin.query('delete from auth.users where id = $1', [victim]);
    expect(await referencesTo(victim)).toEqual({});
  });

  it('delete_my_account (one-argument erase_user) still deletes the auth user itself', async () => {
    const { memberIds } = await createPack(1);
    await deleteMyAccount(memberIds[0]);
    expect(await authUserExists(memberIds[0])).toBe(false);
  });
});

describe('delete-account fallback: identity comes only from the verified token', () => {
  it('ignores a user id in the body, the query string and other headers', async () => {
    const { communityId, memberIds } = await createPack(2);
    const [caller, other] = memberIds;
    const deps = realDeps();

    const req = new Request(`https://example.test/functions/v1/delete-account?user_id=${other}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenOf(caller)}`, 'x-user-id': other, 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: other, p_user_id: other }),
    });
    const response = await handleDeleteAccount(req, deps);

    expect(response.status).toBe(200);
    expect(response.body.user_id).toBe(caller);
    expect(deps.deletedAuthUsers).toEqual([caller]);
    expect(await authUserExists(other)).toBe(true);
    expect(await countRows('memberships', 'user_id = $1 and community_id = $2', [other, communityId])).toBe(1);
  });

  it('refuses a missing or rejected token without touching anything', async () => {
    const { memberIds } = await createPack(1);
    const [member] = memberIds;
    let erased = 0;
    const deps = realDeps({
      async eraseUserData() {
        erased += 1;
        return {};
      },
    });

    for (const req of [
      request(null),
      request('not-a-test-token'),
      request(null, { headers: { authorization: `Basic ${tokenOf(member)}` } }),
      request(null, { body: { user_id: member } }),
    ]) {
      const response = await handleDeleteAccount(req, deps);
      expect(response).toEqual({ status: 401, body: { error: 'not_authenticated' } });
    }
    expect(erased).toBe(0);
    expect(deps.deletedAuthUsers).toEqual([]);
    expect(await authUserExists(member)).toBe(true);
  });

  it('answers 503 when Auth cannot be reached, and 405 for anything but POST', async () => {
    const { memberIds } = await createPack(1);
    const unreachable = realDeps({
      async verifyUser() {
        throw new Error('fetch failed');
      },
    });
    expect(await handleDeleteAccount(request(tokenOf(memberIds[0])), unreachable)).toEqual({
      status: 503,
      body: { error: 'auth_unavailable' },
    });
    expect(await handleDeleteAccount(request(tokenOf(memberIds[0]), { method: 'GET' }), realDeps())).toEqual({
      status: 405,
      body: { error: 'method_not_allowed' },
    });
    expect(await authUserExists(memberIds[0])).toBe(true);
  });

  it('a token whose user is already deleted answers not_authenticated (my_deletion_blockers)', async () => {
    const { memberIds } = await createPack(1);
    const [member] = memberIds;
    await deleteMyAccount(member);
    const deps = realDeps();
    expect(await handleDeleteAccount(request(tokenOf(member)), deps)).toEqual({
      status: 401,
      body: { error: 'not_authenticated' },
    });
    expect(deps.deletedAuthUsers).toEqual([]);
  });
});

describe('delete-account fallback: the same rules as delete_my_account', () => {
  it('the last organizer of a community with members is refused (409) and nothing is deleted', async () => {
    const { communityId, organizerId } = await createPack(2);
    const before = await referencesTo(organizerId);
    const deps = realDeps();

    const response = await handleDeleteAccount(request(tokenOf(organizerId)), deps);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'last_organizer',
      details: { communities: [{ community_id: communityId, name: expect.any(String), active_members: 3 }] },
    });
    expect(deps.deletedAuthUsers).toEqual([]);
    expect(await referencesTo(organizerId)).toEqual(before);
  });

  it('the erasure re-checks under its locks: a stale "can delete" still ends in 409 with the details', async () => {
    const { communityId, organizerId } = await createPack(1);
    const before = await referencesTo(organizerId);
    // As if a member joined between the blockers check and the erasure.
    const deps = realDeps({
      async deletionBlockers() {
        return { can_delete: true, last_organizer: [] };
      },
    });

    const response = await handleDeleteAccount(request(tokenOf(organizerId)), deps);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: 'last_organizer',
      details: { communities: [{ community_id: communityId, active_members: 2 }] },
    });
    expect(deps.deletedAuthUsers).toEqual([]);
    expect(await referencesTo(organizerId)).toEqual(before);
  });

  it('a co-organizer can delete; the community stays with the other organizer', async () => {
    const { communityId, organizerId } = await createPack(1);
    const second = await addMember(communityId, { role: 'organizer' });
    const response = await handleDeleteAccount(request(tokenOf(organizerId)), realDeps());
    expect(response.status).toBe(200);
    expect(await countRows('memberships', 'community_id = $1 and user_id = $2', [communityId, second])).toBe(1);
  });
});

describe('delete-account fallback: failures and retries', () => {
  it('a failed auth delete leaves the data erased and the auth user; a retry with the same token finishes', async () => {
    const life = await buildFullLife();
    const { victim } = life;
    const failing = realDeps({
      async deleteAuthUser() {
        throw new Error('auth_delete_failed');
      },
    });

    const first = await handleDeleteAccount(request(tokenOf(victim)), failing);
    expect(first).toEqual({ status: 500, body: { error: 'auth_delete_failed', data_erased: true, retry: true } });
    expect(await authUserExists(victim)).toBe(true);
    expect(await countRows('profiles', 'id = $1', [victim])).toBe(0);
    expect(await countRows('consent_records', 'user_id = $1', [victim])).toBeGreaterThan(0);

    const deps = realDeps();
    const second = await handleDeleteAccount(request(tokenOf(victim)), deps);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, user_id: victim, memberships_deleted: 0, rsvps_deleted: 0 });
    expect(deps.deletedAuthUsers).toEqual([victim]);
    expect(await referencesTo(victim)).toEqual({});
  });

  it('an unexpected database error is reported as deletion_failed without the auth delete', async () => {
    const { memberIds } = await createPack(1);
    const logged: Record<string, unknown>[] = [];
    const deps = realDeps({
      async eraseUserData() {
        throw new RpcFailure({ message: 'connection reset' });
      },
      log: (event) => logged.push(event),
    });
    expect(await handleDeleteAccount(request(tokenOf(memberIds[0])), deps)).toEqual({
      status: 500,
      body: { error: 'deletion_failed' },
    });
    expect(deps.deletedAuthUsers).toEqual([]);
    expect(logged).toEqual([{ event: 'delete_account_erase_failed', code: 'connection reset' }]);
    // The log never carries the token or the user id.
    expect(JSON.stringify(logged)).not.toContain(memberIds[0]);
  });
});

describe('admin_erase_user_data (SQL)', () => {
  it('is service_role only: authenticated (even for oneself) and anon are denied', async () => {
    const { memberIds } = await createPack(1);
    const [member] = memberIds;
    for (const call of [
      () => asUser(member, (db) => rpc(db, 'admin_erase_user_data', [member])),
      () => asAnon((db) => rpc(db, 'admin_erase_user_data', [member])),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    }
    expect(await countRows('profiles', 'id = $1', [member])).toBe(1);
  });

  it('validates its argument and reports an unknown user as not_found', async () => {
    await expect(asService((db) => rpc(db, 'admin_erase_user_data', [null]))).rejects.toMatchObject({
      code: RAISED,
      message: 'validation_failed:user_id',
    });
    await expect(
      asService((db) => rpc(db, 'admin_erase_user_data', ['00000000-0000-4000-8000-000000000000'])),
    ).rejects.toMatchObject({ code: RAISED, message: 'not_found' });
  });

  it('refuses the last organizer with the same DETAIL as delete_my_account', async () => {
    const { communityId, organizerId } = await createPack(1);
    const error = (await asService((db) => rpc(db, 'admin_erase_user_data', [organizerId])).catch(
      (e: PgError) => e,
    )) as PgError;
    expect(error).toMatchObject({ code: RAISED, message: 'last_organizer' });
    expect(JSON.parse(error.detail ?? '{}')).toEqual({
      communities: [{ community_id: communityId, name: expect.any(String), active_members: 2 }],
    });
  });

  it('a user who never joined anything (consents only) is erased and keeps only the auth row', async () => {
    const user = await createUser();
    const summary = await asService((db) => rpc(db, 'admin_erase_user_data', [user]));
    expect(summary).toMatchObject({ user_id: user, memberships_deleted: 0, communities_deleted: [] });
    expect(await authUserExists(user)).toBe(true);
  });
});
