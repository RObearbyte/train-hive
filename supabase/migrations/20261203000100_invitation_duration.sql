-- TrainHive: server-side invitation expiry (open item O1) and the account-deletion fallback.
-- Contract: docs/API_CONTRACT.md ("Invitation expiry on the server" and "Account deletion fallback").
--
-- 1. create_invitation gains p_expires_in_hours (integer). The server computes
--    expires_at = clock_timestamp() + p_expires_in_hours hours, so the device clock no longer
--    decides when a code expires.
--      * One function name, no overload: the old (uuid, timestamptz, integer) signature is dropped
--        and replaced by (uuid, timestamptz, integer, integer) with the new parameter LAST and
--        defaulted. Old APKs keep calling it by name with {p_community_id, p_expires_at,
--        p_max_redemptions}; PostgREST fills the default. SQL callers with 1-3 positional
--        arguments are unchanged.
--      * p_expires_in_hours: 0 = never expires; 1..2160 (90 days) = that many hours from the
--        server clock; anything else (negative, > 2160) -> validation_failed:expires_in_hours.
--        Sending it together with a non-null p_expires_at -> validation_failed:expires_in_hours.
--      * p_expires_at (legacy, old APKs): still accepted, now validated against the server clock:
--        must be after clock_timestamp() and at most 90 days after it, else
--        validation_failed:expires_at.
--      * Both null (or omitted): never expires. This is today's behaviour and the only way an old
--        APK can ask for "Never", so the SQL default stays "no expiry"; the app's presets (Quick
--        invite 30 days, form 7 days by default) are chosen in the app.
--    Organizer invitations from admin_create_community, creator codes (admin_create_creator_code)
--    and create_community_with_code (creates no invitation code) already compute their expiry on
--    the server: unchanged.
--
-- 2. Account deletion fallback (for the Edge Function supabase/functions/delete-account, to be
--    deployed ONLY if `delete from auth.users` inside delete_my_account is refused on hosted).
--      * private.erase_user gains p_delete_auth_user boolean default true. Same body; with false
--        it stops before its last statement (the auth.users delete). The one-argument call used by
--        delete_my_account and the retention job resolves to the default (true): unchanged.
--        NOTE for later migrations: replace private.erase_user(uuid, boolean), never
--        create private.erase_user(uuid) again (that would be an ambiguous overload).
--      * public.admin_erase_user_data(p_user_id uuid) -> jsonb, service_role only: erases every
--        row of the user exactly like delete_my_account (same locks, same last_organizer refusal),
--        but keeps the auth.users row (and, through it, the consent ledger) for the Edge Function
--        to delete with auth.admin.deleteUser, whose cascade removes the ledger. Errors (P0001):
--        validation_failed:user_id (null), not_found (no such auth user), last_organizer (DETAIL
--        as delete_my_account). Repeatable: a second call for a user whose data is already gone
--        returns a summary of zeros, so a failed deleteUser can simply be retried.

-- 1. create_invitation -------------------------------------------------------------------------

drop function public.create_invitation(uuid, timestamptz, integer);

create function public.create_invitation(
  p_community_id uuid,
  p_expires_at timestamptz default null,
  p_max_redemptions integer default null,
  p_expires_in_hours integer default null
) returns public.invitation_codes
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_max_hours constant integer := 90 * 24;
  v_uid uuid := auth.uid();
  -- The real time of this call (not the transaction start): expiry is measured from it.
  v_now timestamptz := clock_timestamp();
  v_expires_at timestamptz;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  -- Also the answer for a community that does not exist, so ids cannot be probed.
  if p_community_id is null or not public.is_organizer(p_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;

  if p_expires_in_hours is not null then
    -- Current apps: a duration, measured on the server clock.
    if p_expires_at is not null
       or p_expires_in_hours < 0
       or p_expires_in_hours > c_max_hours then
      raise exception using errcode = 'P0001', message = 'validation_failed:expires_in_hours';
    end if;
    if p_expires_in_hours > 0 then
      v_expires_at := v_now + make_interval(hours => p_expires_in_hours);
    end if;
  elsif p_expires_at is not null then
    -- Old apps: an absolute time from the device clock, checked against the server clock.
    if p_expires_at <= v_now or p_expires_at > v_now + make_interval(hours => c_max_hours) then
      raise exception using errcode = 'P0001', message = 'validation_failed:expires_at';
    end if;
    v_expires_at := p_expires_at;
  end if;

  if p_max_redemptions is not null and p_max_redemptions < 1 then
    raise exception using errcode = 'P0001', message = 'validation_failed:max_redemptions';
  end if;

  -- The role is fixed: organizers cannot mint organizer invitations.
  return private.insert_invitation(p_community_id, 'member', v_uid, v_expires_at, p_max_redemptions);
end;
$$;

-- 2. private.erase_user (uuid, boolean) ------------------------------------------------------------
-- Body identical to 20261201000100_workout_logs.sql except the last statement, now conditional.

drop function private.erase_user(uuid);

create function private.erase_user(p_user_id uuid, p_delete_auth_user boolean default true)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_blockers jsonb;
  v_sole uuid[];
  v_memberships integer := 0;
  v_count integer;
  v_rsvps integer;
  v_records integer;
  v_changes integer;
  v_notifications integer;
begin
  if p_user_id is null or not private.lock_user_for_erasure(p_user_id) then
    return null;
  end if;

  v_blockers := private.deletion_blockers(p_user_id);
  if jsonb_array_length(v_blockers) > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'last_organizer',
      detail = jsonb_build_object('communities', v_blockers)::text;
  end if;

  -- 1. Communities where the user is the last active member go entirely (cascade).
  v_sole := private.sole_member_communities(p_user_id);
  select count(*)::integer into v_memberships
  from public.memberships m
  where m.user_id = p_user_id
    and m.community_id = any (v_sole);
  delete from public.communities c where c.id = any (v_sole);

  -- 2. Memberships (an active one releases its going RSVPs on open sessions, as a removal does).
  delete from public.memberships m where m.user_id = p_user_id;
  get diagnostics v_count = row_count;
  v_memberships := v_memberships + v_count;

  -- 3. RSVPs: a deleted going row is uncounted from its session (trigger).
  delete from public.training_rsvps r where r.user_id = p_user_id;
  get diagnostics v_rsvps = row_count;

  -- 4. Attendance about the user becomes anonymous; attendance the user wrote loses its author.
  -- Q7-6: audit rows about the user, and audit rows the user wrote, also lose their free-text
  -- reason (an organizer's note can name the person).
  update public.attendance_records a set user_id = null where a.user_id = p_user_id;
  get diagnostics v_records = row_count;
  update public.attendance_records a set recorded_by = null where a.recorded_by = p_user_id;
  update public.attendance_audit_log l set user_id = null, reason = null where l.user_id = p_user_id;
  get diagnostics v_changes = row_count;
  update public.attendance_audit_log l set changed_by = null, reason = null where l.changed_by = p_user_id;

  -- 5. Community content the user authored stays, without an author.
  update public.training_sessions s set organizer_id = null where s.organizer_id = p_user_id;
  update public.training_sessions s set cancelled_by = null where s.cancelled_by = p_user_id;
  update public.training_sessions s
  set attendance_finalized_by = null
  where s.attendance_finalized_by = p_user_id;
  update public.announcements a set author_id = null where a.author_id = p_user_id;
  update public.invitation_codes ic set created_by = null where ic.created_by = p_user_id;
  update public.community_creator_codes cc set created_by = null where cc.created_by = p_user_id;

  -- P4: replies are deleted, with the notifications that quote them (sent to the parent's
  -- author); top-level posts stay without author.
  delete from public.notifications n
  where n.kind = 'event_reply'
    and n.dedupe_key in (
      select 'event_reply:' || ep.id
      from public.event_posts ep
      where ep.author_id = p_user_id
        and ep.parent_id is not null
    );
  delete from public.event_posts ep where ep.author_id = p_user_id and ep.parent_id is not null;
  update public.event_posts ep set author_id = null where ep.author_id = p_user_id;

  -- 6. Personal rows.
  delete from public.notifications n where n.user_id = p_user_id;
  get diagnostics v_notifications = row_count;
  delete from public.notification_delivery_jobs j where j.user_id = p_user_id;
  delete from public.device_push_tokens t where t.user_id = p_user_id;
  delete from public.notification_preferences np where np.user_id = p_user_id;
  delete from public.announcement_reads ar where ar.user_id = p_user_id;
  delete from public.event_feed_reads fr where fr.user_id = p_user_id;
  delete from public.invitation_redemptions ir where ir.user_id = p_user_id;
  delete from public.community_creator_redemptions cr where cr.user_id = p_user_id;
  delete from public.invitation_attempts ia where ia.user_id = p_user_id;
  delete from private.data_export_log el where el.user_id = p_user_id;
  -- P3: About you (the foreign key to profiles would cascade too; explicit here).
  delete from private.member_about_you ay where ay.user_id = p_user_id;
  -- P5: workout logs (the foreign key to profiles would cascade too; explicit here).
  delete from private.workout_logs wl where wl.user_id = p_user_id;

  -- 7. The profile (its deferred trigger removes, at commit, any notification a concurrent
  -- fan-out added meanwhile), then the auth user last: its cascade removes the consent ledger,
  -- the only way the ledger's append-only guard lets rows go. With p_delete_auth_user = false
  -- (admin_erase_user_data, the Edge Function fallback) the auth user and the ledger stay until
  -- the caller deletes the auth user through the Auth admin API.
  delete from public.profiles p where p.id = p_user_id;
  if p_delete_auth_user then
    delete from auth.users u where u.id = p_user_id;
  end if;

  return jsonb_build_object(
    'user_id', p_user_id,
    'communities_deleted', to_jsonb(v_sole),
    'memberships_deleted', v_memberships,
    'rsvps_deleted', v_rsvps,
    'attendance_records_anonymized', v_records,
    'attendance_changes_anonymized', v_changes,
    'notifications_deleted', v_notifications
  );
end;
$$;

-- 3. admin_erase_user_data (service_role only) ------------------------------------------------------

create function public.admin_erase_user_data(p_user_id uuid) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_user_id is null then
    raise exception using errcode = 'P0001', message = 'validation_failed:user_id';
  end if;

  v_result := private.erase_user(p_user_id, false);
  if v_result is null then
    -- No such auth user (never existed, or already deleted).
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  return v_result;
end;
$$;

-- Grants -------------------------------------------------------------------------------------------

revoke all on function private.erase_user(uuid, boolean) from public, anon, authenticated, service_role;

revoke all on function public.create_invitation(uuid, timestamptz, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_erase_user_data(uuid) from public, anon, authenticated, service_role;

grant execute on function public.create_invitation(uuid, timestamptz, integer, integer) to authenticated;
grant execute on function public.admin_erase_user_data(uuid) to service_role;
