import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';
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
  rpcRow,
} from './helpers';
import {
  asNobody,
  codeRow,
  type CommunityRow,
  createWithCode,
  issueCode,
  openUserTransaction,
  withMutatedFunction,
} from './creator-codes-helpers';
import { raised, waitForBlocked } from './qa-helpers';

/**
 * C3: backend fixes from the community QA (docs/QA_REPORT.md, C-Q1): Q6-1 display name
 * hygiene, Q6-2 complete invisible-character set, Q6-3 deleted user's token, D5 retention of
 * invitation_attempts, O6 optimistic concurrency for update_community.
 */

const denied = { code: INSUFFICIENT_PRIVILEGE };

beforeEach(resetData);
afterAll(closeDb);

async function cleanName(text: string): Promise<string | 'rejected'> {
  try {
    const { rows } = await admin.query<{ v: string }>("select private.clean_required_text($1, 'name', 80, false) as v", [text]);
    return rows[0].v;
  } catch (error) {
    if ((error as { message?: string }).message === 'validation_failed:name') return 'rejected';
    throw error;
  }
}

async function cleanDisplay(text: string | null): Promise<string | null> {
  const { rows } = await admin.query<{ v: string | null }>('select private.clean_display_name($1) as v', [text]);
  return rows[0].v;
}

/** Runs `fn` on one connection that has a pg_temp helper telling whether a text is rejected. */
async function withRejectProbe<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await admin.connect();
  try {
    await db.query(`
      create function pg_temp.rejected(p text, p_multiline boolean) returns boolean
      language plpgsql as $$
      begin
        perform private.clean_required_text(p, 'f', 80, p_multiline);
        return false;
      exception when sqlstate 'P0001' then
        return true;
      end $$`);
    return await fn(db);
  } finally {
    await db.query('discard temp');
    db.release();
  }
}

const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';
const PERSIAN_ZWNJ = 'می‌خواهم';
const HEART_VS16 = '❤️';
// Flag of England: black flag + tag sequence (U+E0067 ... U+E007F).
const ENGLAND = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';

describe('Q6-2: invisible characters (Unicode property sets)', () => {
  it('rejects every White_Space, Default_Ignorable_Code_Point, Cf and Cc code point on its own (as Node ICU defines them)', async () => {
    const candidates: number[] = [];
    const property = /^[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}]$/u;
    for (let cp = 1; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (property.test(String.fromCodePoint(cp))) candidates.push(cp);
    }
    expect(candidates.length).toBeGreaterThan(4200);
    const accepted = await withRejectProbe(async (db) => {
      const { rows } = await db.query<{ cp: number }>(
        `select cp from unnest($1::int[]) as cp
         where not pg_temp.rejected(chr(cp), false)
            or not pg_temp.rejected(repeat(chr(cp), 3), false)
            or not pg_temp.rejected(chr(cp), true)`,
        [candidates],
      );
      return rows.map((r) => `U+${r.cp.toString(16).toUpperCase().padStart(4, '0')}`);
    });
    expect(accepted).toEqual([]);
  }, 60_000);

  it('rejects the characters QA found accepted, alone and mixed', async () => {
    const found = [
      '؜', '\u{E0100}', '\u{E01EF}', '\u{1D173}', '\u{1D17A}', '᠎', 'ᅟ', 'ᅠ', '؀',
      '؅', '۝', '܏', '࢐', '࢑', '࣢', '⁥', '￰', '￻', '\u{110BD}',
      '\u{110CD}', '\u{13430}', '\u{1343F}', '\u{1BCA0}', '\u{1BCA3}', '\u{E0080}', '\u{E00FF}', '\u{E01F0}',
      '\u{E0FFF}', '᠋', '᠏',
    ];
    for (const ch of found) {
      expect(await cleanName(ch), `U+${ch.codePointAt(0)!.toString(16)}`).toBe('rejected');
      expect(await cleanDisplay(ch + ch), `display U+${ch.codePointAt(0)!.toString(16)}`).toBeNull();
    }
    expect(await cleanName(found.join(' '))).toBe('rejected');
  });

  it('keeps emoji ZWJ sequences, Persian ZWNJ, variation selector 16 and tag flags unchanged', async () => {
    for (const text of [`Run ${FAMILY} Club`, PERSIAN_ZWNJ, `I ${HEART_VS16} running`, `${ENGLAND} Pack`, FAMILY, HEART_VS16]) {
      expect(await cleanName(text), JSON.stringify(text)).toBe(text);
      expect(await cleanDisplay(text), JSON.stringify(text)).toBe(text);
    }
  });

  it('applies to announcement titles too (the same function), and the unauthorized path is unchanged', async () => {
    const { communityId } = await createCommunity();
    const organizer = await addMember(communityId, { role: 'organizer', name: 'Olga Organizer' });
    const member = await addMember(communityId, { name: 'Mia Member' });
    await expect(
      asUser(organizer, (db) => rpcRow(db, 'create_announcement', [communityId, '؜\u{E0100}', 'body', null])),
    ).rejects.toMatchObject(raised('validation_failed:title'));
    await expect(
      asUser(member, (db) => rpcRow(db, 'create_announcement', [communityId, 'Hi', 'body', null])),
    ).rejects.toMatchObject(raised('forbidden'));
    expect(await countRows('announcements')).toBe(0);
  });
});

describe('Q6-1: display names through every path', () => {
  const INVISIBLE_NAMES = ['​​', 'ㅤㅤ', '⠀⠀', '‮‮', '\u0007\u0008', '؜؜', '\u{E0100}\u{E0101}'];

  it('the helper strips controls and bidi controls, collapses whitespace and keeps 2 to 40 code points', async () => {
    expect(await cleanDisplay('Olga‮ (organizer)')).toBe('Olga (organizer)');
    expect(await cleanDisplay('⁦Ana⁩ Runner')).toBe('Ana Runner');
    expect(await cleanDisplay('Ana\u0007\u0008Runner')).toBe('AnaRunner');
    expect(await cleanDisplay('Ana 　 Runner')).toBe('Ana Runner');
    expect(await cleanDisplay('  Ana \n\t Runner ')).toBe('Ana Runner');
    expect(await cleanDisplay('A\u0007')).toBeNull(); // one code point once stripped
    expect(await cleanDisplay('x'.repeat(40) + '‮')).toBe('x'.repeat(40));
    expect(await cleanDisplay('x'.repeat(41))).toBeNull();
    expect(await cleanDisplay(null)).toBeNull();
    for (const name of INVISIBLE_NAMES) expect(await cleanDisplay(name), JSON.stringify(name)).toBeNull();
  });

  it('redeem_invitation refuses invisible names (not counted as a guess) and stores the cleaned name', async () => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'MEMBER22');
    const user = await createUser();
    for (const name of INVISIBLE_NAMES) {
      expect(await asUser(user, (db) => rpc(db, 'redeem_invitation', ['MEMBER22', name])), JSON.stringify(name)).toEqual({
        ok: false,
        error: 'invalid_display_name',
      });
    }
    expect(await countRows('invitation_attempts', 'not success')).toBe(0);
    expect(await countRows('profiles')).toBe(0);

    expect(await asUser(user, (db) => rpc(db, 'redeem_invitation', ['MEMBER22', 'Olga‮ (organizer)']))).toMatchObject({ ok: true });
    const { rows } = await admin.query('select display_name from public.profiles where id = $1', [user]);
    expect(rows).toEqual([{ display_name: 'Olga (organizer)' }]);
  });

  it('create_community_with_code refuses invisible names and stores the cleaned name', async () => {
    const user = await createUser();
    const { code } = await issueCode();
    expect(await createWithCode(user, code, { displayName: '​​' })).toEqual({ ok: false, error: 'validation_failed:display_name' });
    expect((await codeRow(code)).use_count).toBe(0);
    expect(await createWithCode(user, code, { displayName: `Ana ${FAMILY}\u0007` })).toMatchObject({ ok: true });
    const { rows } = await admin.query('select display_name from public.profiles where id = $1', [user]);
    expect(rows).toEqual([{ display_name: `Ana ${FAMILY}` }]);
  });

  it('update_display_name refuses invisible names, strips spoofing, and stays closed to others', async () => {
    const { communityId } = await createCommunity();
    const user = await addMember(communityId, { name: 'Old Name' });
    for (const name of INVISIBLE_NAMES) {
      await expect(asUser(user, (db) => rpcRow(db, 'update_display_name', [name])), JSON.stringify(name)).rejects.toMatchObject(
        raised('validation_failed:display_name'),
      );
    }
    const row = await asUser(user, (db) => rpcRow<{ display_name: string }>(db, 'update_display_name', ['‮Ana⁦ Runner']));
    expect(row.display_name).toBe('Ana Runner');
    await expect(asAnon((db) => rpcRow(db, 'update_display_name', ['Ana Runner']))).rejects.toMatchObject(denied);
  });
});

describe('Q6-3: a still-valid token of a deleted user', () => {
  const ghostCalls: [string, (code: string) => unknown[]][] = [
    ['preview_invitation', (code) => [code]],
    ['redeem_invitation', (code) => [code, 'Ghost Runner']],
    ['preview_creator_code', (code) => [code]],
    ['create_community_with_code', (code) => [code, 'Ghost Pack', 'UTC', 'Ghost Runner', randomUUID()]],
  ];

  it.each(ghostCalls)('%s answers not_authenticated and writes nothing', async (fn, args) => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'MEMBER22');
    const { code: creator } = await issueCode();
    const code = fn.includes('creator') || fn.includes('community') ? creator : 'MEMBER22';
    for (const attempt of [code, 'WRONG222']) {
      expect(await asUser(randomUUID(), (db) => rpc(db, fn, args(attempt))), attempt).toEqual({ ok: false, error: 'not_authenticated' });
    }
    expect(await countRows('invitation_attempts')).toBe(0);
    expect(await countRows('profiles')).toBe(0);
    expect(await countRows('communities')).toBe(1);
    expect((await codeRow(creator)).use_count).toBe(0);
    // Unauthorized paths are unchanged: no user id, and anon.
    expect(await asNobody((db) => rpc(db, fn, args(code)))).toEqual({ ok: false, error: 'not_authenticated' });
    await expect(asAnon((db) => rpc(db, fn, args(code)))).rejects.toMatchObject(denied);
  });

  /**
   * The user exists at the start of the call and is deleted while the call waits for the
   * per-user advisory lock: the write then fails at the foreign key, which is mapped to
   * not_authenticated and rolls back everything the call wrote.
   */
  async function deletedDuringCall(fn: string, args: unknown[]): Promise<unknown> {
    const user = await createUser();
    const holder = await admin.connect();
    try {
      await holder.query('begin');
      await holder.query("select pg_advisory_xact_lock(hashtextextended('invitation_attempts:' || $1::text, 0))", [user]);
      const call = asUser(user, (db) => rpc(db, fn, args));
      call.catch(() => undefined);
      await waitForBlocked(`public.${fn}`);
      await holder.query('delete from auth.users where id = $1', [user]);
      await holder.query('commit');
      return await call;
    } finally {
      holder.release();
    }
  }

  it.each(ghostCalls)('%s: a deletion racing the call is mapped to not_authenticated, nothing left behind', async (fn, args) => {
    const { communityId } = await createCommunity();
    await insertInvitation(communityId, 'MEMBER22');
    const { code: creator } = await issueCode();
    const code = fn.includes('creator') || fn.includes('community') ? creator : 'MEMBER22';
    expect(await deletedDuringCall(fn, args(code))).toEqual({ ok: false, error: 'not_authenticated' });
    expect(await countRows('invitation_attempts')).toBe(0);
    expect(await countRows('profiles')).toBe(0);
    expect(await countRows('memberships')).toBe(0);
    expect(await countRows('communities')).toBe(1);
    expect((await codeRow(creator)).use_count).toBe(0);
  });

  it('mutation check: without the foreign key mapping the race surfaces the raw 23503', async () => {
    const { code } = await issueCode();
    const outcome = await withMutatedFunction(
      'public.preview_creator_code(text)',
      'when foreign_key_violation then',
      'when division_by_zero then',
      () => deletedDuringCall('preview_creator_code', [code]).then(
        () => 'no error',
        (error: { code?: string }) => error.code,
      ),
    );
    expect(outcome).toBe('23503');
  });

  it('an existing user is unaffected (the success path still records the attempt)', async () => {
    const user = await createUser();
    const { code } = await issueCode();
    expect(await asUser(user, (db) => rpc(db, 'preview_creator_code', [code]))).toEqual({ ok: true });
    expect(await countRows('invitation_attempts', 'user_id = $1 and success', [user])).toBe(1);
  });
});

describe('D5: retention of invitation_attempts', () => {
  async function attempt(user: string, age: string, success: boolean): Promise<void> {
    await admin.query(
      'insert into public.invitation_attempts (user_id, success, attempted_at) values ($1, $2, now() - $3::interval)',
      [user, success, age],
    );
  }

  it('the daily purge deletes rows older than 24 hours, keeps recent ones, and the limiter is unaffected', async () => {
    const limited = await createUser();
    const oldOnly = await createUser();
    for (let i = 0; i < 5; i += 1) await attempt(limited, '2 minutes', false);
    await attempt(limited, '25 hours', false);
    await attempt(limited, '23 hours', true);
    for (let i = 0; i < 6; i += 1) await attempt(oldOnly, `${25 + i} hours`, false);
    await attempt(oldOnly, '3 days', true);
    const { code } = await issueCode();
    expect(await asUser(limited, (db) => rpc(db, 'preview_creator_code', [code]))).toEqual({ ok: false, error: 'rate_limited' });

    // The documented return value (jobs and notifications deleted) is unchanged.
    expect(await asService((db) => rpc<number>(db, 'purge_old_notification_data'))).toBe(0);

    expect(await countRows('invitation_attempts', "attempted_at < now() - interval '24 hours'")).toBe(0);
    expect(await countRows('invitation_attempts', 'user_id = $1', [limited])).toBe(6);
    expect(await countRows('invitation_attempts', 'user_id = $1', [oldOnly])).toBe(0);
    expect(await asUser(limited, (db) => rpc(db, 'preview_creator_code', [code]))).toEqual({ ok: false, error: 'rate_limited' });
    expect(await asUser(oldOnly, (db) => rpc(db, 'preview_creator_code', [code]))).toEqual({ ok: true });

    // Idempotent.
    const { rows } = await admin.query<{ n: number }>('select private.purge_old_invitation_attempts() as n');
    expect(rows[0].n).toBe(0);
  });

  it('skips rows locked by a running call instead of waiting, and deletes them on the next run', async () => {
    const user = await createUser();
    await attempt(user, '30 hours', false);
    await attempt(user, '31 hours', false);
    const holder = await admin.connect();
    try {
      await holder.query('begin');
      await holder.query(
        "select id from public.invitation_attempts where user_id = $1 and attempted_at < now() - interval '30 hours 30 minutes' for update",
        [user],
      );
      const { rows } = await admin.query<{ n: number }>('select private.purge_old_invitation_attempts() as n');
      expect(rows[0].n).toBe(1);
      await holder.query('commit');
    } finally {
      holder.release();
    }
    const { rows } = await admin.query<{ n: number }>('select private.purge_old_invitation_attempts() as n');
    expect(rows[0].n).toBe(1);
    expect(await countRows('invitation_attempts')).toBe(0);
  });

  it('is closed to every API role (private helper; the purge is service_role only)', async () => {
    const user = await createUser();
    for (const run of [
      (sql: string) => asUser(user, (db) => db.query(sql)),
      (sql: string) => asAnon((db) => db.query(sql)),
      (sql: string) => asService((db) => db.query(sql)),
    ]) {
      await expect(run('select private.purge_old_invitation_attempts()')).rejects.toMatchObject(denied);
      await expect(run('select private.auth_user_exists(gen_random_uuid())')).rejects.toMatchObject(denied);
    }
    await expect(asUser(user, (db) => rpc(db, 'purge_old_notification_data'))).rejects.toMatchObject(denied);
    await expect(asAnon((db) => rpc(db, 'purge_old_notification_data'))).rejects.toMatchObject(denied);
  });
});

describe('O6: update_community optimistic concurrency', () => {
  type Row = CommunityRow & { updated_at: Date };

  async function pack() {
    const { communityId } = await createCommunity('Alpha Pack', 'UTC');
    const a = await addMember(communityId, { role: 'organizer', name: 'Ann Organizer' });
    const b = await addMember(communityId, { role: 'organizer', name: 'Bob Organizer' });
    const m = await addMember(communityId, { name: 'Mia Member' });
    const { rows } = await admin.query<Row>('select * from public.communities where id = $1', [communityId]);
    return { communityId, a, b, m, row: rows[0] };
  }

  const update = (user: string, id: string, name: string, zone: string, expected?: Date | string | null) =>
    asUser(user, (db) =>
      rpcRow<Row>(db, 'update_community', expected === undefined ? [id, name, zone] : [id, name, zone, expected]),
    );

  it('updated_at is set, has millisecond precision and strictly increases with each change', async () => {
    const { communityId, a, row } = await pack();
    const { rows } = await admin.query<{ us: number }>(
      "select extract(microseconds from updated_at)::int % 1000 as us from public.communities where id = $1",
      [communityId],
    );
    expect(rows[0].us).toBe(0);
    let previous = row.updated_at;
    for (let i = 0; i < 5; i += 1) {
      const next = await update(a, communityId, `Alpha ${i}`, 'UTC', previous);
      expect(next.updated_at.getTime()).toBeGreaterThan(previous.getTime());
      previous = next.updated_at;
    }
  });

  it('a matching p_expected_updated_at saves; a stale one raises stale_data and changes nothing', async () => {
    const { communityId, a, b, row } = await pack();
    const loaded = row.updated_at;
    const first = await update(b, communityId, 'Alpha Pack', 'Europe/Berlin', loaded);
    expect(first).toMatchObject({ name: 'Alpha Pack', timezone: 'Europe/Berlin' });
    // A's form was loaded before B's save: it only renames, and would write the old zone back.
    await expect(update(a, communityId, 'Alpha Renamed', 'UTC', loaded)).rejects.toMatchObject(raised('stale_data'));
    // Even when the submitted values equal the current ones, a stale form is refused.
    await expect(update(a, communityId, 'Alpha Pack', 'Europe/Berlin', loaded)).rejects.toMatchObject(raised('stale_data'));
    const { rows } = await admin.query<Row>('select * from public.communities where id = $1', [communityId]);
    expect(rows[0]).toMatchObject({ name: 'Alpha Pack', timezone: 'Europe/Berlin', updated_at: first.updated_at });
    // After reloading, the save goes through; the ISO string from the API works as well.
    const again = await update(a, communityId, 'Alpha Renamed', 'Europe/Berlin', first.updated_at.toISOString());
    expect(again).toMatchObject({ name: 'Alpha Renamed', timezone: 'Europe/Berlin' });
  });

  it('null or omitted keeps the C1 behaviour; unchanged values return the row as is', async () => {
    const { communityId, a, b, row } = await pack();
    await update(b, communityId, 'Alpha Pack', 'Europe/Berlin');
    const overwritten = await update(a, communityId, 'Alpha Pack', 'UTC', null);
    expect(overwritten.timezone).toBe('UTC');
    const same = await update(a, communityId, 'Alpha Pack', 'UTC', overwritten.updated_at);
    expect(same.updated_at.getTime()).toBe(overwritten.updated_at.getTime());
    expect(overwritten.updated_at.getTime()).toBeGreaterThan(row.updated_at.getTime());
  });

  it('two organizers saving from the same form at once: the second waits for the row lock and gets stale_data', async () => {
    const { communityId, a, b, row } = await pack();
    const first = await openUserTransaction(a);
    try {
      await first.db.query('select * from public.update_community($1, $2, $3, $4)', [communityId, 'Alpha A', 'UTC', row.updated_at]);
      const second = update(b, communityId, 'Alpha Pack', 'Europe/Berlin', row.updated_at);
      second.catch(() => undefined);
      await waitForBlocked('update_community');
      await first.finish(true);
      await expect(second).rejects.toMatchObject(raised('stale_data'));
    } catch (error) {
      await first.finish(false).catch(() => undefined);
      throw error;
    }
    const { rows } = await admin.query<Row>('select * from public.communities where id = $1', [communityId]);
    expect(rows[0]).toMatchObject({ name: 'Alpha A', timezone: 'UTC' });
  });

  it('concurrent saves without the parameter still both apply (last write wins, as before)', async () => {
    const { communityId, a, b } = await pack();
    const results = await Promise.all([
      update(a, communityId, 'Alpha A', 'UTC', null),
      update(b, communityId, 'Alpha B', 'Europe/Berlin', null),
    ]);
    expect(results.map((r) => r.name).sort()).toEqual(['Alpha A', 'Alpha B']);
    expect(results[0].updated_at.getTime()).not.toBe(results[1].updated_at.getTime());
  });

  it('the unauthorized paths come before the stale check and reveal nothing', async () => {
    const { communityId, m, row } = await pack();
    const outsider = await createUser();
    const stale = new Date(row.updated_at.getTime() - 1000);
    for (const user of [m, outsider]) {
      for (const expected of [row.updated_at, stale]) {
        await expect(update(user, communityId, 'Hijack', 'UTC', expected)).rejects.toMatchObject(raised('forbidden'));
      }
    }
    await expect(update(outsider, randomUUID(), 'Hijack', 'UTC', stale)).rejects.toMatchObject(raised('forbidden'));
    await expect(
      asAnon((db) => rpcRow(db, 'update_community', [communityId, 'Hijack', 'UTC', row.updated_at])),
    ).rejects.toMatchObject(denied);
    await expect(
      asService((db) => rpcRow(db, 'update_community', [communityId, 'Hijack', 'UTC', row.updated_at])),
    ).rejects.toMatchObject(denied);
    const { rows } = await admin.query<Row>('select * from public.communities where id = $1', [communityId]);
    expect(rows[0]).toMatchObject({ name: 'Alpha Pack', updated_at: row.updated_at });
  });

  it('the old three-argument signature is gone (no ambiguous overload)', async () => {
    const { rows } = await admin.query<{ sig: string }>(
      "select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'update_community'",
    );
    expect(rows).toEqual([{ sig: 'update_community(uuid,text,text,timestamp with time zone)' }]);
  });
});
