import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  admin,
  asService,
  asUser,
  closeDb,
  createPack,
  createTraining,
  INSUFFICIENT_PRIVILEGE,
  resetData,
} from './helpers';

/**
 * QA (M1-Q1): exact privilege matrix. The developers' test uses `arrayContaining`, which would
 * still pass if an extra function became executable. These tests pin the complete picture.
 */

const denied = { code: INSUFFICIENT_PRIVILEGE };

/** Every function in `public`, and the single API role that may execute it. */
const PUBLIC_FUNCTIONS: Record<string, 'authenticated' | 'service_role'> = {
  add_walk_in_attendee: 'authenticated',
  admin_create_community: 'service_role',
  // C1: creator codes and community management.
  admin_create_creator_code: 'service_role',
  admin_revoke_creator_code: 'service_role',
  create_community_with_code: 'authenticated',
  list_my_communities: 'authenticated',
  preview_creator_code: 'authenticated',
  update_community: 'authenticated',
  // GDPR G1: legal versions and the consent ledger.
  admin_set_legal_version: 'service_role',
  my_consents: 'authenticated',
  record_consent: 'authenticated',
  withdraw_consent: 'authenticated',
  cancel_announcement: 'authenticated',
  cancel_training: 'authenticated',
  claim_notification_jobs: 'service_role',
  complete_notification_job: 'service_role',
  create_announcement: 'authenticated',
  create_invitation: 'authenticated',
  create_training: 'authenticated',
  enqueue_due_training_reminders: 'service_role',
  finalize_attendance: 'authenticated',
  finalize_due_sessions: 'service_role',
  get_attendance_sheet: 'authenticated',
  get_community_statistics: 'authenticated',
  get_member_attendance_history: 'authenticated',
  get_member_statistics: 'authenticated',
  get_my_attendance_history: 'authenticated',
  get_my_statistics: 'authenticated',
  get_notification_preferences: 'authenticated',
  invalidate_push_tokens: 'service_role',
  is_active_member: 'authenticated',
  is_organizer: 'authenticated',
  list_member_statistics_summary: 'authenticated',
  mark_all_notifications_read: 'authenticated',
  mark_announcement_read: 'authenticated',
  mark_announcements_read: 'authenticated',
  mark_notification_read: 'authenticated',
  preview_invitation: 'authenticated',
  publish_due_announcements: 'service_role',
  purge_old_notification_data: 'service_role',
  record_attendance: 'authenticated',
  redeem_invitation: 'authenticated',
  register_push_token: 'authenticated',
  revoke_invitation: 'authenticated',
  set_notification_preferences: 'authenticated',
  set_rsvp: 'authenticated',
  unread_announcement_count: 'authenticated',
  unregister_push_token: 'authenticated',
  update_announcement: 'authenticated',
  update_display_name: 'authenticated',
  update_training: 'authenticated',
};

/**
 * M2 exception to "no user id parameter": organizer RPCs that act ON a member (whose attendance
 * is being recorded) take that member's id. The caller is still auth.uid(); see the test below.
 */
const TARGET_USER_ARGS: Record<string, string[]> = {
  add_walk_in_attendee: ['p_user_id'],
  record_attendance: ['p_user_id'],
  // M4: an organizer reads one member's statistics (read-only).
  get_member_attendance_history: ['p_user_id'],
  get_member_statistics: ['p_user_id'],
};

/** Where each target-member function checks that the caller is an active organizer. */
const ORGANIZER_CHECK: Record<string, string> = {
  add_walk_in_attendee: 'private.authorize_attendance(p_session_id)',
  record_attendance: 'private.authorize_attendance(p_session_id)',
  get_member_attendance_history: 'not public.is_organizer(p_community_id)',
  get_member_statistics: 'not public.is_organizer(p_community_id)',
};

interface FunctionRow {
  schema: string;
  name: string;
  args: string;
  anon: boolean;
  authenticated: boolean;
  service_role: boolean;
  everyone: boolean;
  definer: boolean;
  config: string[] | null;
  source: string;
  arg_names: string[] | null;
}

async function functions(): Promise<FunctionRow[]> {
  const { rows } = await admin.query<FunctionRow>(
    `select n.nspname as schema, p.proname as name,
            pg_get_function_identity_arguments(p.oid) as args,
            has_function_privilege('anon', p.oid, 'execute') as anon,
            has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
            has_function_privilege('service_role', p.oid, 'execute') as service_role,
            has_function_privilege('public', p.oid, 'execute') as everyone,
            p.prosecdef as definer, p.proconfig as config, p.prosrc as source,
            p.proargnames as arg_names
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private')
     order by 1, 2`,
  );
  return rows;
}

beforeEach(resetData);
afterAll(closeDb);

describe('QA function privileges', () => {
  it('public contains exactly the contract functions, with no overloads', async () => {
    const names = (await functions()).filter((f) => f.schema === 'public').map((f) => f.name);
    expect(names).toEqual(Object.keys(PUBLIC_FUNCTIONS).sort());
  });

  it('every public function is executable by exactly one API role, and never by anon or PUBLIC', async () => {
    const actual = (await functions())
      .filter((f) => f.schema === 'public')
      .map((f) => ({
        name: f.name,
        anon: f.anon,
        everyone: f.everyone,
        authenticated: f.authenticated,
        service_role: f.service_role,
      }));
    const expected = Object.entries(PUBLIC_FUNCTIONS)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, role]) => ({
        name,
        anon: false,
        everyone: false,
        authenticated: role === 'authenticated',
        service_role: role === 'service_role',
      }));
    expect(actual).toEqual(expected);
  });

  it('no private function is executable by any API role or PUBLIC', async () => {
    const reachable = (await functions())
      .filter((f) => f.schema === 'private')
      .filter((f) => f.anon || f.authenticated || f.service_role || f.everyone)
      .map((f) => `${f.name}(${f.args})`);
    expect(reachable).toEqual([]);
  });

  it('API roles have no usage on private and cannot create objects in public or private', async () => {
    const { rows } = await admin.query<{ role: string; privilege: string }>(
      `select r.role, x.privilege
       from unnest(array['anon', 'authenticated', 'service_role']) as r(role),
            (values ('private', 'usage'), ('private', 'create'), ('public', 'create')) as x(schema, privilege)
       where has_schema_privilege(r.role, x.schema, x.privilege)`,
    );
    expect(rows).toEqual([]);
  });

  it('every function in public and private pins search_path to empty; public ones are security definer', async () => {
    const all = await functions();
    const unpinned = all.filter((f) => !(f.config ?? []).includes('search_path=""')).map((f) => f.name);
    expect(unpinned).toEqual([]);
    const invoker = all.filter((f) => f.schema === 'public' && !f.definer).map((f) => f.name);
    expect(invoker).toEqual([]);
  });

  it('no function builds dynamic SQL', async () => {
    // The one exception: the instant-dispatch trigger function reaches pg_net and Vault only
    // through dynamic SQL so that it compiles (and is a no-op) where those do not exist. Its
    // dynamic statements are constant text with bind parameters (pinned in
    // instant-dispatch.test.ts); it is private and not executable by any API role.
    const ALLOWED_DYNAMIC = ['private.trigger_instant_dispatch'];
    const dynamic = (await functions())
      .filter((f) => /\bexecute\b/i.test(f.source))
      .map((f) => `${f.schema}.${f.name}`)
      .filter((name) => !ALLOWED_DYNAMIC.includes(name));
    expect(dynamic).toEqual([]);
  });

  it('no public function accepts a user id: the caller is always auth.uid()', async () => {
    const suspicious = (await functions())
      .filter((f) => f.schema === 'public')
      .filter((f) =>
        (f.arg_names ?? []).some(
          (arg) =>
            /user|uid|profile|member|organizer_id|role/i.test(arg) &&
            !TARGET_USER_ARGS[f.name]?.includes(arg),
        ),
      )
      .map((f) => `${f.name}(${f.args})`);
    expect(suspicious).toEqual([]);
  });

  it('functions that name a target member still take the caller from auth.uid() and require an organizer', async () => {
    const all = (await functions()).filter((f) => f.schema === 'public');
    for (const name of Object.keys(TARGET_USER_ARGS)) {
      const fn = all.find((f) => f.name === name);
      expect(fn, name).toBeDefined();
      expect(fn!.source, name).toMatch(/v_uid uuid := auth\.uid\(\);/);
      // M2: the organizer check lives in private.authorize_attendance (pinned in attendance
      // tests); M4: get_member_statistics checks is_organizer itself (stats-security tests).
      expect(fn!.source, name).toContain(ORGANIZER_CHECK[name]);
      // The target id is never used as the actor of a write.
      expect(fn!.source, name).not.toMatch(/recorded_by\s*=\s*p_user_id|changed_by\s*=\s*p_user_id/);
    }
  });

  it('service_role cannot call the user RPCs (they would run with no caller identity)', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId);
    const calls: [string, unknown[]][] = [
      ['select public.set_rsvp($1, $2)', [session.id, 'going']],
      ['select public.cancel_training($1)', [session.id]],
      ['select public.update_training($1, $2)', [session.id, '{}']],
      ['select public.create_training($1, $2)', [communityId, '{}']],
      ['select public.create_invitation($1)', [communityId]],
      ['select public.redeem_invitation($1, $2)', ['AAAAAAAA', 'Ana']],
      ['select public.preview_invitation($1)', ['AAAAAAAA']],
      ['select public.update_display_name($1)', ['Ana']],
      ['select public.is_organizer($1)', [communityId]],
      ['select public.record_attendance($1, $2, $3)', [session.id, organizerId, 'present']],
      ['select public.add_walk_in_attendee($1, $2)', [session.id, organizerId]],
      ['select public.finalize_attendance($1)', [session.id]],
      ['select public.get_attendance_sheet($1)', [session.id]],
      ['select public.get_my_statistics($1, $2)', [communityId, '30d']],
      ['select public.get_my_attendance_history($1, $2)', [communityId, '30d']],
      ['select public.get_member_statistics($1, $2, $3)', [communityId, organizerId, '30d']],
      ['select public.get_member_attendance_history($1, $2, $3)', [communityId, organizerId, '30d']],
      ['select public.get_community_statistics($1, $2)', [communityId, '30d']],
      ['select public.list_member_statistics_summary($1, $2)', [communityId, '30d']],
      ['select public.preview_creator_code($1)', ['AAAAAAAA']],
      [
        'select public.create_community_with_code($1, $2, $3, $4, $5)',
        ['AAAAAAAA', 'Pack', 'UTC', 'Ana', '00000000-0000-0000-0000-000000000001'],
      ],
      ['select public.update_community($1, $2, $3)', [communityId, 'Pack', 'UTC']],
      ['select public.list_my_communities()', []],
      ['select public.record_consent($1)', ['age_16']],
      ['select public.withdraw_consent($1)', ['workout_logs']],
      ['select public.my_consents()', []],
    ];
    for (const [sql, params] of calls) {
      await expect(asService((db) => db.query(sql, params)), sql).rejects.toMatchObject(denied);
    }
  });

  it('an organizer cannot call the service-only functions', async () => {
    const { organizerId } = await createPack();
    await expect(
      asUser(organizerId, (db) => db.query("select public.admin_create_community('Mine', 'UTC')")),
    ).rejects.toMatchObject(denied);
    await expect(
      asUser(organizerId, (db) => db.query('select public.finalize_due_sessions()')),
    ).rejects.toMatchObject(denied);
    await expect(
      asUser(organizerId, (db) => db.query("select public.admin_create_creator_code('mine', 14, 1)")),
    ).rejects.toMatchObject(denied);
    await expect(
      asUser(organizerId, (db) => db.query("select public.admin_revoke_creator_code('AAAAAAAA')")),
    ).rejects.toMatchObject(denied);
    await expect(
      asUser(organizerId, (db) => db.query("select public.admin_set_legal_version('terms', '9')")),
    ).rejects.toMatchObject(denied);
  });
});

describe('QA table privileges', () => {
  it('authenticated holds SELECT only, anon nothing, on every public table (table and column level)', async () => {
    const { rows } = await admin.query<{ role: string; table: string; privilege: string }>(
      `select r.role, c.relname as table, p.privilege
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join unnest(array['anon', 'authenticated']) as r(role)
       cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege)
       where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
         and (has_table_privilege(r.role, c.oid, p.privilege)
              or (p.privilege in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                  and has_any_column_privilege(r.role, c.oid, p.privilege)))
         and not (r.role = 'authenticated' and p.privilege = 'SELECT'
                  and c.relname not in ('invitation_attempts', 'notification_delivery_jobs',
                                        'community_creator_codes', 'community_creator_redemptions'))
       order by 1, 2, 3`,
    );
    expect(rows).toEqual([]);
  });

  it('the creator code tables grant nothing to any API role, service_role included (C1)', async () => {
    const { rows } = await admin.query<{ role: string; table: string; privilege: string }>(
      `select r.role, t.name as table, p.privilege
       from unnest(array['anon', 'authenticated', 'service_role']) as r(role)
       cross join unnest(array['community_creator_codes', 'community_creator_redemptions']) as t(name)
       cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege)
       where has_table_privilege(r.role, 'public.' || t.name, p.privilege)
          or (p.privilege in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
              and has_any_column_privilege(r.role, 'public.' || t.name, p.privilege))`,
    );
    expect(rows).toEqual([]);
  });

  it('the consent ledger and legal versions: authenticated SELECT only; service_role and anon nothing (G1)', async () => {
    const { rows } = await admin.query<{ role: string; table: string; privilege: string }>(
      `select r.role, t.name as table, p.privilege
       from unnest(array['anon', 'authenticated', 'service_role']) as r(role)
       cross join unnest(array['consent_records', 'legal_documents']) as t(name)
       cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege)
       where (has_table_privilege(r.role, 'public.' || t.name, p.privilege)
              or (p.privilege in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                  and has_any_column_privilege(r.role, 'public.' || t.name, p.privilege)))
         and not (r.role = 'authenticated' and p.privilege = 'SELECT')
       order by 1, 2, 3`,
    );
    expect(rows).toEqual([]);
  });

  it('public holds no views or sequences that could bypass RLS', async () => {
    const { rows } = await admin.query<{ relname: string; relkind: string }>(
      `select c.relname, c.relkind from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('v', 'm', 'S', 'f')`,
    );
    expect(rows).toEqual([]);
  });

  it('every policy is a SELECT policy for authenticated only', async () => {
    const { rows } = await admin.query<{ policyname: string }>(
      `select policyname from pg_policies
       where schemaname = 'public' and (cmd <> 'SELECT' or roles <> '{authenticated}' or permissive <> 'PERMISSIVE')`,
    );
    expect(rows).toEqual([]);
  });
});
