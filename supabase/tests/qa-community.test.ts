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
  createUser,
  INSUFFICIENT_PRIVILEGE,
  insertInvitation,
  resetData,
  rpc,
} from './helpers';
import {
  codeRow,
  createWithCode,
  type CreatorResult,
  failedAttempts,
  issueCode,
  listMyCommunities,
  previewCode,
  updateCommunity,
} from './creator-codes-helpers';
import { raised } from './qa-helpers';

/**
 * C-Q1: independent review of creator codes, community creation / editing and multi-community
 * behaviour, written from docs/API_CONTRACT.md ("Creator codes and community management (C1)")
 * and the product rules, not from the developer's tests.
 *
 * Tests named "DEFECT Q6-n" use `it.fails`: they assert the CORRECT behaviour, fail today and
 * keep `main` green. Remove `.fails` when the defect is fixed (the test then turns red if it is
 * not).
 *
 * Note on cost: private.is_valid_timezone scans pg_timezone_names (about 250 ms per call on the
 * embedded build), so creations are kept to what each test needs.
 */

const denied = { code: INSUFFICIENT_PRIVILEGE };

beforeEach(resetData);
afterAll(closeDb);

/**
 * U: organizer of A (created with a creator code), member of B (invited), removed from C.
 * Z: organizer of B. V: plain member of B. H: holds a creator code and has no membership.
 */
async function world() {
  const u = await createUser();
  const issued = await issueCode();
  const created = await createWithCode(u, issued.code, { name: 'Alpha Pack', timezone: 'Europe/Bucharest' });
  expect(created).toMatchObject({ ok: true });
  const A = created.community_id as string;
  const b = await createCommunity('Beta Pack', 'Europe/Berlin');
  const c = await createCommunity('Gamma Pack', 'UTC');
  const z = await addMember(b.communityId, { role: 'organizer', name: 'Zed Organizer' });
  const v = await addMember(b.communityId, { name: 'Vera Member' });
  for (const [community, status] of [
    [b.communityId, 'active'],
    [c.communityId, 'removed'],
  ] as const) {
    await admin.query(
      'insert into public.memberships (community_id, user_id, role, status) values ($1, $2, $3, $4)',
      [community, u, 'member', status],
    );
  }
  const h = await createUser();
  return { u, A, B: b.communityId, C: c.communityId, z, v, h };
}

async function privilege(role: string, signature: string): Promise<boolean> {
  const { rows } = await admin.query<{ ok: boolean }>(
    'select has_function_privilege($1, $2::regprocedure, $3) as ok',
    [role, signature, 'execute'],
  );
  return rows[0].ok;
}

async function publicCanExecute(signature: string): Promise<boolean> {
  const { rows } = await admin.query<{ ok: boolean }>(
    `select exists (
       select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'
     ) as ok`,
    [signature],
  );
  return rows[0].ok;
}

describe('authorization matrix (organizer of A, member of B, removed from C, holder, outsider)', () => {
  it('no table of the community model accepts a write from a user, anon or service_role', async () => {
    const w = await world();
    const statements: [string, unknown[]][] = [
      ["insert into public.communities (name, timezone) values ('X', 'UTC')", []],
      ["update public.communities set name = 'Hacked' where id = $1", [w.A]],
      ["update public.communities set timezone = 'UTC' where id = $1", [w.A]],
      ['delete from public.communities where id = $1', [w.A]],
      ["update public.memberships set role = 'organizer' where community_id = $1 and user_id = $2", [w.B, w.u]],
      ["update public.memberships set status = 'active' where community_id = $1 and user_id = $2", [w.C, w.u]],
      ["insert into public.memberships (community_id, user_id, role) values ($1, $2, 'organizer')", [w.B, w.h]],
      ['delete from public.memberships where community_id = $1 and user_id = $2', [w.A, w.u]],
      ['delete from public.invitation_attempts', []],
      ["insert into public.invitation_attempts (user_id, success) values ($1, true)", [w.u]],
      ["update public.invitation_attempts set success = true", []],
      ["insert into public.community_creator_codes (code, expires_at) values ('ABCDEFGH', now() + interval '1 day')", []],
      ['update public.community_creator_codes set max_uses = 50', []],
      ['update public.community_creator_redemptions set user_id = $1', [w.h]],
      ['delete from public.community_creator_redemptions', []],
    ];
    for (const [sql, params] of statements) {
      await expect(asUser(w.u, (db) => db.query(sql, params)), `authenticated: ${sql}`).rejects.toMatchObject(
        denied,
      );
      await expect(asAnon((db) => db.query(sql, params)), `anon: ${sql}`).rejects.toMatchObject(denied);
    }
    // The creator tables are closed to service_role as well (the owner uses the SQL editor).
    for (const sql of [
      'select * from public.community_creator_codes',
      'select * from public.community_creator_redemptions',
      "insert into public.community_creator_codes (code, expires_at) values ('ABCDEFGH', now() + interval '1 day')",
      'delete from public.community_creator_redemptions',
    ]) {
      await expect(asService((db) => db.query(sql)), `service_role: ${sql}`).rejects.toMatchObject(denied);
    }
    // Nothing moved.
    expect((await admin.query('select name from public.communities where id = $1', [w.A])).rows).toEqual([
      { name: 'Alpha Pack' },
    ]);
    expect(await countRows('memberships', "community_id = $1 and user_id = $2 and status = 'removed'", [w.C, w.u])).toBe(1);
  });

  it('the schema "private" and its helpers are closed to every API role', async () => {
    const w = await world();
    for (const sql of [
      'select private.generate_invitation_code()',
      "select private.normalize_invitation_code('abcd-efgh')",
      "select private.is_valid_timezone('UTC')",
      "select private.clean_required_text('x', 'name', 80, false)",
      'select private.invitation_rate_limited($1)',
    ]) {
      const params = sql.includes('$1') ? [w.u] : [];
      await expect(asUser(w.u, (db) => db.query(sql, params)), sql).rejects.toMatchObject(denied);
      await expect(asAnon((db) => db.query(sql, params)), sql).rejects.toMatchObject(denied);
      await expect(asService((db) => db.query(sql, params)), sql).rejects.toMatchObject(denied);
    }
  });

  it('execute privileges are exactly as the contract says, and PUBLIC has none of them', async () => {
    const serviceOnly = ['public.admin_create_creator_code(text, integer, integer)', 'public.admin_revoke_creator_code(text)'];
    const usersOnly = [
      'public.preview_creator_code(text)',
      'public.create_community_with_code(text, text, text, text, uuid)',
      'public.update_community(uuid, text, text)',
      'public.list_my_communities()',
    ];
    for (const fn of serviceOnly) {
      expect(await privilege('service_role', fn), `${fn} service_role`).toBe(true);
      expect(await privilege('authenticated', fn), `${fn} authenticated`).toBe(false);
      expect(await privilege('anon', fn), `${fn} anon`).toBe(false);
      expect(await publicCanExecute(fn), `${fn} PUBLIC`).toBe(false);
    }
    for (const fn of usersOnly) {
      expect(await privilege('authenticated', fn), `${fn} authenticated`).toBe(true);
      expect(await privilege('anon', fn), `${fn} anon`).toBe(false);
      expect(await privilege('service_role', fn), `${fn} service_role`).toBe(false);
      expect(await publicCanExecute(fn), `${fn} PUBLIC`).toBe(false);
    }
    expect(await privilege('authenticated', 'private.check_creator_code(public.community_creator_codes)')).toBe(false);
    expect(await publicCanExecute('private.check_creator_code(public.community_creator_codes)')).toBe(false);
  });

  it('a user cannot mint, revoke or read creator codes by any path (rpc as user, anon, organizer)', async () => {
    const w = await world();
    for (const run of [
      () => asUser(w.u, (db) => rpc(db, 'admin_create_creator_code', ['mine', 365, 50])),
      () => asUser(w.z, (db) => rpc(db, 'admin_create_creator_code', [null, 14, 1])),
      () => asAnon((db) => rpc(db, 'admin_create_creator_code', [null, 14, 1])),
      () => asUser(w.u, (db) => rpc(db, 'admin_revoke_creator_code', ['ABCDEFGH'])),
    ]) {
      await expect(run()).rejects.toMatchObject(denied);
    }
    expect(await countRows('community_creator_codes')).toBe(1); // only the one the world issued
  });

  it('a creator code never joins an existing community, never changes a role, and an invitation code never creates one', async () => {
    const w = await world();
    const before = (await admin.query('select id, role, status from public.memberships order by id')).rows;

    // V is a plain member of B; with a creator code V gets a NEW community, nothing in B changes.
    const { code } = await issueCode();
    const made = await createWithCode(w.v, code, { name: 'Vera Own Pack' });
    expect(made).toMatchObject({ ok: true });
    expect([w.A, w.B, w.C]).not.toContain(made.community_id);
    const after = (await admin.query('select id, role, status from public.memberships order by id')).rows;
    const untouched = after.filter((row) => before.some((b) => b.id === row.id));
    expect(untouched).toEqual(before);
    await expect(updateCommunity(w.v, w.B, 'Vera Takes Over', 'UTC')).rejects.toMatchObject(raised('forbidden'));
    expect((await admin.query('select name from public.communities where id = $1', [w.B])).rows[0].name).toBe('Beta Pack');
    // ... and V is organizer of the new community only.
    const mine = await listMyCommunities(w.v);
    expect(mine.map((m) => [m.name, m.role]).sort()).toEqual([
      ['Beta Pack', 'member'],
      ['Vera Own Pack', 'organizer'],
    ]);

    // An organizer invitation code is not a creator code: no community is created.
    await insertInvitation(w.B, 'XRGB2222', { role: 'organizer' });
    const communitiesBefore = await countRows('communities');
    expect(await createWithCode(w.h, 'XRGB2222')).toEqual({ ok: false, error: 'invalid_code' });
    expect(await createWithCode(w.h, 'xrgb-2222')).toEqual({ ok: false, error: 'invalid_code' });
    expect(await countRows('communities')).toBe(communitiesBefore);
    expect(await listMyCommunities(w.h)).toEqual([]);
  });

  it('update_community follows the membership of the community it acts on', async () => {
    const w = await world();
    const attempt = (userId: string, community: string) => updateCommunity(userId, community, 'Renamed', 'UTC');
    await expect(attempt(w.u, w.B)).rejects.toMatchObject(raised('forbidden')); // member of B
    await expect(attempt(w.u, w.C)).rejects.toMatchObject(raised('forbidden')); // removed from C
    await expect(attempt(w.z, w.A)).rejects.toMatchObject(raised('forbidden')); // organizer of another community
    await expect(attempt(w.h, w.A)).rejects.toMatchObject(raised('forbidden')); // outsider
    await expect(attempt(w.u, randomUUID())).rejects.toMatchObject(raised('forbidden')); // unknown id: same answer
    await expect(asAnon((db) => rpc(db, 'update_community', [w.A, 'x', 'UTC']))).rejects.toMatchObject(denied);

    // Creating another community with a code does not widen anything.
    const second = await issueCode();
    expect(await createWithCode(w.u, second.code, { name: 'Alpha Two' })).toMatchObject({ ok: true });
    await expect(attempt(w.u, w.B)).rejects.toMatchObject(raised('forbidden'));

    // Losing the organizer role in A (demotion by the owner) ends the right at once.
    await admin.query("update public.memberships set role = 'member' where community_id = $1 and user_id = $2", [w.A, w.u]);
    await expect(attempt(w.u, w.A)).rejects.toMatchObject(raised('forbidden'));
    expect((await admin.query('select name from public.communities where id = $1', [w.A])).rows[0].name).toBe('Alpha Pack');
  });

  it('look-alike names are allowed and harmless (documented): the new community is a separate one', async () => {
    const w = await world();
    const { code } = await issueCode();
    const clone = await createWithCode(w.h, code, { name: 'Beta Pack' });
    expect(clone).toMatchObject({ ok: true });
    expect(clone.community_id).not.toBe(w.B);
    // Members of B see nothing of it.
    const rows = (await asUser(w.v, (db) => db.query('select id from public.communities'))).rows;
    expect(rows.map((r: { id: string }) => r.id)).toEqual([w.B]);
  });
});

describe('request id replay semantics (create_community_with_code)', () => {
  it('a replay returns the first result and ignores every other argument, even invalid ones', async () => {
    const first = await issueCode({ maxUses: 5 });
    const other = await issueCode();
    const u = await createUser();
    const requestId = randomUUID();
    const made = await createWithCode(u, first.code, { name: 'First Name', displayName: 'First Dn', requestId });
    expect(made).toMatchObject({ ok: true, already_created: false });
    const useCountAfterFirst = (await codeRow(first.code)).use_count;

    const replay = (input: Parameters<typeof createWithCode>[2], code: string | null = first.code) =>
      createWithCode(u, code, { ...input, requestId });
    const expected = {
      ok: true,
      community_id: made.community_id,
      membership_id: made.membership_id,
      already_created: true,
    };
    expect(await replay({ name: 'Second Name', displayName: 'Second Dn', timezone: 'UTC' }, other.code)).toEqual(expected);
    // Validation is skipped for a replay: garbage still answers with the first result.
    expect(await replay({ name: '', timezone: 'Mars/Base', displayName: null }, null)).toEqual(expected);
    expect(await replay({ name: 'x'.repeat(500) }, 'not a code')).toEqual(expected);

    // Nothing else moved: name, display name, the other code, the first code's use, attempts.
    const stored = await admin.query(
      'select c.name, p.display_name from public.communities c, public.profiles p where c.id = $1 and p.id = $2',
      [made.community_id, u],
    );
    expect(stored.rows).toEqual([{ name: 'First Name', display_name: 'First Dn' }]);
    expect((await codeRow(other.code)).use_count).toBe(0);
    expect((await codeRow(first.code)).use_count).toBe(useCountAfterFirst);
    expect(await countRows('communities')).toBe(1);
    expect(await failedAttempts(u)).toBe(0);
  });

  it("another user's request id is never a replay and never leaks the first user's result", async () => {
    const { code } = await issueCode({ maxUses: 3 });
    const alice = await createUser();
    const mallory = await createUser();
    const requestId = randomUUID();
    const made = await createWithCode(alice, code, { requestId });
    expect(made).toMatchObject({ ok: true });

    // Mallory knows (or guesses) Alice's request id but has no valid code: an ordinary failure.
    const probe = await createWithCode(mallory, 'ZZZZZZZZ', { requestId });
    expect(probe).toEqual({ ok: false, error: 'invalid_code' });
    expect(JSON.stringify(probe)).not.toContain(made.community_id);
    // With a valid code Mallory gets their OWN community under the same id.
    const theirs = await createWithCode(mallory, code, { requestId });
    expect(theirs).toMatchObject({ ok: true, already_created: false });
    expect(theirs.community_id).not.toBe(made.community_id);
    expect(await listMyCommunities(mallory)).toHaveLength(1);
    expect(await countRows('memberships', 'user_id = $1', [mallory])).toBe(1);
  });

  it('a replay is answered even when the user is rate limited or at the 5-community limit', async () => {
    const { code } = await issueCode({ maxUses: 10 });
    const u = await createUser();
    const firstId = randomUUID();
    const first = await createWithCode(u, code, { requestId: firstId, name: 'Pack 1' });
    for (let i = 2; i <= 5; i += 1) {
      expect(await createWithCode(u, code, { name: `Pack ${i}` })).toMatchObject({ ok: true });
    }
    expect(await createWithCode(u, code, { name: 'Pack 6' })).toEqual({ ok: false, error: 'community_limit_reached' });
    for (let i = 0; i < 5; i += 1) await previewCode(u, `BAD${i}BAD2`.slice(0, 8));
    expect(await previewCode(u, code)).toEqual({ ok: false, error: 'rate_limited' });
    expect(await createWithCode(u, code, { name: 'Pack 7' })).toEqual({ ok: false, error: 'rate_limited' });
    // The retry of the first submission still works (it creates nothing).
    expect(await createWithCode(u, code, { requestId: firstId })).toMatchObject({
      ok: true,
      community_id: first.community_id,
      already_created: true,
    });
    expect(await countRows('communities')).toBe(5);
  }, 60_000);

  it('a replay after the creator lost the membership still names that community (documented)', async () => {
    const { code } = await issueCode();
    const u = await createUser();
    const requestId = randomUUID();
    const made = await createWithCode(u, code, { requestId });
    const other = await addMember(made.community_id as string, { role: 'organizer' });
    await admin.query("update public.memberships set status = 'removed' where id = $1", [made.membership_id]);
    expect(await listMyCommunities(u)).toEqual([]);
    // The server answers with the first result. The app selects that id, finds it is not in
    // list_my_communities and falls back to another community, or to onboarding.
    expect(await createWithCode(u, code, { requestId })).toMatchObject({
      ok: true,
      community_id: made.community_id,
      already_created: true,
    });
    expect(other).toBeTruthy();
  });
});

describe('failed-attempt limiter as a brute-force guard', () => {
  it('rotating anonymous accounts multiplies the guess budget: 5 invalid guesses per account, no global limit (documented)', async () => {
    const real = await issueCode();
    const results: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const attacker = await createUser();
      for (let g = 0; g < 5; g += 1) {
        const r = await previewCode(attacker, 'AAAAAAA' + g);
        results.push(String(r.error));
      }
      // The sixth guess of every fresh account is refused ...
      expect(await previewCode(attacker, 'AAAAAAAA')).toEqual({ ok: false, error: 'rate_limited' });
      // ... and a limited account cannot even confirm the REAL code (no oracle while limited).
      expect(await previewCode(attacker, real.code)).toEqual({ ok: false, error: 'rate_limited' });
    }
    // 30 guesses from 6 accounts were all answered; the database has no per-device or per-IP view.
    expect(results.filter((r) => r === 'invalid_code')).toHaveLength(30);
    // Space to cover (30 symbols, 8 characters): 6.6e11 codes, about 39 bits.
    expect(Math.log2(30 ** 8)).toBeGreaterThan(39);
  });

  it('a success does not reset the failures; failures older than 15 minutes stop counting', async () => {
    const { code } = await issueCode({ maxUses: 5 });
    const u = await createUser();
    for (let i = 0; i < 4; i += 1) expect(await previewCode(u, 'BBBBBBB' + i + '')).toMatchObject({ ok: false });
    expect(await previewCode(u, code)).toEqual({ ok: true });
    expect(await previewCode(u, 'CCCCCCCC')).toEqual({ ok: false, error: 'invalid_code' }); // 5th failure
    expect(await previewCode(u, code)).toEqual({ ok: false, error: 'rate_limited' });
    await admin.query(
      "update public.invitation_attempts set attempted_at = now() - interval '16 minutes' where user_id = $1",
      [u],
    );
    expect(await previewCode(u, code)).toEqual({ ok: true });
  });

  it('a rate limited user gets rate_limited before any input validation (no oracle for names or zones)', async () => {
    const { code } = await issueCode();
    const u = await createUser();
    for (let i = 0; i < 5; i += 1) await previewCode(u, 'DDDDDDD' + i);
    expect(await createWithCode(u, code, { name: '' })).toEqual({ ok: false, error: 'rate_limited' });
    expect(await createWithCode(u, 'whatever', { timezone: 'Mars/Base' })).toEqual({ ok: false, error: 'rate_limited' });
  });

  it('a 1 MB code is answered as an ordinary invalid code, quickly', async () => {
    const u = await createUser();
    const started = Date.now();
    expect(await previewCode(u, 'A'.repeat(1_000_000))).toEqual({ ok: false, error: 'invalid_code' });
    expect(await createWithCode(u, 'B '.repeat(500_000), { name: 'ok' })).toEqual({ ok: false, error: 'invalid_code' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('code generation', () => {
  it('draws every position uniformly from the 30-symbol alphabet (chi-square), never repeats, never uses 0 1 I L O U', async () => {
    const { rows } = await admin.query<{ code: string }>(
      'select private.generate_invitation_code() as code from generate_series(1, 30000)',
    );
    const alphabet = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
    expect(new Set(rows.map((r) => r.code)).size).toBe(rows.length);
    const expected = rows.length / alphabet.length;
    for (let position = 0; position < 8; position += 1) {
      const counts = new Map<string, number>();
      for (const { code } of rows) counts.set(code[position], (counts.get(code[position]) ?? 0) + 1);
      expect([...counts.keys()].every((ch) => alphabet.includes(ch)), `position ${position}`).toBe(true);
      expect(counts.size).toBe(alphabet.length);
      let chi = 0;
      for (const ch of alphabet) chi += ((counts.get(ch) ?? 0) - expected) ** 2 / expected;
      // 29 degrees of freedom: the 99.999 % quantile is about 64; a modulo bias would give hundreds.
      expect(chi, `chi-square of position ${position}`).toBeLessThan(75);
    }
    for (const { code } of rows) expect(code).toMatch(/^[2-9A-HJKMNP-TV-Z]{8}$/);
  });

  it('issued creator codes are distinct, well formed, and carry the requested expiry and no creator id', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const issued = await issueCode({ days: 3 });
      expect(issued.code).toMatch(/^[2-9A-HJKMNP-TV-Z]{8}$/);
      expect(seen.has(issued.code)).toBe(false);
      seen.add(issued.code);
      const row = await codeRow(issued.code);
      expect(row.created_by).toBeNull();
      const hours = (row.expires_at.getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(71);
      expect(hours).toBeLessThan(73);
    }
  });
});

describe('five-community limit: no way around it for the user', () => {
  it('leaving, being removed or being demoted does not free a slot; a refused attempt costs the code nothing', async () => {
    const { code } = await issueCode({ maxUses: 10 });
    const u = await createUser();
    for (let i = 1; i <= 5; i += 1) {
      expect(await createWithCode(u, code, { name: `Pack ${i}` }), `pack ${i}`).toMatchObject({ ok: true });
    }
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [u]);
    expect(await listMyCommunities(u)).toEqual([]);
    const useBefore = (await codeRow(code)).use_count;
    // At the limit the answer does not depend on the code: valid, invalid or revoked alike.
    expect(await createWithCode(u, code)).toEqual({ ok: false, error: 'community_limit_reached' });
    expect(await createWithCode(u, 'ZZZZZZZZ')).toEqual({ ok: false, error: 'community_limit_reached' });
    await admin.query("update public.memberships set role = 'member' where user_id = $1", [u]);
    expect(await createWithCode(u, code)).toEqual({ ok: false, error: 'community_limit_reached' });
    expect((await codeRow(code)).use_count).toBe(useBefore);
    expect(await failedAttempts(u)).toBe(0);
    // Only the platform owner can free a slot, by deleting a community (the redemption cascades).
    await admin.query('delete from public.communities where id = (select community_id from public.community_creator_redemptions where user_id = $1 limit 1)', [u]);
    expect(await createWithCode(u, code, { name: 'Pack 6' })).toMatchObject({ ok: true });
  }, 90_000);

  it('the limit is per user, not per code or per device: two codes, same user, same count', async () => {
    const a = await issueCode({ maxUses: 3 });
    const b = await issueCode({ maxUses: 3 });
    const u = await createUser();
    const outcomes: unknown[] = [];
    for (const code of [a.code, b.code, a.code, b.code, a.code, b.code]) {
      outcomes.push((await createWithCode(u, code, { name: 'Many' })).error ?? 'ok');
    }
    expect(outcomes).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'community_limit_reached']);
  }, 60_000);
});

describe('validation of names, display names and zones (server side, fuzzed)', () => {
  // Helpers called directly: same code the RPC runs, without the 250 ms zone lookup per call.
  async function cleanName(text: string): Promise<string | 'rejected'> {
    try {
      const { rows } = await admin.query<{ v: string }>("select private.clean_required_text($1, 'name', 80, false) as v", [text]);
      return rows[0].v;
    } catch (error) {
      if ((error as { message?: string }).message === 'validation_failed:name') return 'rejected';
      throw error;
    }
  }
  async function cleanDisplay(text: string): Promise<string | null> {
    const { rows } = await admin.query<{ v: string | null }>('select private.clean_display_name($1) as v', [text]);
    return rows[0].v;
  }

  const INVISIBLE_ONLY: [string, string][] = [
    ['ZWSP', '​'], ['ZWNJ', '‌'], ['ZWJ', '‍'], ['LRM', '‎'], ['RLM', '‏'],
    ['word joiner', '⁠'], ['BOM', '﻿'], ['soft hyphen', '­'], ['CGJ', '͏'],
    ['Hangul filler', 'ㅤ'], ['halfwidth Hangul filler', 'ﾠ'], ['Braille blank', '⠀'],
    ['Mongolian vowel separator', '᠎'], ['Khmer inherent vowel', '឴'], ['variation selector', '️'],
    ['tag', '\u{E0041}'], ['NBSP', ' '], ['ideographic space', '　'], ['line separator', '\u2028'],
    ['NEL', '\u0085'], ['vertical tab', '\u000B'], ['bidi override', '‮'], ['bidi isolate', '⁨'],
  ];

  it('rejects a name made only of invisible characters, alone or in combination', async () => {
    for (const [label, ch] of INVISIBLE_ONLY) {
      expect(await cleanName(ch), label).toBe('rejected');
      expect(await cleanName(ch.repeat(5)), `${label} x5`).toBe('rejected');
      expect(await cleanName(` ${ch} \t${ch}\n`), `${label} mixed`).toBe('rejected');
    }
    expect(await cleanName(INVISIBLE_ONLY.map(([, ch]) => ch).join(''))).toBe('rejected');
  });

  // DEFECT Q6-2: the server's list of "invisible" characters is a hand-made list. Characters
  // that render as nothing but are not on it make a community whose name is blank for everyone.
  it.fails('DEFECT Q6-2: a name of Arabic letter mark only (U+061C) is rejected', async () => {
    expect(await cleanName('؜؜')).toBe('rejected');
  });
  it.fails('DEFECT Q6-2: a name of variation selectors supplement only (U+E0100) is rejected', async () => {
    expect(await cleanName('\u{E0100}')).toBe('rejected');
  });
  it.fails('DEFECT Q6-2: a name of musical format controls only (U+1D173) is rejected', async () => {
    expect(await cleanName('\u{1D173}\u{1D174}')).toBe('rejected');
  });

  it('keeps legitimate text: emoji sequences, joiners between letters, RTL scripts, accents', async () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    expect(await cleanName(`Run ${family} Club`)).toBe(`Run ${family} Club`);
    expect(await cleanName('می‌خواهم')).toBe('می‌خواهم'); // ZWNJ inside a Persian word
    expect(await cleanName('نادي الجري')).toBe('نادي الجري');
    expect(await cleanName('Făget Trail Pack')).toBe('Făget Trail Pack');
    expect(await cleanName('  a \t\n b c  ')).toBe('a b c');
  });

  it('strips control and bidi override characters instead of keeping a spoof', async () => {
    expect(await cleanName('Alpha‮ Pack')).toBe('Alpha Pack');
    expect(await cleanName('Al\u0007pha\u0000'.replace('\u0000', ''))).toBe('Alpha');
    expect(await cleanName('⁦Alpha⁩')).toBe('Alpha');
  });

  it('counts the 80-character limit in code points after stripping, not UTF-16 units or graphemes', async () => {
    expect(await cleanName('\u{1F600}'.repeat(80))).toBe('\u{1F600}'.repeat(80)); // 160 UTF-16 units, 320 bytes
    expect(await cleanName('\u{1F600}'.repeat(81))).toBe('rejected');
    expect(await cleanName('x'.repeat(80) + '‮'.repeat(10))).toBe('x'.repeat(80)); // stripped first
    expect(await cleanName('x'.repeat(81) + '‮')).toBe('rejected');
    // 41 visible "e" with an accent is 82 code points: refused although only 41 glyphs show.
    expect(await cleanName('é'.repeat(41))).toBe('rejected');
    expect(await cleanName('é'.repeat(40))).toBe('é'.repeat(40));
  });

  // DEFECT Q6-1: clean_display_name (used by redeem_invitation and create_community_with_code)
  // only collapses \s and checks the length. It keeps invisible-only names, control characters
  // and bidi overrides, unlike clean_required_text, which the contract says the community name
  // follows. Display names appear in participant lists and attendance sheets of every
  // community the user belongs to.
  it.fails('DEFECT Q6-1: a display name of two zero-width spaces is rejected', async () => {
    expect(await cleanDisplay('​​')).toBeNull();
  });
  it.fails('DEFECT Q6-1: a display name of two Hangul fillers (invisible in every locale) is rejected', async () => {
    expect(await cleanDisplay('ㅤㅤ')).toBeNull();
  });
  it.fails('DEFECT Q6-1: a right-to-left override inside a display name is stripped (name spoofing)', async () => {
    expect(await cleanDisplay('Olga‮ (organizer)')).not.toContain('‮');
  });
  it.fails('DEFECT Q6-1: control characters in a display name are stripped', async () => {
    expect(await cleanDisplay('Ana\u0007\u0008Runner')).toBe('AnaRunner');
  });

  it('display names: whitespace is collapsed and the 2 to 40 code point rule holds at the edges', async () => {
    expect(await cleanDisplay('  Ana \n  Runner ')).toBe('Ana Runner');
    expect(await cleanDisplay('A')).toBeNull();
    expect(await cleanDisplay('   ')).toBeNull();
    expect(await cleanDisplay('\u{1F600}'.repeat(40))).toBe('\u{1F600}'.repeat(40));
    expect(await cleanDisplay('\u{1F600}'.repeat(41))).toBeNull();
    expect(await cleanDisplay('\u{1F600}'.repeat(2))).toBe('\u{1F600}\u{1F600}');
  });

  it('time zones: strict IANA Area/Location or UTC, nothing that merely resembles one', async () => {
    const candidates: [string, boolean][] = [
      ['UTC', true], ['Etc/UTC', true], ['Etc/GMT+5', true], ['Etc/GMT-14', true], ['Europe/Bucharest', true],
      ['America/Argentina/Buenos_Aires', true], ['America/Indiana/Indianapolis', true], ['US/Pacific', true], ['Asia/Calcutta', true],
      ['EST', false], ['EST5EDT', false], ['GMT', false], ['Zulu', false], ['utc', false], ['Utc', false],
      ['europe/bucharest', false], ['EUROPE/BUCHAREST', false], [' Europe/Bucharest', false], ['Europe/Bucharest ', false],
      ['Europe/Bucharest\n', false], ['Europe//Bucharest', false], ['/Europe/Bucharest', false], ['Europe/Bucharest/', false],
      ['posix/Europe/Bucharest', false], ['right/UTC', false], ['posixrules', false], ['localtime', false], ['Factory', false],
      ['Europe/Buch%', false], ['Europe/Buch_rest', false], ["Europe/Bucharest'--", false], ['Europe/Bucharest;', false],
      ['', false], ['+02:00', false], ['UTC+2', false], ['Europe/Bucharest​', false], ['Еurope/Bucharest', false],
    ];
    const { rows } = await admin.query<{ p: string; ok: boolean }>(
      'select p, private.is_valid_timezone(p) as ok from unnest($1::text[]) as p',
      [candidates.map(([p]) => p)],
    );
    const got = new Map(rows.map((r) => [r.p, r.ok]));
    for (const [zone, ok] of candidates) expect(got.get(zone), JSON.stringify(zone)).toBe(ok);
    const { rows: nulls } = await admin.query<{ ok: boolean | null }>('select private.is_valid_timezone(null) as ok');
    expect(nulls[0].ok).toBe(false);
  }, 90_000);

  it('a 1 MB name or display name is a plain validation error, not a crash or a slow query', async () => {
    const u = await createUser();
    const { code } = await issueCode();
    const started = Date.now();
    expect(await createWithCode(u, code, { name: 'n'.repeat(1_000_000) })).toEqual({ ok: false, error: 'validation_failed:name' });
    expect(await createWithCode(u, code, { displayName: 'd'.repeat(1_000_000) })).toEqual({ ok: false, error: 'validation_failed:display_name' });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await countRows('communities')).toBe(0);
    expect((await codeRow(code)).use_count).toBe(0);
  });
});

describe('display name is global (decision for the owner)', () => {
  it('creating or joining another community renames the user in every community they are in', async () => {
    const b = await createCommunity('Beta Pack', 'Europe/Berlin');
    const watcher = await addMember(b.communityId, { name: 'Watcher Wendy' });
    const u = await addMember(b.communityId, { name: 'Ana Runner' });
    const seenBefore = await asUser(watcher, (db) => db.query('select display_name from public.profiles where id = $1', [u]));
    expect(seenBefore.rows).toEqual([{ display_name: 'Ana Runner' }]);

    const { code } = await issueCode();
    expect(await createWithCode(u, code, { displayName: 'Captain Ana' })).toMatchObject({ ok: true });
    // The other members of B now see the new name: there is no per-community name.
    const seenAfter = await asUser(watcher, (db) => db.query('select display_name from public.profiles where id = $1', [u]));
    expect(seenAfter.rows).toEqual([{ display_name: 'Captain Ana' }]);

    // The same through an invitation to a third community.
    const c = await createCommunity('Gamma Pack', 'UTC');
    await insertInvitation(c.communityId, 'XRGC3333');
    await asUser(u, (db) => rpc(db, 'redeem_invitation', ['XRGC3333', 'Someone Else']));
    const seenThird = await asUser(watcher, (db) => db.query('select display_name from public.profiles where id = $1', [u]));
    expect(seenThird.rows).toEqual([{ display_name: 'Someone Else' }]);
  });
});

describe('error behaviour for a token whose user no longer exists', () => {
  // DEFECT Q6-3: a still-valid JWT of a deleted account (possible on a hosted project: tokens
  // live up to an hour after the user row is gone) reaches the foreign keys and surfaces the raw
  // Postgres error with table and constraint names instead of the documented not_authenticated.
  it.fails('DEFECT Q6-3: preview_creator_code answers not_authenticated for a user that does not exist', async () => {
    const ghost = randomUUID();
    const result = await asUser(ghost, (db) => rpc<CreatorResult>(db, 'preview_creator_code', ['AAAAAAAA']));
    expect(result).toEqual({ ok: false, error: 'not_authenticated' });
  });
  it.fails('DEFECT Q6-3: create_community_with_code answers not_authenticated for a user that does not exist', async () => {
    const { code } = await issueCode();
    const result = await createWithCode(randomUUID(), code);
    expect(result).toEqual({ ok: false, error: 'not_authenticated' });
  });
  it('the failure leaves nothing behind (no community, no use consumed)', async () => {
    const { code } = await issueCode();
    await expect(createWithCode(randomUUID(), code)).rejects.toMatchObject({ code: '23503' });
    expect(await countRows('communities')).toBe(0);
    expect((await codeRow(code)).use_count).toBe(0);
  });
});
