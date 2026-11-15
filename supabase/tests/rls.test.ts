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
  createTraining,
  createUser,
  type Db,
  getSession,
  INSUFFICIENT_PRIVILEGE,
  insertInvitation,
  resetData,
  rpc,
  setRsvp,
} from './helpers';

const TABLES = [
  'communities',
  'profiles',
  'memberships',
  'invitation_codes',
  'invitation_redemptions',
  'invitation_attempts',
  'training_sessions',
  'training_rsvps',
  'attendance_records',
  'attendance_audit_log',
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

describe('trainings and RSVPs under RLS', () => {
  /** Two communities, each with one session and one going RSVP. */
  async function twoCommunitiesWithSessions() {
    const f = await twoCommunities();
    const sessionA = await createTraining(f.organizerA, f.a.communityId, { title: 'Alpha run' });
    const sessionB = await createTraining(f.organizerB, f.b.communityId, { title: 'Beta run' });
    await setRsvp(f.memberA, sessionA.id, 'going');
    await setRsvp(f.memberB, sessionB.id, 'going');
    return { ...f, sessionA, sessionB };
  }

  it('training_sessions: only active members of the community can read them', async () => {
    const f = await twoCommunitiesWithSessions();
    const sessionsFor = (viewer: string) =>
      asUser(viewer, (db) => ids(db, 'select id from public.training_sessions'));

    expect(await sessionsFor(f.memberA)).toEqual([f.sessionA.id]);
    expect(await sessionsFor(f.organizerA)).toEqual([f.sessionA.id]);
    expect(await sessionsFor(f.memberB)).toEqual([f.sessionB.id]);
    expect(await sessionsFor(f.removedA)).toEqual([]);
    expect(await sessionsFor(f.outsider)).toEqual([]);
    expect(
      await asUser(f.memberA, (db) =>
        ids(db, 'select id from public.training_sessions where id = $1', [f.sessionB.id]),
      ),
    ).toEqual([]);
  });

  it('training_rsvps: only active members of the community can read them', async () => {
    const f = await twoCommunitiesWithSessions();
    const rsvpsFor = (viewer: string) =>
      asUser(viewer, (db) => ids(db, 'select user_id as id from public.training_rsvps'));

    expect(await rsvpsFor(f.organizerA)).toEqual([f.memberA]);
    expect(await rsvpsFor(f.memberA)).toEqual([f.memberA]);
    expect(await rsvpsFor(f.organizerB)).toEqual([f.memberB]);
    expect(await rsvpsFor(f.removedA)).toEqual([]);
    expect(await rsvpsFor(f.outsider)).toEqual([]);
  });

  it('the contract reads work under RLS: upcoming sessions, my RSVPs, participants with names', async () => {
    const f = await twoCommunitiesWithSessions();

    const rows = await asUser(f.organizerA, async (db) => {
      const upcoming = await db.query(
        'select title from public.training_sessions where community_id = $1 and starts_at > now() order by starts_at',
        [f.a.communityId],
      );
      const mine = await db.query('select response from public.training_rsvps where user_id = auth.uid()');
      const participants = await db.query(
        `select p.display_name, r.response
         from public.training_rsvps r
         join public.profiles p on p.id = r.user_id
         where r.session_id = $1`,
        [f.sessionA.id],
      );
      return { upcoming: upcoming.rows, mine: mine.rows, participants: participants.rows };
    });

    expect(rows).toEqual({
      upcoming: [{ title: 'Alpha run' }],
      mine: [],
      participants: [{ display_name: 'Mihai A', response: 'going' }],
    });
  });

  it('activity_types: readable by any authenticated user, seeded, and not writable', async () => {
    const outsider = await createUser();

    const keys = await asUser(outsider, (db) =>
      ids(db, 'select key as id from public.activity_types'),
    );

    expect(keys).toEqual(['functional_fitness', 'ocr', 'other', 'running', 'strength', 'trail_running']);
    for (const sql of [
      "insert into public.activity_types (key, label) values ('golf', 'Golf')",
      "update public.activity_types set label = 'x'",
      'delete from public.activity_types',
      'truncate table public.activity_types cascade',
    ]) {
      await expect(asUser(outsider, (db) => db.query(sql)), sql).rejects.toMatchObject(denied);
    }
    for (const sql of ['select * from public.activity_types', 'delete from public.activity_types']) {
      await expect(asAnon((db) => db.query(sql)), sql).rejects.toMatchObject(denied);
    }
  });

  it('an organizer cannot write going_count, status or the deadline directly', async () => {
    const f = await twoCommunitiesWithSessions();
    const before = await getSession(f.sessionA.id);

    for (const sql of [
      'update public.training_sessions set going_count = 99 where id = $1',
      "update public.training_sessions set status = 'confirmed' where id = $1",
      "update public.training_sessions set rsvp_deadline = now() + interval '30 days' where id = $1",
      'update public.training_sessions set min_participants = 1 where id = $1',
      'delete from public.training_sessions where id = $1',
    ]) {
      await expect(
        asUser(f.organizerA, (db) => db.query(sql, [f.sessionA.id])),
        sql,
      ).rejects.toMatchObject(denied);
    }
    expect(await getSession(f.sessionA.id)).toEqual(before);
  });

  it('a member cannot write RSVP rows directly, for themselves or for others', async () => {
    const f = await twoCommunitiesWithSessions();
    const attempts: [string, unknown[]][] = [
      [
        "insert into public.training_rsvps (session_id, community_id, user_id, response) values ($1, $2, $3, 'going')",
        [f.sessionA.id, f.a.communityId, f.organizerA],
      ],
      ["update public.training_rsvps set response = 'not_going' where session_id = $1", [f.sessionA.id]],
      ['delete from public.training_rsvps where session_id = $1', [f.sessionA.id]],
    ];

    for (const [sql, params] of attempts) {
      await expect(asUser(f.memberA, (db) => db.query(sql, params)), sql).rejects.toMatchObject(denied);
    }
    expect(await countRows('training_rsvps', "response = 'going'")).toBe(2);
  });

  it('publishes training_sessions and training_rsvps to supabase_realtime', async () => {
    const { rows } = await admin.query<{ tablename: string }>(
      "select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' order by tablename",
    );
    expect(rows.map((row) => row.tablename)).toEqual(['attendance_records', 'memberships', 'training_rsvps', 'training_sessions']);
  });

  it('grants finalize_due_sessions to service_role only, and schedules nothing without pg_cron', async () => {
    const { rows } = await admin.query<{ role: string; allowed: boolean }>(
      `select r as role, has_function_privilege(r, 'public.finalize_due_sessions()', 'execute') as allowed
       from unnest(array['anon', 'authenticated', 'service_role']) r`,
    );
    expect(rows).toEqual([
      { role: 'anon', allowed: false },
      { role: 'authenticated', allowed: false },
      { role: 'service_role', allowed: true },
    ]);
    // The scheduling migration must be a clean no-op on a database without pg_cron.
    const cron = await admin.query("select 1 from pg_namespace where nspname = 'cron'");
    expect(cron.rows).toEqual([]);
  });
});
