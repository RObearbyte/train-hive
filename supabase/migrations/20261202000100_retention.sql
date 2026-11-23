-- TrainHive G3: retention of inactive anonymous accounts (docs/GDPR_PLAN.md section 4 item 6,
-- "Retention" default). Contract: docs/API_CONTRACT.md ("Retention (G3)"). Register of every
-- table and its retention: docs/RECORD_OF_PROCESSING.md section 7.
--
--   private.retention_settings   one row: the kill switch. inactive_erasure_enabled is FALSE by
--                                default: erasing members automatically is a decision the owner
--                                takes consciously (admin_set_retention_enabled(true)).
--   private.account_activity     one row per account that opened the app (record_app_open) or got
--                                an inactivity notice. Deleted with the auth user (cascade).
--   private.retention_runs       one row per enabled run of the job: counts only, no user ids.
--
--   record_app_open()                     authenticated: the app calls it on start / return to
--                                         the foreground; records "the app was opened" (at most
--                                         one write per hour) and ends a pending notice. Returns
--                                         the notice that was pending, for a one-time banner.
--   retention_preview()                   service_role: counts only, nothing is written (dry run).
--   run_account_retention()               service_role / pg_cron daily 03:41 UTC.
--   admin_set_retention_enabled(boolean)  service_role: the kill switch. Switching off also
--                                         clears every pending notice.
--
-- Activity signal (private.account_last_activity, computed when the job runs, so no existing RPC
-- had to change): the latest of
--   auth.users.created_at and last_sign_in_at; account_activity.last_app_open_at;
--   profiles.updated_at; memberships.joined_at; consent_records.created_at;
--   device_push_tokens.last_seen_at (refreshed on every app start when push is on);
--   training_rsvps.updated_at; attendance_records.updated_at of the member's PRESENT records;
--   attendance_records.updated_at the member recorded (organizers); notifications.read_at;
--   announcement_reads.read_at; event_feed_reads.last_read_at; event_posts.created_at (author);
--   announcements.updated_at and training_sessions.updated_at (author / organizer);
--   private.workout_logs.updated_at; private.member_about_you.updated_at;
--   private.data_export_log.requested_at; invitation_attempts.attempted_at.
-- Limits: a member who only READS in an app version that does not call record_app_open, with push
-- off, leaves no trace and looks inactive. auth.sessions (token refreshes) would catch that but its
-- columns differ between Supabase Auth versions, so it is not used (see the contract). Some signals
-- move on someone else's action (an organizer editing an old attendance record, another organizer
-- editing an event): they can only keep an account longer, never erase it earlier.
--
-- Rule (only while enabled): an anonymous account (auth.users.is_anonymous) with no activity for
-- 24 months gets a notice (account_activity.inactivity_notice_at = now()). Any activity ends the
-- notice (record_app_open at once, anything else at the next run). An account whose notice is
-- 30 days old and that is still inactive is erased with private.erase_user, exactly like
-- delete_my_account (attendance anonymized, sole-member communities deleted, auth user deleted).
-- The last active organizer of a community with other active members cannot be erased
-- (last_organizer): counted as blocked, the notice stays, retried every run. At most 100 erasures
-- per run (the rest next day). Linked (non-anonymous) accounts are out of scope until the app can
-- send them a notice by e-mail.
--
-- Lock order: the job takes the settings row (one run at a time, serialized with the kill switch),
-- then per account private.lock_user_for_erasure (the erasure order), re-checks the activity under
-- those locks, then erases. record_app_open key-share-locks the auth user first, so it either
-- commits before the erasure's FOR UPDATE (and the re-check sees it) or finds the account gone
-- (not_authenticated). lock_timeout 5 s inside the job: an account whose rows are busy is skipped
-- (deferred) and retried the next day.
--
-- GDPR: export_my_data gains extensions.account_activity; erasure needs no change (cascade from
-- auth.users).

-- Settings (kill switch) -------------------------------------------------------------------------

create table private.retention_settings (
  id boolean primary key default true,
  inactive_erasure_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint retention_settings_single_row check (id)
);
insert into private.retention_settings (id) values (true);
revoke all on table private.retention_settings from public, anon, authenticated, service_role;

-- Per-account activity and notice -----------------------------------------------------------------

create table private.account_activity (
  user_id uuid primary key references auth.users (id) on delete cascade,
  last_app_open_at timestamptz,
  inactivity_notice_at timestamptz
);
create index account_activity_notice_idx
  on private.account_activity (inactivity_notice_at)
  where inactivity_notice_at is not null;
revoke all on table private.account_activity from public, anon, authenticated, service_role;

-- Run log (counts only) ---------------------------------------------------------------------------

create table private.retention_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  notices_created integer not null,
  notices_cleared integer not null,
  accounts_erased integer not null,
  communities_deleted integer not null,
  blocked_last_organizer integer not null,
  deferred integer not null
);
revoke all on table private.retention_runs from public, anon, authenticated, service_role;

-- Policy constants --------------------------------------------------------------------------------

create function private.retention_inactive_after() returns interval
language sql
immutable
set search_path = ''
as $$
  select interval '24 months'
$$;

create function private.retention_notice_period() returns interval
language sql
immutable
set search_path = ''
as $$
  select interval '30 days'
$$;

-- Activity ----------------------------------------------------------------------------------------
-- The latest trace of the account (see the header). Never null for an existing auth user
-- (created_at); null when the auth user does not exist.

create function private.account_last_activity(p_user_id uuid) returns timestamptz
language sql
stable
set search_path = ''
as $$
  select max(x.at)
  from (
    select u.created_at as at from auth.users u where u.id = p_user_id
    union all select u.last_sign_in_at from auth.users u where u.id = p_user_id
    union all select a.last_app_open_at from private.account_activity a where a.user_id = p_user_id
    union all select p.updated_at from public.profiles p where p.id = p_user_id
    union all select max(m.joined_at) from public.memberships m where m.user_id = p_user_id
    union all select max(c.created_at) from public.consent_records c where c.user_id = p_user_id
    union all select max(t.last_seen_at) from public.device_push_tokens t where t.user_id = p_user_id
    union all select max(r.updated_at) from public.training_rsvps r where r.user_id = p_user_id
    union all
      select max(ar.updated_at)
      from public.attendance_records ar
      where ar.user_id = p_user_id
        and ar.status = 'present'
    union all select max(ar.updated_at) from public.attendance_records ar where ar.recorded_by = p_user_id
    union all select max(n.read_at) from public.notifications n where n.user_id = p_user_id
    union all select max(rd.read_at) from public.announcement_reads rd where rd.user_id = p_user_id
    union all select max(fr.last_read_at) from public.event_feed_reads fr where fr.user_id = p_user_id
    union all select max(ep.created_at) from public.event_posts ep where ep.author_id = p_user_id
    union all select max(an.updated_at) from public.announcements an where an.author_id = p_user_id
    union all select max(s.updated_at) from public.training_sessions s where s.organizer_id = p_user_id
    union all select max(wl.updated_at) from private.workout_logs wl where wl.user_id = p_user_id
    union all select ay.updated_at from private.member_about_you ay where ay.user_id = p_user_id
    union all select max(el.requested_at) from private.data_export_log el where el.user_id = p_user_id
    union all select max(ia.attempted_at) from public.invitation_attempts ia where ia.user_id = p_user_id
  ) x
$$;

-- Anonymous accounts whose latest activity is before p_cutoff.
create function private.inactive_accounts(p_cutoff timestamptz)
returns table (user_id uuid, last_active_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select u.id, act.at
  from auth.users u
  cross join lateral (select private.account_last_activity(u.id) as at) act
  where u.is_anonymous
    and act.at < p_cutoff
$$;

-- record_app_open ---------------------------------------------------------------------------------
-- Errors: not_authenticated (no user, or the account no longer exists).
-- Returns AppOpenResult { inactivity_erasure_enabled, inactive_after_months: 24, notice_days: 30,
--   notice: { noticed_at, erase_after } | null }. `notice` is the inactivity notice that was
--   pending BEFORE this call; the call ends it, so the app shows it once ("we had planned to
--   delete this inactive account; because you are back, it is kept").

create function public.record_app_open() returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_notice timestamptz;
  v_enabled boolean;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  -- Serializes with an erasure (FOR UPDATE on the same row): either this commits first and the
  -- erasure's re-check sees it, or the account is gone.
  perform 1 from auth.users u where u.id = v_uid for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;

  select a.inactivity_notice_at into v_notice
  from private.account_activity a
  where a.user_id = v_uid
  for update;

  insert into private.account_activity as a (user_id, last_app_open_at)
  values (v_uid, now())
  on conflict (user_id) do update
    set last_app_open_at = excluded.last_app_open_at,
        inactivity_notice_at = null
    where a.inactivity_notice_at is not null
       or a.last_app_open_at is null
       or a.last_app_open_at < excluded.last_app_open_at - interval '1 hour';

  select s.inactive_erasure_enabled into v_enabled from private.retention_settings s where s.id;

  return jsonb_build_object(
    'inactivity_erasure_enabled', coalesce(v_enabled, false),
    'inactive_after_months', 24,
    'notice_days', 30,
    'notice', case
      when v_notice is null then null
      else jsonb_build_object(
        'noticed_at', v_notice,
        'erase_after', v_notice + private.retention_notice_period()
      )
    end
  );
end;
$$;

-- retention_preview -------------------------------------------------------------------------------
-- Dry run: counts only (no ids, no names), writes nothing. Shows what the job does when enabled.

create function public.retention_preview() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz := now() - private.retention_inactive_after();
  v_due timestamptz := now() - private.retention_notice_period();
  v_result jsonb;
begin
  with
  inactive as (
    select i.user_id,
           a.inactivity_notice_at as noticed_at,
           jsonb_array_length(private.deletion_blockers(i.user_id)) > 0 as blocked,
           coalesce(cardinality(private.sole_member_communities(i.user_id)), 0) as sole
    from private.inactive_accounts(v_cutoff) i
    left join private.account_activity a on a.user_id = i.user_id
  )
  select jsonb_build_object(
    'enabled', (select s.inactive_erasure_enabled from private.retention_settings s where s.id),
    'inactive_after_months', 24,
    'notice_days', 30,
    'generated_at', now(),
    'anonymous_accounts', (select count(*) from auth.users u where u.is_anonymous),
    'inactive_accounts', (select count(*) from inactive),
    'inactive_without_notice', (select count(*) from inactive where noticed_at is null),
    'notices_pending', (select count(*) from private.account_activity a where a.inactivity_notice_at is not null),
    'due_for_erasure', (select count(*) from inactive where noticed_at <= v_due and not blocked),
    'blocked_last_organizer', (select count(*) from inactive where blocked),
    'communities_deleted_with_due', (
      select coalesce(sum(sole), 0) from inactive where noticed_at <= v_due and not blocked
    ),
    'communities_of_inactive_sole_members', (select coalesce(sum(sole), 0) from inactive where not blocked),
    'last_run', (
      select to_jsonb(r) - 'id'
      from private.retention_runs r
      order by r.ran_at desc, r.id desc
      limit 1
    )
  ) into v_result;
  return v_result;
end;
$$;

-- run_account_retention ---------------------------------------------------------------------------
-- Daily (pg_cron). Disabled: returns { enabled: false } and writes nothing. Enabled: ends notices
-- of accounts that came back, gives new notices, erases accounts whose notice is 30 days old and
-- that are still inactive (at most 100 per run), logs the counts. Idempotent: a second run right
-- after the first changes nothing.
-- Returns { enabled, notices_created, notices_cleared, accounts_erased, communities_deleted,
--   blocked_last_organizer, deferred, due_remaining }.

create function public.run_account_retention() returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_max_erasures constant integer := 100;
  v_enabled boolean;
  v_cutoff timestamptz;
  v_due timestamptz;
  v_created integer := 0;
  v_cleared integer := 0;
  v_count integer;
  v_erased integer := 0;
  v_communities integer := 0;
  v_blocked integer := 0;
  v_deferred integer := 0;
  v_remaining integer := 0;
  v_user uuid;
  v_summary jsonb;
begin
  -- One run at a time; the kill switch waits for a running job and the job for the switch.
  select s.inactive_erasure_enabled into v_enabled
  from private.retention_settings s
  where s.id
  for update;

  if not coalesce(v_enabled, false) then
    return jsonb_build_object(
      'enabled', false, 'notices_created', 0, 'notices_cleared', 0, 'accounts_erased', 0,
      'communities_deleted', 0, 'blocked_last_organizer', 0, 'deferred', 0, 'due_remaining', 0
    );
  end if;

  perform set_config('lock_timeout', '5s', true);
  v_cutoff := now() - private.retention_inactive_after();
  v_due := now() - private.retention_notice_period();

  -- 1. Accounts that came back (or are no longer anonymous): the notice ends.
  update private.account_activity a
  set inactivity_notice_at = null
  where a.inactivity_notice_at is not null
    and (private.account_last_activity(a.user_id) >= v_cutoff
         or not exists (select 1 from auth.users u where u.id = a.user_id and u.is_anonymous));
  get diagnostics v_cleared = row_count;

  -- 2. New notices. Accounts that already have one are filtered out first, so this statement never
  -- locks the row of an account that step 3 may erase (record_app_open locks the auth user, then
  -- that row; step 3 locks the auth user first too).
  insert into private.account_activity as a (user_id, inactivity_notice_at)
  select i.user_id, now()
  from private.inactive_accounts(v_cutoff) i
  where not exists (
    select 1
    from private.account_activity x
    where x.user_id = i.user_id
      and x.inactivity_notice_at is not null
  )
  on conflict (user_id) do update
    set inactivity_notice_at = excluded.inactivity_notice_at
    where a.inactivity_notice_at is null;
  get diagnostics v_created = row_count;

  -- 3. Erasure of accounts whose notice ran out. The last organizer of a community with other
  -- active members is never erased (counted, notice kept).
  select count(*)::integer into v_blocked
  from private.account_activity a
  join auth.users u on u.id = a.user_id
  where u.is_anonymous
    and a.inactivity_notice_at <= v_due
    and jsonb_array_length(private.deletion_blockers(a.user_id)) > 0;

  for v_user in
    select a.user_id
    from private.account_activity a
    join auth.users u on u.id = a.user_id
    where u.is_anonymous
      and a.inactivity_notice_at <= v_due
      and jsonb_array_length(private.deletion_blockers(a.user_id)) = 0
    order by a.inactivity_notice_at, a.user_id
    limit c_max_erasures
  loop
    begin
      if private.lock_user_for_erasure(v_user) then
        -- Re-check under the erasure locks: activity committed meanwhile keeps the account.
        if private.account_last_activity(v_user) >= v_cutoff then
          update private.account_activity a
          set inactivity_notice_at = null
          where a.user_id = v_user;
          get diagnostics v_count = row_count;
          v_cleared := v_cleared + v_count;
        else
          v_summary := private.erase_user(v_user);
          if v_summary is not null then
            v_erased := v_erased + 1;
            v_communities := v_communities
              + coalesce(jsonb_array_length(v_summary -> 'communities_deleted'), 0);
          end if;
        end if;
      end if;
    exception
      when raise_exception then
        -- A join made the account the last organizer after the selection above.
        if sqlerrm <> 'last_organizer' then
          raise;
        end if;
        v_blocked := v_blocked + 1;
      when lock_not_available or deadlock_detected then
        v_deferred := v_deferred + 1;
    end;
  end loop;

  select count(*)::integer into v_remaining
  from private.account_activity a
  join auth.users u on u.id = a.user_id
  where u.is_anonymous
    and a.inactivity_notice_at <= v_due
    and jsonb_array_length(private.deletion_blockers(a.user_id)) = 0;

  -- 4. The run log keeps two years of counts.
  delete from private.retention_runs r where r.ran_at < now() - interval '2 years';
  insert into private.retention_runs (
    notices_created, notices_cleared, accounts_erased, communities_deleted,
    blocked_last_organizer, deferred
  ) values (v_created, v_cleared, v_erased, v_communities, v_blocked, v_deferred);

  return jsonb_build_object(
    'enabled', true,
    'notices_created', v_created,
    'notices_cleared', v_cleared,
    'accounts_erased', v_erased,
    'communities_deleted', v_communities,
    'blocked_last_organizer', v_blocked,
    'deferred', v_deferred,
    'due_remaining', v_remaining
  );
end;
$$;

-- admin_set_retention_enabled ---------------------------------------------------------------------
-- The kill switch (service_role; also runnable as postgres in the SQL editor). Errors:
-- validation_failed:enabled (null). Returns { enabled, changed, notices_cleared }. Switching off
-- clears every pending notice, so switching on again always starts a fresh 30-day window.

create function public.admin_set_retention_enabled(p_enabled boolean) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old boolean;
  v_cleared integer := 0;
begin
  if p_enabled is null then
    raise exception using errcode = 'P0001', message = 'validation_failed:enabled';
  end if;

  select s.inactive_erasure_enabled into v_old
  from private.retention_settings s
  where s.id
  for update;

  update private.retention_settings s
  set inactive_erasure_enabled = p_enabled,
      updated_at = now()
  where s.id
    and s.inactive_erasure_enabled is distinct from p_enabled;

  if not p_enabled then
    update private.account_activity a
    set inactivity_notice_at = null
    where a.inactivity_notice_at is not null;
    get diagnostics v_cleared = row_count;
  end if;

  return jsonb_build_object(
    'enabled', p_enabled,
    'changed', v_old is distinct from p_enabled,
    'notices_cleared', v_cleared
  );
end;
$$;

-- GDPR: export ------------------------------------------------------------------------------------
-- Same as P5 (20261201000100_workout_logs.sql) plus extensions.account_activity (when the app was
-- last opened as recorded by record_app_open, and a pending inactivity notice; null when there is
-- no row) and one README sentence.

create or replace function public.export_my_data() returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_limit constant integer := 5000;
  c_per_hour constant integer := 10;
  v_uid uuid := auth.uid();
  v_now timestamptz;
  v_recent integer;
  v_result jsonb;
begin
  if v_uid is null or not private.auth_user_exists(v_uid) then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('data_export:' || v_uid::text, 0));
  v_now := clock_timestamp();

  delete from private.data_export_log l
  where l.user_id = v_uid
    and l.requested_at <= v_now - interval '1 hour';
  select count(*)::integer into v_recent
  from private.data_export_log l
  where l.user_id = v_uid
    and l.requested_at > v_now - interval '1 hour';
  if v_recent >= c_per_hour then
    raise exception using errcode = 'P0001', message = 'rate_limited';
  end if;

  -- Its foreign key key-share-locks the auth user: a concurrent account deletion either waits
  -- for this export or makes it fail here (mapped to not_authenticated below).
  insert into private.data_export_log (user_id, requested_at) values (v_uid, v_now);

  with
  mem as (
    select jsonb_build_object(
             'membership_id', m.id,
             'community_id', m.community_id,
             'community_name', c.name,
             'role', m.role,
             'status', m.status,
             'joined_at', m.joined_at
           ) as j,
           row_number() over (order by m.joined_at, m.id) as n
    from public.memberships m
    join public.communities c on c.id = m.community_id
    where m.user_id = v_uid
    order by m.joined_at, m.id
    limit c_limit + 1
  ),
  rsvp as (
    select jsonb_build_object(
             'rsvp_id', r.id,
             'session_id', r.session_id,
             'community_id', r.community_id,
             'event_title', s.title,
             'event_starts_at', s.starts_at,
             'event_status', s.status,
             'response', r.response,
             'responded_at', r.responded_at,
             'updated_at', r.updated_at
           ) as j,
           row_number() over (order by s.starts_at, r.id) as n
    from public.training_rsvps r
    join public.training_sessions s on s.id = r.session_id
    where r.user_id = v_uid
    order by s.starts_at, r.id
    limit c_limit + 1
  ),
  att as (
    select jsonb_build_object(
             'record_id', a.id,
             'session_id', a.session_id,
             'community_id', a.community_id,
             'event_title', s.title,
             'event_starts_at', s.starts_at,
             'status', a.status,
             'is_walk_in', a.is_walk_in,
             'had_rsvp_going', a.had_rsvp_going,
             'recorded_at', a.recorded_at,
             'updated_at', a.updated_at
           ) as j,
           row_number() over (order by s.starts_at, a.id) as n
    from public.attendance_records a
    join public.training_sessions s on s.id = a.session_id
    where a.user_id = v_uid
    order by s.starts_at, a.id
    limit c_limit + 1
  ),
  audit as (
    select jsonb_build_object(
             'change_id', l.id,
             'session_id', l.session_id,
             'community_id', l.community_id,
             'event_title', s.title,
             'event_starts_at', s.starts_at,
             'old_status', l.old_status,
             'new_status', l.new_status,
             'action', l.action,
             'reason', l.reason,
             'changed_at', l.changed_at,
             'changed_by', case when l.changed_by = v_uid then 'you' else 'an organizer' end
           ) as j,
           row_number() over (order by l.changed_at, l.id) as n
    from public.attendance_audit_log l
    join public.training_sessions s on s.id = l.session_id
    where l.user_id = v_uid
    order by l.changed_at, l.id
    limit c_limit + 1
  ),
  inv as (
    select jsonb_build_object(
             'redemption_id', x.id,
             'community_id', ic.community_id,
             'community_name', c.name,
             'role', ic.role,
             'redeemed_at', x.redeemed_at
           ) as j,
           row_number() over (order by x.redeemed_at, x.id) as n
    from public.invitation_redemptions x
    join public.invitation_codes ic on ic.id = x.invitation_id
    join public.communities c on c.id = ic.community_id
    where x.user_id = v_uid
    order by x.redeemed_at, x.id
    limit c_limit + 1
  ),
  creator as (
    select jsonb_build_object(
             'redemption_id', x.id,
             'community_id', x.community_id,
             'community_name', c.name,
             'redeemed_at', x.redeemed_at
           ) as j,
           row_number() over (order by x.redeemed_at, x.id) as n
    from public.community_creator_redemptions x
    join public.communities c on c.id = x.community_id
    where x.user_id = v_uid
    order by x.redeemed_at, x.id
    limit c_limit + 1
  ),
  cons as (
    select jsonb_build_object(
             'event_id', r.id,
             'purpose', r.purpose,
             'granted', r.granted,
             'document_version', r.document_version,
             'at', r.created_at
           ) as j,
           row_number() over (order by r.created_at, r.id) as n
    from public.consent_records r
    where r.user_id = v_uid
    order by r.created_at, r.id
    limit c_limit + 1
  ),
  notif as (
    select jsonb_build_object(
             'notification_id', x.id,
             'community_id', x.community_id,
             'kind', x.kind,
             'title', x.title,
             'body', x.body,
             'created_at', x.created_at,
             'read_at', x.read_at,
             'push_status', dj.status,
             'push_sent_at', dj.sent_at
           ) as j,
           row_number() over (order by x.created_at, x.id) as n
    from public.notifications x
    left join public.notification_delivery_jobs dj on dj.notification_id = x.id
    where x.user_id = v_uid
    order by x.created_at, x.id
    limit c_limit + 1
  ),
  reads as (
    select jsonb_build_object(
             'announcement_id', x.announcement_id,
             'community_id', a.community_id,
             'announcement_title', a.title,
             'read_at', x.read_at
           ) as j,
           row_number() over (order by x.read_at, x.announcement_id) as n
    from public.announcement_reads x
    join public.announcements a on a.id = x.announcement_id
    where x.user_id = v_uid
    order by x.read_at, x.announcement_id
    limit c_limit + 1
  ),
  feed_reads as (
    select jsonb_build_object(
             'session_id', x.session_id,
             'community_id', s.community_id,
             'event_title', s.title,
             'last_read_at', x.last_read_at
           ) as j,
           row_number() over (order by x.last_read_at, x.session_id) as n
    from public.event_feed_reads x
    join public.training_sessions s on s.id = x.session_id
    where x.user_id = v_uid
    order by x.last_read_at, x.session_id
    limit c_limit + 1
  ),
  devices as (
    select jsonb_build_object(
             'device_id', t.id,
             'platform', t.platform,
             'device_label', t.device_label,
             'created_at', t.created_at,
             'last_seen_at', t.last_seen_at,
             'invalidated_at', t.invalidated_at
           ) as j,
           row_number() over (order by t.created_at, t.id) as n
    from public.device_push_tokens t
    where t.user_id = v_uid
    order by t.created_at, t.id
    limit c_limit + 1
  ),
  attempts as (
    select jsonb_build_object('attempted_at', x.attempted_at, 'success', x.success) as j,
           row_number() over (order by x.attempted_at, x.id) as n
    from public.invitation_attempts x
    where x.user_id = v_uid
    order by x.attempted_at, x.id
    limit c_limit + 1
  ),
  exports as (
    select jsonb_build_object('requested_at', x.requested_at) as j,
           row_number() over (order by x.requested_at, x.id) as n
    from private.data_export_log x
    where x.user_id = v_uid
    order by x.requested_at, x.id
    limit c_limit + 1
  ),
  authored_announcements as (
    select jsonb_build_object(
             'announcement_id', a.id,
             'community_id', a.community_id,
             'community_name', c.name,
             'title', a.title,
             'body', a.body,
             'status', a.status,
             'scheduled_for', a.scheduled_for,
             'published_at', a.published_at,
             'created_at', a.created_at
           ) as j,
           row_number() over (order by a.created_at, a.id) as n
    from public.announcements a
    join public.communities c on c.id = a.community_id
    where a.author_id = v_uid
    order by a.created_at, a.id
    limit c_limit + 1
  ),
  authored_posts as (
    select jsonb_build_object(
             'post_id', ep.id,
             'session_id', ep.session_id,
             'community_id', ep.community_id,
             'community_name', c.name,
             'event_title', s.title,
             'parent_id', ep.parent_id,
             'body', ep.body,
             'created_at', ep.created_at,
             'deleted_at', ep.deleted_at
           ) as j,
           row_number() over (order by ep.created_at, ep.id) as n
    from public.event_posts ep
    join public.training_sessions s on s.id = ep.session_id
    join public.communities c on c.id = ep.community_id
    where ep.author_id = v_uid
    order by ep.created_at, ep.id
    limit c_limit + 1
  ),
  organized as (
    select jsonb_build_object(
             'session_id', s.id,
             'community_id', s.community_id,
             'community_name', c.name,
             'title', s.title,
             'starts_at', s.starts_at,
             'status', s.status,
             'created_at', s.created_at
           ) as j,
           row_number() over (order by s.created_at, s.id) as n
    from public.training_sessions s
    join public.communities c on c.id = s.community_id
    where s.organizer_id = v_uid
    order by s.created_at, s.id
    limit c_limit + 1
  ),
  codes as (
    select jsonb_build_object(
             'invitation_id', ic.id,
             'community_id', ic.community_id,
             'community_name', c.name,
             'role', ic.role,
             'created_at', ic.created_at,
             'expires_at', ic.expires_at,
             'max_redemptions', ic.max_redemptions,
             'redemption_count', ic.redemption_count,
             'revoked_at', ic.revoked_at
           ) as j,
           row_number() over (order by ic.created_at, ic.id) as n
    from public.invitation_codes ic
    join public.communities c on c.id = ic.community_id
    where ic.created_by = v_uid
    order by ic.created_at, ic.id
    limit c_limit + 1
  ),
  workouts as (
    select private.workout_log_json(wl) - 'id' || jsonb_build_object('log_id', wl.id) as j,
           row_number() over (order by wl.event_starts_at, wl.id) as n
    from private.workout_logs wl
    where wl.user_id = v_uid
    order by wl.event_starts_at, wl.id
    limit c_limit + 1
  )
  select jsonb_build_object(
    'format_version', 1,
    'generated_at', v_now,
    'README',
      'This file holds the personal data TrainHive stores about your account, in JSON. '
      || 'account/profile: your account id, when it was created, your display name. '
      || 'memberships: the communities you joined, your role and status. '
      || 'rsvps and attendance: your answers to events and what organizers recorded about your '
      || 'attendance; attendance_changes lists every change to your attendance (the organizer is '
      || 'shown as "an organizer"). consents: every consent you gave or withdrew. '
      || 'notifications, announcement_reads, notification_preferences, push_devices: what the app '
      || 'sent you and how (push token values are not included). event_feed_reads: when you last '
      || 'read each event''s discussion. authored: content you created for your communities, '
      || 'including your event posts and replies (a deleted post has no text). If you delete your '
      || 'account, announcements and event posts stay in the community without your name and '
      || 'your replies are deleted. extensions.about_you: the optional About you details you saved '
      || '(birth year, gender, emergency contact, T-shirt size), null when there are none. '
      || 'extensions.workout_logs: your workout logs (exercises and sets, distance, time, pace, '
      || 'notes) with the event each one belongs to; only you can see them. '
      || 'extensions.account_activity: when the app last told the server that you opened it, '
      || 'and the start of a notice if your account was going to be deleted for 24 months of '
      || 'inactivity; null when there is none. '
      || 'technical: rate-limit records kept for about a day. Other '
      || 'members'' data is not included. Lists hold at most 5000 items; "truncated" says where '
      || 'more exist. Deleting your account (Profile > Privacy) erases this data; attendance stays '
      || 'only as anonymous counts.',
    'account', (
      select jsonb_build_object('user_id', u.id, 'created_at', u.created_at,
                                'is_anonymous', u.is_anonymous)
      from auth.users u
      where u.id = v_uid
    ),
    'profile', (
      select jsonb_build_object('display_name', p.display_name, 'created_at', p.created_at,
                                'updated_at', p.updated_at)
      from public.profiles p
      where p.id = v_uid
    ),
    'memberships', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from mem x),
    'rsvps', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from rsvp x),
    'attendance', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from att x),
    'attendance_changes', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from audit x),
    'invitation_redemptions', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from inv x),
    'creator_code_redemptions', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from creator x),
    'consents', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from cons x),
    'notification_preferences', (
      select jsonb_build_object('push_enabled', np.push_enabled,
                                'training_reminders', np.training_reminders,
                                'announcements', np.announcements,
                                'training_updates', np.training_updates,
                                'updated_at', np.updated_at)
      from public.notification_preferences np
      where np.user_id = v_uid
    ),
    'notifications', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from notif x),
    'announcement_reads', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from reads x),
    'event_feed_reads', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from feed_reads x),
    'push_devices', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from devices x),
    'authored', jsonb_build_object(
      'announcements', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from authored_announcements x),
      'event_posts', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from authored_posts x),
      'events_organized', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from organized x),
      'invitation_codes', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from codes x),
      -- Counts only: these rows are about other people.
      'events_cancelled', (select count(*) from public.training_sessions s where s.cancelled_by = v_uid),
      'events_attendance_finalized',
        (select count(*) from public.training_sessions s where s.attendance_finalized_by = v_uid),
      'attendance_records_created_for_others',
        (select count(*) from public.attendance_records a
         where a.recorded_by = v_uid and a.user_id is distinct from v_uid),
      'attendance_changes_made_for_others',
        (select count(*) from public.attendance_audit_log l
         where l.changed_by = v_uid and l.user_id is distinct from v_uid)
    ),
    'technical', jsonb_build_object(
      'invitation_attempts', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from attempts x),
      'data_export_requests', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from exports x)
    ),
    'extensions', jsonb_build_object(
      'about_you', (
        select jsonb_build_object(
                 'birth_year', a.birth_year,
                 'gender', a.gender,
                 'emergency_contact_name', a.emergency_contact_name,
                 'emergency_contact_phone', a.emergency_contact_phone,
                 'emergency_contact_relationship', a.emergency_contact_relationship,
                 'tshirt_size', a.tshirt_size,
                 'created_at', a.created_at,
                 'updated_at', a.updated_at)
        from private.member_about_you a
        where a.user_id = v_uid
      ),
      'workout_logs', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from workouts x),
      'account_activity', (
        select jsonb_build_object(
                 'last_app_open_at', aa.last_app_open_at,
                 'inactivity_notice_at', aa.inactivity_notice_at)
        from private.account_activity aa
        where aa.user_id = v_uid
      )
    ),
    'truncated', jsonb_build_object(
      'memberships', (select count(*) > c_limit from mem),
      'rsvps', (select count(*) > c_limit from rsvp),
      'attendance', (select count(*) > c_limit from att),
      'attendance_changes', (select count(*) > c_limit from audit),
      'invitation_redemptions', (select count(*) > c_limit from inv),
      'creator_code_redemptions', (select count(*) > c_limit from creator),
      'consents', (select count(*) > c_limit from cons),
      'notifications', (select count(*) > c_limit from notif),
      'announcement_reads', (select count(*) > c_limit from reads),
      'event_feed_reads', (select count(*) > c_limit from feed_reads),
      'push_devices', (select count(*) > c_limit from devices),
      'authored_announcements', (select count(*) > c_limit from authored_announcements),
      'event_posts', (select count(*) > c_limit from authored_posts),
      'events_organized', (select count(*) > c_limit from organized),
      'invitation_codes', (select count(*) > c_limit from codes),
      'invitation_attempts', (select count(*) > c_limit from attempts),
      'data_export_requests', (select count(*) > c_limit from exports),
      'workout_logs', (select count(*) > c_limit from workouts)
    )
  ) into v_result;

  return v_result;
exception
  when foreign_key_violation then
    -- The account was deleted while this call ran.
    if private.auth_user_exists(v_uid) then
      raise;
    end if;
    raise exception using errcode = 'P0001', message = 'not_authenticated';
end;
$$;

-- Schedule ----------------------------------------------------------------------------------------
-- Same guarded pattern as 20261201000100_workout_logs.sql: no-op without pg_cron (the embedded test
-- database), idempotent (unscheduled first), a warning naming the manual step when pg_cron is
-- listed but unusable. The job itself does nothing while the kill switch is off (the default).

do $$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron with schema pg_catalog;
      perform cron.unschedule(c.jobid) from cron.job c where c.jobname = 'trainhive_account_retention';
      perform cron.schedule('trainhive_account_retention', '41 3 * * *',
                            'select public.run_account_retention()');
    exception
      when others then
        raise warning
          'TrainHive: could not schedule the account retention job with pg_cron (%: %). '
          'Inactive accounts will NOT be handled until this is done manually: enable the pg_cron '
          'extension for the project, then run '
          'select cron.schedule(''trainhive_account_retention'', ''41 3 * * *'', '
          '''select public.run_account_retention()'');',
          sqlstate, sqlerrm;
    end;
  end if;
end
$$;

-- Grants -------------------------------------------------------------------------------------------

revoke all on function private.retention_inactive_after() from public, anon, authenticated, service_role;
revoke all on function private.retention_notice_period() from public, anon, authenticated, service_role;
revoke all on function private.account_last_activity(uuid) from public, anon, authenticated, service_role;
revoke all on function private.inactive_accounts(timestamptz) from public, anon, authenticated, service_role;

revoke all on function public.record_app_open() from public, anon, authenticated, service_role;
revoke all on function public.retention_preview() from public, anon, authenticated, service_role;
revoke all on function public.run_account_retention() from public, anon, authenticated, service_role;
revoke all on function public.admin_set_retention_enabled(boolean) from public, anon, authenticated, service_role;
revoke all on function public.export_my_data() from public, anon, authenticated, service_role;

grant execute on function public.record_app_open() to authenticated;
grant execute on function public.retention_preview() to service_role;
grant execute on function public.run_account_retention() to service_role;
grant execute on function public.admin_set_retention_enabled(boolean) to service_role;
grant execute on function public.export_my_data() to authenticated;
