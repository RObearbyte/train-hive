import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  admin,
  asUser,
  bootstrapCommunity,
  closeDb,
  countRows,
  createCommunity,
  createPack,
  createUser,
  insertInvitation,
  resetData,
  rpc,
  rpcRow,
} from './helpers';
import { waitForBlocked } from './qa-helpers';

/**
 * QA (M1-Q1): invitation code generation, the organizer bootstrap under concurrency, and
 * expiry / rate-limit edges.
 */

type Result = { ok: boolean; error?: string; role?: string; already_member?: boolean; community_name?: string };

const redeem = (userId: string, code: string, name = 'Ana Runner') =>
  asUser(userId, (db) => rpc<Result>(db, 'redeem_invitation', [code, name]));
const preview = (userId: string, code: string) =>
  asUser(userId, (db) => rpc<Result>(db, 'preview_invitation', [code]));

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

beforeEach(resetData);
afterAll(closeDb);

describe('QA invitation code generation', () => {
  it('generates 8 characters from the 30-symbol alphabet, uniformly and without repeats', async () => {
    const { rows } = await admin.query<{ code: string }>(
      'select private.generate_invitation_code() as code from generate_series(1, 6000)',
    );
    const codes = rows.map((row) => row.code);
    expect(codes.filter((code) => !/^[2-9A-HJKMNP-TV-Z]{8}$/.test(code))).toEqual([]);
    expect(new Set(codes).size).toBe(codes.length);

    // Chi-square against a uniform distribution, overall and per position (29 degrees of
    // freedom; 80 is far beyond the 99.99th percentile of 66, so a false alarm is ~1e-6).
    // A modulo-biased generator (byte % 30 without rejection) scores in the hundreds.
    const chiSquare = (symbols: string[]) => {
      const expected = symbols.length / ALPHABET.length;
      return [...ALPHABET].reduce((sum, symbol) => {
        const observed = symbols.filter((s) => s === symbol).length;
        return sum + (observed - expected) ** 2 / expected;
      }, 0);
    };
    expect(chiSquare(codes.flatMap((code) => [...code]))).toBeLessThan(80);
    for (let position = 0; position < 8; position += 1) {
      expect(chiSquare(codes.map((code) => code[position])), `position ${position}`).toBeLessThan(80);
    }
  });

  it('the chi-square check above would notice a modulo-biased generator', async () => {
    // Mutation check for the statistical test itself: bytes % 30 without rejection sampling.
    const { rows } = await admin.query<{ symbol: string }>(
      `select substr($1, (get_byte(extensions.gen_random_bytes(1), 0) % 30) + 1, 1) as symbol
       from generate_series(1, 48000)`,
      [ALPHABET],
    );
    const expected = rows.length / 30;
    const chi = [...ALPHABET].reduce((sum, symbol) => {
      const observed = rows.filter((row) => row.symbol === symbol).length;
      return sum + (observed - expected) ** 2 / expected;
    }, 0);
    expect(chi).toBeGreaterThan(80);
  });

  it('create_invitation retries on a collision instead of failing or reusing a code', async () => {
    const { communityId, organizerId } = await createPack();
    const codes = await Promise.all(
      Array.from({ length: 30 }, () =>
        asUser(organizerId, (db) => rpcRow<{ code: string; role: string }>(db, 'create_invitation', [communityId])),
      ),
    );
    expect(new Set(codes.map((c) => c.code)).size).toBe(30);
    expect(codes.every((c) => c.role === 'member')).toBe(true);
  });
});

describe('QA organizer bootstrap', () => {
  it('a real bootstrap code makes exactly one organizer when 6 users race for it', async () => {
    const { communityId, organizerCode } = await bootstrapCommunity('Race Pack', 'UTC');
    const users = await Promise.all(Array.from({ length: 6 }, () => createUser()));

    const results = await Promise.all(users.map((id) => redeem(id, organizerCode)));

    expect(results.filter((r) => r.ok && r.role === 'organizer')).toHaveLength(1);
    expect(results.filter((r) => r.error === 'exhausted')).toHaveLength(5);
    expect(await countRows('memberships', "community_id = $1 and role = 'organizer'", [communityId])).toBe(1);
    expect(await countRows('memberships', 'community_id = $1', [communityId])).toBe(1);
  });

  it('nobody becomes organizer afterwards: not by the used code, not by a member code, not by re-redeeming', async () => {
    const { communityId, organizerCode } = await bootstrapCommunity('Solo Pack', 'UTC');
    const organizer = await createUser();
    await redeem(organizer, organizerCode);
    const memberCode = await asUser(organizer, (db) => rpcRow<{ code: string }>(db, 'create_invitation', [communityId]));
    const member = await createUser();

    expect(await redeem(member, organizerCode)).toEqual({ ok: false, error: 'exhausted' });
    expect(await redeem(member, memberCode.code)).toMatchObject({ ok: true, role: 'member' });
    // As a member the organizer code now answers already_member, with the role unchanged.
    expect(await redeem(member, organizerCode)).toMatchObject({ ok: true, role: 'member', already_member: true });
    expect(await preview(member, organizerCode)).toMatchObject({ ok: true, role: 'organizer' });

    expect(await countRows('memberships', "community_id = $1 and role = 'organizer'", [communityId])).toBe(1);
    // A member cannot even see the codes, so the organizer code cannot be harvested.
    const visible = await asUser(member, (db) => db.query('select code from public.invitation_codes'));
    expect(visible.rows).toEqual([]);
  });

  it('an expired, unused bootstrap code grants nothing', async () => {
    const { communityId, organizerCode } = await bootstrapCommunity('Late Pack', 'UTC');
    await admin.query("update public.invitation_codes set expires_at = now() - interval '1 second' where community_id = $1", [communityId]);
    const user = await createUser();

    expect(await redeem(user, organizerCode)).toEqual({ ok: false, error: 'expired' });
    expect(await countRows('memberships', 'community_id = $1', [communityId])).toBe(0);
  });
});

describe('QA invitation edges', () => {
  it('a code is refused from the exact instant of expiry', async () => {
    const { communityId } = await createCommunity();
    const invitation = await insertInvitation(communityId, 'MEMBER22');
    const user = await createUser();

    // expires_at = the transaction's own now(): "expires_at <= now()" must already refuse.
    const result = await asUser(user, async (db) => {
      await db.query('begin');
      await db.query('set local role postgres');
      await db.query('update public.invitation_codes set expires_at = now() where id = $1', [invitation.id]);
      await db.query('set local role authenticated');
      const value = await rpc<Result>(db, 'redeem_invitation', ['MEMBER22', 'Ana Runner']);
      await db.query('rollback');
      return value;
    });

    expect(result).toEqual({ ok: false, error: 'expired' });
  });

  // DEFECT Q1-6 (low): expiry is compared with now() (transaction start). A redemption that
  // waits for the invitation row lock can complete after the code has expired.
  it('DEFECT Q1-6: a redemption that waited past the expiry is refused', async () => {
    const { communityId } = await createCommunity();
    const invitation = await insertInvitation(communityId, 'MEMBER22');
    await admin.query("update public.invitation_codes set expires_at = clock_timestamp() + interval '400 milliseconds' where id = $1", [invitation.id]);
    const user = await createUser();

    const gate = await admin.connect();
    let pending: Promise<Result>;
    try {
      await gate.query('begin');
      await gate.query('select 1 from public.invitation_codes where id = $1 for update', [invitation.id]);
      pending = redeem(user, 'MEMBER22');
      await waitForBlocked('redeem_invitation');
      await gate.query('select pg_sleep(0.8)');
      await gate.query('commit');
    } finally {
      await gate.query('rollback');
      gate.release();
    }

    // Actual: { ok: true, role: 'member' } although the code expired ~400 ms before.
    expect(await pending).toEqual({ ok: false, error: 'expired' });
  });

  it('rate_limited answers reveal nothing about the code and are identical for valid and invalid codes', async () => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'MEMBER22');
    await insertInvitation(communityId, 'REVKD222', { revoked: true });
    const user = await createUser();
    for (let i = 0; i < 5; i += 1) await preview(user, 'WRNG2222');

    const answers = [];
    for (const code of ['MEMBER22', 'REVKD222', 'WRNG2222']) {
      answers.push(await preview(user, code), await redeem(user, code));
    }

    expect(new Set(answers.map((a) => JSON.stringify(a)))).toEqual(new Set(['{"ok":false,"error":"rate_limited"}']));
  });

  it('a successful redemption does not reset the failure counter', async () => {
    const a = await createCommunity('Pack A');
    const b = await createCommunity('Pack B');
    await insertInvitation(a.communityId, 'AAAAAA22');
    await insertInvitation(b.communityId, 'BBBBBB22');
    const user = await createUser();
    for (let i = 0; i < 4; i += 1) await preview(user, 'WRNG2222');

    expect((await redeem(user, 'AAAAAA22')).ok).toBe(true);
    expect(await preview(user, 'WRNG3333')).toEqual({ ok: false, error: 'invalid_code' });
    // Five failures inside the window: a valid code is now refused too.
    expect(await redeem(user, 'BBBBBB22')).toEqual({ ok: false, error: 'rate_limited' });
  });

  // OBSERVATION Q1-O4: the limit is per auth user. With anonymous sign-in a new user is free,
  // so the database limit alone does not bound guessing; Supabase Auth's sign-in rate limit
  // and CAPTCHA are the real bound. Documented here so the property is explicit.
  it('the rate limit does not carry over to a fresh anonymous user', async () => {
    await createCommunity();
    let invalid = 0;
    for (let i = 0; i < 4; i += 1) {
      const user = await createUser();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if ((await preview(user, 'WRNG2222')).error === 'invalid_code') invalid += 1;
      }
    }
    expect(invalid).toBe(20);
  });
});
