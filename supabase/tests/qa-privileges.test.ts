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
  // GDPR G2: role management, export and deletion.
  delete_my_account: 'authenticated',
  export_my_data: 'authenticated',
  leave_community: 'authenticated',
  my_deletion_blockers: 'authenticated',
  remove_member: 'authenticated',
  set_member_role: 'authenticated',
  // P4: event feed.
  create_event_post: 'authenticated',
  delete_event_post: 'authenticated',
  get_event_feed: 'authenticated',
  get_event_feed_unread: 'authenticated',
  mark_event_feed_read: 'authenticated',
  reply_to_event_post: 'authenticated',
  // P3: About you.
  clear_my_about_you: 'authenticated',
  get_community_demographics: 'authenticated',
  get_member_emergency_info: 'authenticated',
  get_my_about_you: 'authenticated',
  list_community_emergency_info: 'authenticated',
  save_my_about_you: 'authenticated',
  // P5: workout logs and statistics.
  delete_my_workout_log: 'authenticated',
  enqueue_workout_log_prompts: 'service_role',
  get_community_workout_stats: 'authenticated',
  get_my_workout_log: 'authenticated',
  get_my_workout_stats: 'authenticated',
  list_my_workout_logs: 'authenticated',
  save_workout_log: 'authenticated',
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
  // G2: an organizer changes another member's role or removes them. `p_role` is the new role.
  remove_member: ['p_user_id'],
  set_member_role: ['p_user_id', 'p_role'],
  // P3: an organizer reads one active member's emergency contact / T-shirt size (read-only).
  get_member_emergency_info: ['p_user_id'],
};

/** Where each target-member function checks that the caller is an active organizer. */
const ORGANIZER_CHECK: Record<string, string> = {
  add_walk_in_attendee: 'private.authorize_attendance(p_session_id)',
  record_attendance: 'private.authorize_attendance(p_session_id)',
  get_member_attendance_history: 'not public.is_organizer(p_community_id)',
  get_member_statistics: 'not public.is_organizer(p_community_id)',
  // G2: checked before the locks and again after them (private.lock_caller_organizer).
  remove_member: 'not public.is_organizer(p_community_id)',
  set_member_role: 'not public.is_organizer(p_community_id)',
  get_member_emergency_info: 'not public.is_organizer(p_community_id)',
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
      ['select public.set_member_role($1, $2, $3)', [communityId, organizerId, 'member']],
      ['select public.remove_member($1, $2)', [communityId, organizerId]],
      ['select public.leave_community($1)', [communityId]],
      ['select public.export_my_data()', []],
      ['select public.my_deletion_blockers()', []],
      ['select public.delete_my_account()', []],
      ['select public.create_event_post($1, $2)', [session.id, 'Hi']],
      ['select public.reply_to_event_post($1, $2)', [session.id, 'Hi']],
      ['select public.delete_event_post($1)', [session.id]],
      ['select public.mark_event_feed_read($1)', [session.id]],
      ['select public.get_event_feed($1)', [session.id]],
      ['select public.get_event_feed_unread($1)', [communityId]],
      ['select public.get_my_about_you()', []],
      ['select public.save_my_about_you($1)', ['{}']],
      ['select public.clear_my_about_you()', []],
      ['select public.get_member_emergency_info($1, $2)', [communityId, organizerId]],
      ['select public.list_community_emergency_info($1)', [communityId]],
      ['select public.get_community_demographics($1)', [communityId]],
      ['select public.save_workout_log($1, $2)', [session.id, '{}']],
      ['select public.get_my_workout_log($1)', [session.id]],
      ['select public.delete_my_workout_log($1)', [session.id]],
      ['select public.list_my_workout_logs($1, $2)', [20, null]],
      ['select public.get_my_workout_stats($1, $2, $3)', [communityId, null, null]],
      ['select public.get_community_workout_stats($1, $2)', [communityId, '30d']],
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
    await expect(
      asUser(organizerId, (db) => db.query('select public.enqueue_workout_log_prompts()')),
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

  it('the event subtypes lookup: authenticated SELECT only (RLS on); anon and service_role nothing (P1)', async () => {
    const { rows } = await admin.query<{ role: string; privilege: string }>(
      `select r.role, p.privilege
       from unnest(array['anon', 'authenticated', 'service_role']) as r(role)
       cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege)
       where (has_table_privilege(r.role, 'public.event_subtypes', p.privilege)
              or (p.privilege in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                  and has_any_column_privilege(r.role, 'public.event_subtypes', p.privilege)))
       order by 1, 2`,
    );
    expect(rows).toEqual([{ role: 'authenticated', privilege: 'SELECT' }]);
    const { rows: rls } = await admin.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where oid = 'public.event_subtypes'::regclass",
    );
    expect(rls).toEqual([{ relrowsecurity: true }]);
  });

  it('the event feed tables: authenticated SELECT only, anon nothing, RLS on, one own-scope policy each (P4)', async () => {
    const { rows } = await admin.query<{ role: string; table: string; privilege: string }>(
      `select r.role, t.name as table, p.privilege
       from unnest(array['anon', 'authenticated']) as r(role)
       cross join unnest(array['event_posts', 'event_feed_reads']) as t(name)
       cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege)
       where has_table_privilege(r.role, 'public.' || t.name, p.privilege)
          or (p.privilege in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
              and has_any_column_privilege(r.role, 'public.' || t.name, p.privilege))
       order by 1, 2, 3`,
    );
    expect(rows).toEqual([
      { role: 'authenticated', table: 'event_feed_reads', privilege: 'SELECT' },
      { role: 'authenticated', table: 'event_posts', privilege: 'SELECT' },
    ]);
    const { rows: rls } = await admin.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
       where oid in ('public.event_posts'::regclass, 'public.event_feed_reads'::regclass) order by relname`,
    );
    expect(rls.every((r) => r.relrowsecurity)).toBe(true);
    const { rows: policies } = await admin.query<{ tablename: string; policyname: string; cmd: string; qual: string }>(
      `select tablename, policyname, cmd, qual from pg_policies
       where schemaname = 'public' and tablename in ('event_posts', 'event_feed_reads') order by tablename`,
    );
    expect(policies.map((p) => [p.tablename, p.policyname, p.cmd])).toEqual([
      ['event_feed_reads', 'event_feed_reads_select_own', 'SELECT'],
      ['event_posts', 'event_posts_select_members', 'SELECT'],
    ]);
    expect(policies[0].qual).toContain('auth.uid()');
    expect(policies[1].qual).toContain('is_active_member(community_id)');
  });

  it('the data-export log in private grants nothing to any API role (G2)', async () => {
    const { rows } = await admin.query<{ role: string; privilege: string }>(
      `select r.role, p.privilege
       from unnest(array['anon', 'authenticated', 'service_role']) as r(role)
       cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege)
       where has_table_privilege(r.role, 'private.data_export_log', p.privilege)
          or (p.privilege in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
              and has_any_column_privilege(r.role, 'private.data_export_log', p.privilege))`,
    );
    expect(rows).toEqual([]);
  });

  it('the About-you table in private grants nothing to any API role (P3)', async () => {
    const { rows } = await admin.query<{ role: string; privilege: string }>(
      `select r.role, p.privilege
       from unnest(array['anon', 'authenticated', 'service_role']) as r(role)
       cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege)
       where has_table_privilege(r.role, 'private.member_about_you', p.privilege)
          or (p.privilege in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
              and has_any_column_privilege(r.role, 'private.member_about_you', p.privilege))`,
    );
    expect(rows).toEqual([]);
  });

  it('the workout log tables in private grant nothing to any API role (P5)', async () => {
    const { rows } = await admin.query<{ role: string; table: string; privilege: string }>(
      `select r.role, t.name as table, p.privilege
       from unnest(array['anon', 'authenticated', 'service_role']) as r(role)
       cross join unnest(array['private.workout_logs', 'private.workout_prompt_runs']) as t(name)
       cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege)
       where has_table_privilege(r.role, t.name, p.privilege)
          or (p.privilege in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
              and has_any_column_privilege(r.role, t.name, p.privilege))`,
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
