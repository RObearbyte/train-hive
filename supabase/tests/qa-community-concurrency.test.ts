import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addMember,
  admin,
  asService,
  asUser,
  closeDb,
  countRows,
  createCommunity,
  createPack,
  createTraining,
  createUser,
  insertInvitation,
  resetData,
  rpc,
  rpcRow,
} from './helpers';
import {
  type CommunityRow,
  createWithCode,
  issueCode,
  openUserTransaction,
  previewCode,
  updateCommunity,
} from './creator-codes-helpers';
import { Outcomes, sleep } from './qa-helpers';

/**
 * C-Q1: community editing and creation under concurrency. Every operation here is a separate
 * connection, as a separate API request would be. Unexpected errors (deadlock 40P01,
 * serialization failures, constraint violations) must not appear.
 */

beforeEach(resetData);
afterAll(closeDb);

const ZONES = ['Europe/Bucharest', 'America/New_York', 'Asia/Kolkata', 'UTC'];

/** True when `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const marker = Symbol('late');
  const winner = await Promise.race([promise.then(() => 'done' as const, () => 'done' as const), sleep(ms).then(() => marker)]);
  return winner === 'done';
}

describe('update_community racing with the rest of the community', () => {
  it('renames and zone changes mixed with trainings, joins, removals and statistics: no deadlock, no torn row', async () => {
    const { communityId, organizerId, memberIds } = await createPack(4);
    const second = await addMember(communityId, { role: 'organizer', name: 'Second Organizer' });
    await insertInvitation(communityId, 'XRGQ6666');
    const outcomes = new Outcomes();
    const allowed = /^P0001:(validation_failed:.*)$/;
    const submitted = new Map<string, string>();

    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i += 1) {
      const name = `Race ${i}`;
      const zone = ZONES[i % ZONES.length];
      submitted.set(name, zone);
      const actor = i % 2 === 0 ? organizerId : second;
      ops.push(outcomes.run('rename', allowed, () => updateCommunity(actor, communityId, name, zone)));
    }
    for (let i = 0; i < 8; i += 1) {
      ops.push(outcomes.run('training', allowed, () => createTraining(organizerId, communityId, { title: `Run ${i}` })));
    }
    for (let i = 0; i < 6; i += 1) {
      ops.push(
        outcomes.run('join', allowed, async () => {
          const joiner = await createUser();
          return asUser(joiner, (db) => rpc(db, 'redeem_invitation', ['XRGQ6666', `Joiner ${i}`]));
        }),
      );
    }
    for (const member of memberIds) {
      ops.push(
        outcomes.run('remove', allowed, () =>
          admin.query("update public.memberships set status = 'removed' where community_id = $1 and user_id = $2", [
            communityId,
            member,
          ]),
        ),
      );
    }
    for (let i = 0; i < 4; i += 1) {
      ops.push(outcomes.run('stats', allowed, () => asUser(organizerId, (db) => rpc(db, 'get_community_statistics', [communityId, '30d']))));
    }
    await Promise.all(ops);

    expect(outcomes.unexpected).toEqual([]);
    expect(outcomes.total('rename:ok')).toBe(12);
    expect(outcomes.total('training:ok')).toBe(8);
    expect(outcomes.total('join:ok')).toBe(6);
    // The stored row is exactly one of the submitted (name, zone) pairs, never a mixture.
    const { rows } = await admin.query<{ name: string; timezone: string }>('select name, timezone from public.communities where id = $1', [communityId]);
    expect(submitted.get(rows[0].name)).toBe(rows[0].timezone);
    expect(await countRows('training_sessions', 'community_id = $1', [communityId])).toBe(8);
    expect(await countRows('memberships', "community_id = $1 and status = 'removed'", [communityId])).toBe(4);
  }, 120_000);

  it('a rename that is still open does not block people joining the community', async () => {
    const { communityId, organizerId } = await createPack();
    await insertInvitation(communityId, 'XRGQ7777');
    const tx = await openUserTransaction(organizerId);
    try {
      const renamed = await rpcRow<CommunityRow>(tx.db, 'update_community', [communityId, 'Held open', 'UTC']);
      expect(renamed.name).toBe('Held open');
      // The community row is locked FOR NO KEY UPDATE; a membership insert only key-shares it.
      const joiner = await createUser();
      const join = asUser(joiner, (db) => rpc(db, 'redeem_invitation', ['XRGQ7777', 'Quick Joiner']));
      expect(await settlesWithin(join, 4000)).toBe(true);
      expect(await join).toMatchObject({ ok: true });
    } finally {
      await tx.finish(false);
    }
    expect((await admin.query('select name from public.communities where id = $1', [communityId])).rows[0].name).toBe('Test Pack');
  });

  it('a rename that is still open delays another rename only for its own duration, and both land', async () => {
    const { communityId, organizerId } = await createPack();
    const second = await addMember(communityId, { role: 'organizer', name: 'Second Organizer' });
    const tx = await openUserTransaction(organizerId);
    let waiting: Promise<CommunityRow>;
    try {
      await rpcRow<CommunityRow>(tx.db, 'update_community', [communityId, 'First holder', 'UTC']);
      waiting = updateCommunity(second, communityId, 'Second writer', 'UTC');
      expect(await settlesWithin(waiting, 1500)).toBe(false);
    } finally {
      await tx.finish(true);
    }
    expect((await waiting).name).toBe('Second writer');
    expect((await admin.query('select name from public.communities where id = $1', [communityId])).rows[0].name).toBe('Second writer');
  });
});

describe('create_community_with_code retries', () => {
  it('parallel retries of ONE request id with different arguments create exactly one community and agree on it', async () => {
    const { code } = await issueCode({ maxUses: 5 });
    const other = await issueCode({ maxUses: 5 });
    const user = await createUser();
    const requestId = randomUUID();
    const submitted = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
    const results = await Promise.all(
      submitted.map((name, i) => createWithCode(user, i % 2 === 0 ? code : other.code, { name, requestId, displayName: `Dn ${name}` })),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => r.community_id)).size).toBe(1);
    expect(results.filter((r) => r.already_created === false)).toHaveLength(1);
    expect(await countRows('communities')).toBe(1);
    const stored = await admin.query('select c.name, p.display_name from public.communities c, public.profiles p where p.id = $1', [user]);
    expect(stored.rows).toHaveLength(1);
    // The first writer's pair wins as a whole: the name and the display name belong together.
    expect(stored.rows[0].display_name).toBe(`Dn ${stored.rows[0].name}`);
    // Exactly one use was consumed in total, and no failed attempt was recorded.
    expect((await admin.query('select sum(use_count)::int as n from public.community_creator_codes')).rows[0].n).toBe(1);
  });

  it('many accounts racing one 2-use code get exactly two communities and a clean exhausted for the rest', async () => {
    const { code } = await issueCode({ maxUses: 2 });
    const users = await Promise.all(Array.from({ length: 10 }, () => createUser()));
    const results = await Promise.all(users.map((u, i) => createWithCode(u, code, { name: `Racer ${i}` })));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok).every((r) => r.error === 'exhausted')).toBe(true);
    expect(await countRows('communities')).toBe(2);
    expect(await countRows('memberships', "role = 'organizer'")).toBe(2);
  });

  it('a limiter guess storm from one account never lets a sixth guess through, whatever the interleaving', async () => {
    const user = await createUser();
    const { code } = await issueCode();
    const answers = await Promise.all(
      Array.from({ length: 12 }, (_, i) => previewCode(user, i === 11 ? code : `NOPE222${i % 10}`)),
    );
    const invalid = answers.filter((a) => a.error === 'invalid_code').length;
    const limited = answers.filter((a) => a.error === 'rate_limited').length;
    const ok = answers.filter((a) => a.ok).length;
    // The per-user advisory lock serializes the calls: five failures are answered, the rest are limited.
    expect(invalid).toBeLessThanOrEqual(5);
    expect(invalid + limited + ok).toBe(12);
    expect(await countRows('invitation_attempts', 'user_id = $1 and not success', [user])).toBe(invalid);
  });

  it('service_role can issue and revoke while creations are running (no lock-order deadlock)', async () => {
    const { code } = await issueCode({ maxUses: 20 });
    const users = await Promise.all(Array.from({ length: 6 }, () => createUser()));
    const outcomes = new Outcomes();
    const ops: Promise<unknown>[] = [];
    users.forEach((u, i) => {
      ops.push(outcomes.run('create', /^$/, () => createWithCode(u, code, { name: `Storm ${i}` })));
      ops.push(outcomes.run('issue', /^$/, () => asService((db) => rpc(db, 'admin_create_creator_code', [`note ${i}`, 7, 2]))));
    });
    ops.push(outcomes.run('revoke', /^$/, () => asService((db) => rpc(db, 'admin_revoke_creator_code', [code]))));
    await Promise.all(ops);
    expect(outcomes.unexpected).toEqual([]);
    // Creations that ran before the revoke succeeded, the rest got a clean `revoked`.
    const made = await countRows('communities');
    expect(made).toBeGreaterThanOrEqual(0);
    expect(made).toBeLessThanOrEqual(6);
    expect(await countRows('community_creator_redemptions')).toBe(made);
    const { rows } = await admin.query<{ use_count: number }>('select use_count from public.community_creator_codes where code = $1', [code]);
    expect(rows[0].use_count).toBe(made);
  });
});

describe('a removed organizer and a rename', () => {
  it('a rename that started before the removal commits, one that starts after is refused', async () => {
    const { communityId, organizerId } = await createPack();
    const second = await addMember(communityId, { role: 'organizer', name: 'Second Organizer' });
    await createCommunity('Unrelated', 'UTC');
    await updateCommunity(second, communityId, 'Before removal', 'UTC');
    await admin.query("update public.memberships set status = 'removed' where community_id = $1 and user_id = $2", [communityId, second]);
    await expect(updateCommunity(second, communityId, 'After removal', 'UTC')).rejects.toMatchObject({ message: 'forbidden' });
    expect((await updateCommunity(organizerId, communityId, 'By the remaining organizer', 'UTC')).name).toBe('By the remaining organizer');
  });
});
