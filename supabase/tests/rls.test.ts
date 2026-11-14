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
  type Db,
  INSUFFICIENT_PRIVILEGE,
  insertInvitation,
  resetData,
  rpc,
} from './helpers';

const TABLES = [
  'communities',
  'profiles',
  'memberships',
  'invitation_codes',
  'invitation_redemptions',
  'invitation_attempts',
] as const;

const denied = { code: INSUFFICIENT_PRIVILEGE };

async function ids(db: Db, sql: string, params: unknown[] = []): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(sql, params);
  return rows.map((row) => row.id).sort();
}

/** Two communities, each with an organizer, a member and an invitation with one redemption. */
async function twoCommunities() {
  const a = await createCommunity('Alpha Pack');
  const b = await createCommunity('Beta Pack');
  const organizerA = await addMember(a.communityId, { role: 'organizer', name: 'Olga A' });
  const memberA = await addMember(a.communityId, { name: 'Mihai A' });
  const removedA = await addMember(a.communityId, { status: 'removed', name: 'Radu Removed' });
  const organizerB = await addMember(b.communityId, { role: 'organizer', name: 'Oana B' });
  const memberB = await addMember(b.communityId, { name: 'Maria B' });
  const outsider = await createUser();
  const invitationA = await insertInvitation(a.communityId, 'AAAA2222');
  const invitationB = await insertInvitation(b.communityId, 'BETA2222');
  await admin.query(
    'insert into public.invitation_redemptions (invitation_id, user_id) values ($1, $2), ($3, $4)',
    [invitationA.id, memberA, invitationB.id, memberB],
  );
  return { a, b, organizerA, memberA, removedA, organizerB, memberB, outsider, invitationA, invitationB };
}

beforeEach(resetData);
afterAll(closeDb);

describe('schema hardening', () => {
  it('has row level security enabled on every public table', async () => {
    const { rows } = await admin.query<{ relname: string }>(
      `select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  it('has only select policies', async () => {
    const { rows } = await admin.query<{ tablename: string; cmd: string }>(
      "select tablename, cmd from pg_policies where schemaname = 'public' and cmd <> 'SELECT'",
    );
    expect(rows).toEqual([]);
  });

  it('grants anon and authenticated no table privilege other than select for authenticated', async () => {
    const { rows } = await admin.query<{ grantee: string; table_name: string; privilege_type: string }>(
      `select grantee, table_name, privilege_type
       from information_schema.role_table_grants
       where table_schema = 'public'
         and grantee in ('anon', 'authenticated', 'PUBLIC')
         and not (grantee = 'authenticated' and privilege_type = 'SELECT')`,
    );
    expect(rows).toEqual([]);
  });

  it('lets anon and PUBLIC execute no function in public or private', async () => {
    const { rows } = await admin.query<{ fn: string }>(
      `select p.oid::regprocedure::text as fn
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private')
         and (has_function_privilege('anon', p.oid, 'execute')
              or has_function_privilege('public', p.oid, 'execute'))`,
    );
    expect(rows).toEqual([]);
  });

  it('lets authenticated execute exactly the contract functions', async () => {
    const { rows } = await admin.query<{ proname: string }>(
      `select p.proname
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private')
         and has_function_privilege('authenticated', p.oid, 'execute')
       order by p.proname`,
    );
    // M1-B2 will add the training RPCs to this list.
    expect(rows.map((row) => row.proname)).toEqual(
      expect.arrayContaining([
        'create_invitation',
        'is_active_member',
        'is_organizer',
        'preview_invitation',
        'redeem_invitation',
        'revoke_invitation',
        'update_display_name',
      ]),
    );
    expect(rows.map((row) => row.proname)).not.toContain('admin_create_community');
  });

  it('makes every public function security definer with an empty search_path', async () => {
    const { rows } = await admin.query<{ fn: string }>(
      `select p.oid::regprocedure::text as fn
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and (not p.prosecdef or p.proconfig is null or not ('search_path=""' = any (p.proconfig)))`,
    );
    expect(rows).toEqual([]);
  });

  it('publishes memberships to supabase_realtime', async () => {
    const { rows } = await admin.query(
      "select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'memberships'",
    );
    expect(rows).toHaveLength(1);
  });

  it('keeps the private schema and its functions out of reach', async () => {
    const userId = await createUser();
    await expect(
      asUser(userId, (db) => db.query('select private.record_invitation_attempt($1, true)', [userId])),
    ).rejects.toMatchObject(denied);
    await expect(
      asUser(userId, (db) => db.query('select private.generate_invitation_code()')),
    ).rejects.toMatchObject(denied);
    await expect(asAnon((db) => db.query('select private.generate_invitation_code()'))).rejects.toMatchObject(denied);
  });
});

describe('direct writes are denied', () => {
  const statements = (table: string) => [
    `insert into public.${table} default values`,
    `update public.${table} set id = id`,
    `delete from public.${table}`,
    `truncate table public.${table} cascade`,
  ];

  describe.each(TABLES)('%s', (table) => {
    it('for an authenticated organizer', async () => {
      const { communityId } = await createCommunity();
      const organizerId = await addMember(communityId, { role: 'organizer' });

      for (const sql of statements(table)) {
        await expect(asUser(organizerId, (db) => db.query(sql)), sql).rejects.toMatchObject(denied);
      }
    });

    it('for anon, including select', async () => {
      await createCommunity();

      for (const sql of [`select * from public.${table}`, ...statements(table)]) {
        await expect(asAnon((db) => db.query(sql)), sql).rejects.toMatchObject(denied);
      }
    });
  });

  it('a member cannot promote themselves to organizer', async () => {
    const { communityId } = await createCommunity();
    const memberId = await addMember(communityId);

    await expect(
      asUser(memberId, (db) =>
        db.query("update public.memberships set role = 'organizer' where user_id = $1", [memberId]),
      ),
    ).rejects.toMatchObject(denied);
    await expect(
      asUser(memberId, (db) =>
        db.query(
          "insert into public.memberships (community_id, user_id, role) values ($1, $2, 'organizer') on conflict (community_id, user_id) do update set role = 'organizer'",
          [communityId, memberId],
        ),
      ),
    ).rejects.toMatchObject(denied);
    expect(await countRows('memberships', "user_id = $1 and role = 'member'", [memberId])).toBe(1);
  });

  it('an outsider cannot insert a membership, a profile or an invitation', async () => {
    const { communityId } = await createCommunity();
    const outsiderId = await createUser();

    await expect(
      asUser(outsiderId, (db) =>
        db.query("insert into public.profiles (id, display_name) values ($1, 'Sneaky')", [outsiderId]),
      ),
    ).rejects.toMatchObject(denied);
    await expect(
      asUser(outsiderId, (db) =>
        db.query(
          "insert into public.memberships (community_id, user_id, role) values ($1, $2, 'organizer')",
          [communityId, outsiderId],
        ),
      ),
    ).rejects.toMatchObject(denied);
    await expect(
      asUser(outsiderId, (db) =>
        db.query(
          "insert into public.invitation_codes (community_id, code, role) values ($1, 'SNEAKY22', 'organizer')",
          [communityId],
        ),
      ),
    ).rejects.toMatchObject(denied);
    expect(await countRows('memberships')).toBe(0);
  });

  it('a removed member cannot reactivate their membership', async () => {
    const { communityId } = await createCommunity();
    const removedId = await addMember(communityId, { status: 'removed' });

    await expect(
      asUser(removedId, (db) =>
        db.query("update public.memberships set status = 'active' where user_id = $1", [removedId]),
      ),
    ).rejects.toMatchObject(denied);
  });

  it('an organizer cannot edit an invitation into an organizer invitation', async () => {
    const { communityId } = await createCommunity();
    const organizerId = await addMember(communityId, { role: 'organizer' });
    const invitation = await insertInvitation(communityId, 'MEMBER22');

    await expect(
      asUser(organizerId, (db) =>
        db.query("update public.invitation_codes set role = 'organizer' where id = $1", [invitation.id]),
      ),
    ).rejects.toMatchObject(denied);
  });

  it('nobody but definer functions can read invitation_attempts', async () => {
    const { communityId } = await createCommunity();
    const organizerId = await addMember(communityId, { role: 'organizer' });

    await expect(
      asUser(organizerId, (db) => db.query('select * from public.invitation_attempts')),
    ).rejects.toMatchObject(denied);
  });
});

describe('anon', () => {
  it('cannot execute any RPC or helper', async () => {
    const { communityId, organizerCode } = await createCommunity();
    const calls: [string, unknown[]][] = [
      ['preview_invitation', [organizerCode]],
      ['redeem_invitation', [organizerCode, 'Anon Ymous']],
      ['create_invitation', [communityId]],
      ['revoke_invitation', [communityId]],
      ['update_display_name', ['Anon Ymous']],
      ['admin_create_community', ['Mine', 'Europe/Bucharest']],
      ['is_active_member', [communityId]],
      ['is_organizer', [communityId]],
    ];

    for (const [name, args] of calls) {
      await expect(asAnon((db) => rpc(db, name, args)), name).rejects.toMatchObject(denied);
    }
    expect(await countRows('memberships')).toBe(0);
    expect(await countRows('invitation_attempts')).toBe(0);
  });
});

describe('cross-community isolation', () => {
  it('communities: only active members see their own community', async () => {
    const f = await twoCommunities();

    expect(await asUser(f.memberA, (db) => ids(db, 'select id from public.communities'))).toEqual([f.a.communityId]);
    expect(await asUser(f.organizerB, (db) => ids(db, 'select id from public.communities'))).toEqual([f.b.communityId]);
    expect(await asUser(f.outsider, (db) => ids(db, 'select id from public.communities'))).toEqual([]);
    expect(await asUser(f.removedA, (db) => ids(db, 'select id from public.communities'))).toEqual([]);
    expect(
      await asUser(f.memberA, (db) => ids(db, 'select id from public.communities where id = $1', [f.b.communityId])),
    ).toEqual([]);
  });

  it('memberships: only active members see the memberships of their community', async () => {
    const f = await twoCommunities();
    const usersIn = (viewer: string) =>
      asUser(viewer, (db) => ids(db, 'select user_id as id from public.memberships'));

    // Active members see every membership row of their community, including removed ones.
    expect(await usersIn(f.memberA)).toEqual([f.organizerA, f.memberA, f.removedA].sort());
    expect(await usersIn(f.organizerB)).toEqual([f.organizerB, f.memberB].sort());
    expect(await usersIn(f.outsider)).toEqual([]);
    expect(await usersIn(f.removedA)).toEqual([]);
  });

  it('profiles: self plus active members of a shared active community', async () => {
    const f = await twoCommunities();
    const profilesFor = (viewer: string) => asUser(viewer, (db) => ids(db, 'select id from public.profiles'));

    expect(await profilesFor(f.memberA)).toEqual([f.organizerA, f.memberA].sort());
    expect(await profilesFor(f.organizerA)).toEqual([f.organizerA, f.memberA].sort());
    expect(await profilesFor(f.memberB)).toEqual([f.organizerB, f.memberB].sort());
    // A removed member sees only themselves; an outsider without a profile sees nothing.
    expect(await profilesFor(f.removedA)).toEqual([f.removedA]);
    expect(await profilesFor(f.outsider)).toEqual([]);
  });

  it('profiles: a user in two communities sees both, the others stay separated', async () => {
    const f = await twoCommunities();
    await admin.query('insert into public.memberships (community_id, user_id) values ($1, $2)', [
      f.b.communityId,
      f.memberA,
    ]);

    expect(await asUser(f.memberA, (db) => ids(db, 'select id from public.profiles'))).toEqual(
      [f.organizerA, f.memberA, f.organizerB, f.memberB].sort(),
    );
    expect(await asUser(f.organizerA, (db) => ids(db, 'select id from public.profiles'))).toEqual(
      [f.organizerA, f.memberA].sort(),
    );
    expect(await asUser(f.memberA, (db) => ids(db, 'select id from public.communities'))).toEqual(
      [f.a.communityId, f.b.communityId].sort(),
    );
  });

  it('invitation_codes: only organizers of that community can read them', async () => {
    const f = await twoCommunities();
    const codesFor = (viewer: string) =>
      asUser(viewer, (db) => ids(db, 'select code as id from public.invitation_codes'));

    expect(await codesFor(f.organizerA)).toEqual(['AAAA2222', f.a.organizerCode].sort());
    expect(await codesFor(f.organizerB)).toEqual(['BETA2222', f.b.organizerCode].sort());
    expect(await codesFor(f.memberA)).toEqual([]);
    expect(await codesFor(f.removedA)).toEqual([]);
    expect(await codesFor(f.outsider)).toEqual([]);
  });

  it('invitation_codes: a removed organizer loses access', async () => {
    const f = await twoCommunities();
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [f.organizerA]);

    expect(await asUser(f.organizerA, (db) => ids(db, 'select id from public.invitation_codes'))).toEqual([]);
    expect(await asUser(f.organizerA, (db) => ids(db, 'select id from public.invitation_redemptions'))).toEqual([]);
  });

  it('invitation_redemptions: only organizers of that community can read them', async () => {
    const f = await twoCommunities();
    const redeemersFor = (viewer: string) =>
      asUser(viewer, (db) => ids(db, 'select user_id as id from public.invitation_redemptions'));

    expect(await redeemersFor(f.organizerA)).toEqual([f.memberA]);
    expect(await redeemersFor(f.organizerB)).toEqual([f.memberB]);
    expect(await redeemersFor(f.memberA)).toEqual([]);
    expect(await redeemersFor(f.outsider)).toEqual([]);
  });

  it('helpers answer for the caller only', async () => {
    const f = await twoCommunities();
    const check = (viewer: string, fn: string, communityId: string) =>
      asUser(viewer, (db) => rpc<boolean>(db, fn, [communityId]));

    expect(await check(f.memberA, 'is_active_member', f.a.communityId)).toBe(true);
    expect(await check(f.memberA, 'is_active_member', f.b.communityId)).toBe(false);
    expect(await check(f.memberA, 'is_organizer', f.a.communityId)).toBe(false);
    expect(await check(f.organizerA, 'is_organizer', f.a.communityId)).toBe(true);
    expect(await check(f.organizerA, 'is_organizer', f.b.communityId)).toBe(false);
    expect(await check(f.removedA, 'is_active_member', f.a.communityId)).toBe(false);
    expect(await check(f.outsider, 'is_active_member', f.a.communityId)).toBe(false);
  });

  it('the "my memberships" read from the contract works under RLS', async () => {
    const f = await twoCommunities();

    const { rows } = await asUser(f.memberA, (db) =>
      db.query(
        `select m.role, m.status, c.name, c.timezone
         from public.memberships m
         join public.communities c on c.id = m.community_id
         where m.user_id = auth.uid()`,
      ),
    );

    expect(rows).toEqual([
      { role: 'member', status: 'active', name: 'Alpha Pack', timezone: 'Europe/Bucharest' },
    ]);
  });
});

describe('service_role', () => {
  it('bypasses RLS for administration', async () => {
    const f = await twoCommunities();

    const communities = await asService((db) => ids(db, 'select id from public.communities'));

    expect(communities).toEqual([f.a.communityId, f.b.communityId].sort());
  });
});
