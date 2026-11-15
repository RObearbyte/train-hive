import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { admin, asUser, closeDb, countRows, createPack, createUser, RAISED, resetData } from './helpers';
import {
  codeRow,
  createWithCode,
  createWithCodeOn,
  type CreatorResult,
  issueCode,
  openUserTransaction,
  updateCommunity,
  waitForLockWaiters,
  withMutatedFunction,
} from './creator-codes-helpers';
import { errorKey } from './qa-helpers';

/**
 * C1: creator codes and update_community under concurrency, plus mutation checks (each breaks
 * ONE rule in the live test database, runs a probe that holds on the pristine schema, and
 * restores the original).
 */

beforeEach(resetData);
afterAll(closeDb);

/** Settles every promise; an unexpected exception is reported as `error:<sqlstate>:<message>`. */
async function settle(promises: Promise<CreatorResult>[]): Promise<string[]> {
  const results = await Promise.allSettled(promises);
  return results.map((r) =>
    r.status === 'fulfilled' ? (r.value.ok ? 'ok' : String(r.value.error)) : `error:${errorKey(r.reason)}`,
  );
}

describe('create_community_with_code concurrency', () => {
  it('8 users redeeming one single-use code in parallel create exactly one community', async () => {
    const { code } = await issueCode({ maxUses: 1 });
    const users = await Promise.all(Array.from({ length: 8 }, () => createUser()));

    const outcomes = await settle(users.map((u, i) => createWithCode(u, code, { name: `Pack ${i}` })));

    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'exhausted')).toHaveLength(7);
    expect(await countRows('communities')).toBe(1);
    expect(await countRows('memberships')).toBe(1);
    expect(await countRows('community_creator_redemptions')).toBe(1);
    expect((await codeRow(code)).use_count).toBe(1);
  });

  it('a 3-use code serves exactly 3 of 8 parallel users', async () => {
    const { code } = await issueCode({ maxUses: 3 });
    const users = await Promise.all(Array.from({ length: 8 }, () => createUser()));
    const outcomes = await settle(users.map((u) => createWithCode(u, code)));
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(3);
    expect(outcomes.filter((o) => o === 'exhausted')).toHaveLength(5);
    expect(await countRows('communities')).toBe(3);
    expect((await codeRow(code)).use_count).toBe(3);
  });

  it('parallel retries of one request create one community and all return it', async () => {
    const { code } = await issueCode({ maxUses: 5 });
    const userId = await createUser();
    const requestId = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => createWithCode(userId, code, { requestId })),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => r.community_id)).size).toBe(1);
    expect(results.filter((r) => r.already_created === false)).toHaveLength(1);
    expect(await countRows('communities')).toBe(1);
    expect((await codeRow(code)).use_count).toBe(1);
  });

  it('parallel distinct requests of one user stop exactly at the community limit', async () => {
    const { code } = await issueCode({ maxUses: 20 });
    const userId = await createUser();
    const outcomes = await settle(Array.from({ length: 8 }, (_, i) => createWithCode(userId, code, { name: `Pack ${i}` })));
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(5);
    expect(outcomes.filter((o) => o === 'community_limit_reached')).toHaveLength(3);
    expect(await countRows('communities')).toBe(5);
    expect((await codeRow(code)).use_count).toBe(5);
  });

  it('re-checks the code after waiting for its row lock (revoked meanwhile)', async () => {
    const { code } = await issueCode({ maxUses: 5 });
    const userId = await createUser();
    const holder = await admin.connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from public.community_creator_codes where code = $1 for update', [code]);
      const pending = createWithCode(userId, code);
      await waitForLockWaiters(1);
      await holder.query('update public.community_creator_codes set revoked_at = now() where code = $1', [code]);
      await holder.query('commit');
      expect(await pending).toEqual({ ok: false, error: 'revoked' });
    } finally {
      holder.release();
    }
    expect(await countRows('communities')).toBe(0);
  });
});

describe('update_community concurrency', () => {
  it('re-checks the organizer after waiting for the community lock (removed meanwhile)', async () => {
    const { communityId, organizerId } = await createPack();
    const holder = await admin.connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from public.communities where id = $1 for update', [communityId]);
      const pending = updateCommunity(organizerId, communityId, 'Renamed', 'Europe/Bucharest');
      await waitForLockWaiters(1);
      await holder.query("update public.memberships set status = 'removed' where user_id = $1", [organizerId]);
      await holder.query('commit');
      await expect(pending).rejects.toMatchObject({ code: RAISED, message: 'forbidden' });
    } finally {
      holder.release();
    }
    const stored = await admin.query('select name from public.communities where id = $1', [communityId]);
    expect(stored.rows).toEqual([{ name: 'Test Pack' }]);
  });

  it('concurrent renames by two organizers serialize (last writer wins, no error)', async () => {
    const { communityId, organizerId } = await createPack();
    const second = await createUser();
    await admin.query("insert into public.profiles (id, display_name) values ($1, 'Second Org')", [second]);
    await admin.query("insert into public.memberships (community_id, user_id, role) values ($1, $2, 'organizer')", [
      communityId,
      second,
    ]);
    const rows = await Promise.all([
      updateCommunity(organizerId, communityId, 'Name A', 'UTC'),
      updateCommunity(second, communityId, 'Name B', 'UTC'),
    ]);
    expect(rows.map((r) => r.name).sort()).toEqual(['Name A', 'Name B']);
    expect(await countRows('communities', "id = $1 and name in ('Name A', 'Name B')", [communityId])).toBe(1);
  });
});

// Mutation checks ------------------------------------------------------------------------------

/**
 * Two users race for one single-use code with a deterministic interleaving: the first holds its
 * finished-but-uncommitted creation open while the second runs into the code. True when the
 * second gets a clean `exhausted` answer (no exception) and one community exists.
 */
async function singleUseCodeIsRaceSafe(): Promise<boolean> {
  const { code } = await issueCode({ maxUses: 1 });
  const first = await createUser();
  const second = await createUser();
  const tx = await openUserTransaction(first);
  let secondOutcome: string;
  try {
    const firstResult = await createWithCodeOn(tx.db, code);
    if (!firstResult.ok) return false;
    const pending = asUser(second, (db) => createWithCodeOn(db, code)).then(
      (r) => (r.ok ? 'ok' : String(r.error)),
      (e: unknown) => `error:${errorKey(e)}`,
    );
    await waitForLockWaiters(1);
    await tx.finish(true);
    secondOutcome = await pending;
  } catch (error) {
    await tx.finish(false).catch(() => undefined);
    throw error;
  }
  return secondOutcome === 'exhausted' && (await countRows('communities')) === 1;
}

const memberCannotUpdateCommunity = async (): Promise<boolean> => {
  const { communityId, memberIds } = await createPack(1);
  try {
    await updateCommunity(memberIds[0], communityId, 'Hijacked', 'Europe/Bucharest');
    return false;
  } catch (error) {
    return errorKey(error) === 'P0001:forbidden';
  }
};

const sixthCommunityIsRefused = async (): Promise<boolean> => {
  const { code } = await issueCode({ maxUses: 10 });
  const userId = await createUser();
  for (let i = 0; i < 5; i += 1) {
    if (!(await createWithCode(userId, code, { timezone: 'UTC' })).ok) return false;
  }
  const sixth = await createWithCode(userId, code, { timezone: 'UTC' });
  return sixth.error === 'community_limit_reached';
};

const CREATE = 'public.create_community_with_code(text, text, text, text, uuid)';
const UPDATE = 'public.update_community(uuid, text, text)';

describe('creator code mutation checks', () => {
  it('skipping the code row lock is noticed', async () => {
    expect(await singleUseCodeIsRaceSafe()).toBe(true);
    await resetData();
    const noticed = await withMutatedFunction(
      CREATE,
      'where cc.code = private.normalize_invitation_code(p_code) for update;',
      'where cc.code = private.normalize_invitation_code(p_code);',
      async () => !(await singleUseCodeIsRaceSafe()),
    );
    expect(noticed).toBe(true);
  });

  it('skipping the organizer check of update_community is noticed', async () => {
    expect(await memberCannotUpdateCommunity()).toBe(true);
    await resetData();
    const noticed = await withMutatedFunction(
      UPDATE,
      'not public.is_organizer(p_community_id)',
      'not public.is_active_member(p_community_id)',
      () =>
        withMutatedFunction(UPDATE, "and m.role = 'organizer'", 'and true', async () => !(await memberCannotUpdateCommunity())),
    );
    expect(noticed).toBe(true);
  });

  it('skipping the community limit is noticed', async () => {
    expect(await sixthCommunityIsRefused()).toBe(true);
    await resetData();
    const noticed = await withMutatedFunction(
      CREATE,
      'if v_owned >= c_max_communities then',
      'if false then',
      async () => !(await sixthCommunityIsRefused()),
    );
    expect(noticed).toBe(true);
  });
});
