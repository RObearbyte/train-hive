-- TrainHive C3: fixes for the community QA review (docs/QA_REPORT.md, "Community creation,
-- switching and invitation message (C1/C2) (C-Q1)").
-- Contract: docs/API_CONTRACT.md ("C3 amendments").
--
--   Q6-2  private.clean_required_text: the "invisible" set used by the blank check is now the
--         Unicode White_Space + Default_Ignorable_Code_Point properties plus the remaining
--         format (Cf) characters and the Braille blank, listed range by range below.
--   Q6-1  private.clean_display_name uses clean_required_text (controls and bidi
--         embeddings/overrides/isolates stripped, whitespace collapsed, invisible-only names
--         rejected) and keeps the 2-40 code point rule. Covers redeem_invitation,
--         create_community_with_code and update_display_name. Existing profiles are cleaned once.
--   Q6-3  preview_invitation, redeem_invitation, preview_creator_code and
--         create_community_with_code answer {ok:false, error:'not_authenticated'} for a JWT whose
--         user no longer exists in auth.users (checked first; a deletion that races the call is
--         caught at the foreign key and mapped the same way). No raw 23503 reaches the client.
--   D5    invitation_attempts rows older than 24 hours are deleted by the existing daily
--         purge_old_notification_data() job (pg_cron trainhive_purge_notification_data).
--   O6    communities.updated_at, maintained by update_community, which takes an optional
--         p_expected_updated_at for optimistic concurrency (stale_data on mismatch).
--
-- Functions are replaced in place where the signature is unchanged; update_community gains a
-- parameter, so it is dropped and created again. Grants are revoked and granted again
-- explicitly at the end; the privilege matrix is unchanged.

-- Q6-2: text cleaning ---------------------------------------------------------------------------
-- Same behaviour as M3-B3 (20261116000100_m3_qa_fixes.sql) except the set of characters that
-- count as invisible in the blank check. Characters are written as escapes so the list can be
-- audited. The set (Unicode 15.1 / 16.0):
--   White_Space (beyond \s):  U+00A0, U+1680, U+2000-200A, U+2028, U+2029, U+202F, U+205F,
--                             U+3000 (U+0085 is a C1 control, stripped before the check)
--   Default_Ignorable_Code_Point (DerivedCoreProperties.txt, complete):
--                             U+00AD, U+034F, U+061C, U+115F-1160, U+17B4-17B5, U+180B-180F,
--                             U+200B-200F, U+202A-202E, U+2060-206F, U+3164, U+FE00-FE0F,
--                             U+FEFF, U+FFA0, U+FFF0-FFF8, U+1BCA0-1BCA3, U+1D173-1D17A,
--                             U+E0000-E0FFF (tags, variation selectors supplement, reserved)
--   Other format (Cf) characters:
--                             U+0600-0605, U+06DD, U+070F, U+0890-0891, U+08E2, U+FFF9-FFFB,
--                             U+110BD, U+110CD, U+13430-1343F
--   Visually blank symbol:    U+2800 (Braille pattern blank)
-- The check only decides whether ANY visible character remains; the stored text keeps
-- invisible characters next to visible ones (ZWJ in emoji sequences, ZWNJ in Persian words,
-- variation selector 16 after an emoji, tag sequences of subdivision flags).
create or replace function private.clean_required_text(
  p_text text,
  p_field text,
  p_max_length integer,
  p_multiline boolean
) returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text text;
begin
  -- Stripped: C0/C1 controls except tab, LF, CR (handled as whitespace below), and the bidi
  -- embedding/override (U+202A-202E) and isolate (U+2066-2069) controls.
  v_text := regexp_replace(
    coalesce(p_text, ''),
    '[\x01-\x08\x0E-\x1F\x7F-\x9F‪-‮⁦-⁩]', '', 'g');
  if p_multiline then
    v_text := regexp_replace(v_text, '\r\n?|[  ]', E'\n', 'g');
    v_text := regexp_replace(v_text, '[\x0B\x0C]', '', 'g');
    v_text := btrim(v_text, E' \t\n');
  else
    v_text := btrim(regexp_replace(
      v_text, '[\s   -     　]+', ' ', 'g'));
  end if;
  if regexp_replace(
       v_text,
       '[\s'
       -- White_Space
       '   -     　'
       -- Default_Ignorable_Code_Point
       '­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮'
       '⁠-⁯ㅤ︀-️﻿ﾠ￰-￸'
       '\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0000-\U000E0FFF'
       -- other format characters
       '؀-؅۝܏࢐࢑࣢￹-￻'
       '\U000110BD\U000110CD\U00013430-\U0001343F'
       -- Braille pattern blank
       '⠀'
       ']',
       '', 'g') = ''
     or char_length(v_text) > p_max_length then
    raise exception using errcode = 'P0001', message = 'validation_failed:' || p_field;
  end if;
  return v_text;
end;
$$;

-- Q6-1: display names ---------------------------------------------------------------------------
-- Returns the cleaned display name, or null when it is not acceptable: the single-line rules of
-- clean_required_text (controls and bidi embeddings/overrides/isolates stripped, whitespace runs
-- collapsed to one space, trimmed, not only invisible characters), then 2-40 code points.
-- Display names are global (decision D1): one name per person, shown in every community.
create or replace function private.clean_display_name(p_display_name text) returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_name text;
begin
  begin
    v_name := private.clean_required_text(p_display_name, 'display_name', 40, false);
  exception
    when sqlstate 'P0001' then
      return null;
  end;
  if char_length(v_name) < 2 then
    return null;
  end if;
  return v_name;
end;
$$;

-- One-off: existing display names get the same cleaning. A name that is not acceptable any more
-- (invisible only, or one visible character once controls are stripped) becomes 'Member'; the
-- user can rename themselves in Profile.
update public.profiles p
set display_name = coalesce(private.clean_display_name(p.display_name), 'Member'),
    updated_at = now()
where p.display_name is distinct from coalesce(private.clean_display_name(p.display_name), 'Member');

-- Q6-3: caller must exist -----------------------------------------------------------------------
-- A JWT stays valid for up to an hour after its user was deleted. Functions that write rows
-- referencing auth.users with the caller's id check this first.
create or replace function private.auth_user_exists(p_user_id uuid) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from auth.users u where u.id = p_user_id);
$$;

-- preview_invitation: as M1-B1, plus the caller check and the foreign key mapping.
create or replace function public.preview_invitation(p_code text) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_invitation public.invitation_codes;
  v_result text;
  v_community_name text;
begin
  if v_uid is null or not private.auth_user_exists(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  perform private.lock_invitation_attempts(v_uid);

  if private.invitation_rate_limited(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  select ic.* into v_invitation
  from public.invitation_codes ic
  where ic.code = private.normalize_invitation_code(p_code);

  v_result := private.check_invitation(v_invitation, v_uid);

  if v_result is not null and v_result <> 'already_member' then
    perform private.record_invitation_attempt(v_uid, false);
    return jsonb_build_object('ok', false, 'error', v_result);
  end if;

  select c.name into v_community_name
  from public.communities c
  where c.id = v_invitation.community_id;

  perform private.record_invitation_attempt(v_uid, true);

  return jsonb_build_object(
    'ok', true,
    'community_name', v_community_name,
    'role', v_invitation.role
  );
exception
  when foreign_key_violation then
    -- The user was deleted while this call ran (after the check above).
    if private.auth_user_exists(v_uid) then
      raise;
    end if;
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
end;
$$;

-- redeem_invitation: as M1-B1, plus the caller check and the foreign key mapping.
create or replace function public.redeem_invitation(p_code text, p_display_name text) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_invitation public.invitation_codes;
  v_result text;
  v_membership public.memberships;
begin
  if v_uid is null or not private.auth_user_exists(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  perform private.lock_invitation_attempts(v_uid);

  if private.invitation_rate_limited(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  -- Checked before the code is looked up: a bad name is not a code guess, so it is not
  -- counted as a failed attempt and reveals nothing about the code.
  v_name := private.clean_display_name(p_display_name);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_display_name');
  end if;

  -- Row lock: concurrent redemptions of the same code queue here, and each one re-reads the
  -- committed redemption_count / revoked_at / expires_at after the previous one finishes.
  select ic.* into v_invitation
  from public.invitation_codes ic
  where ic.code = private.normalize_invitation_code(p_code)
  for update;

  v_result := private.check_invitation(v_invitation, v_uid);

  if v_result is not null and v_result <> 'already_member' then
    perform private.record_invitation_attempt(v_uid, false);
    return jsonb_build_object('ok', false, 'error', v_result);
  end if;

  insert into public.profiles (id, display_name)
  values (v_uid, v_name)
  on conflict (id) do update
    set display_name = excluded.display_name,
        updated_at = now();

  if v_result = 'already_member' then
    -- Keeps the existing role: an invitation never changes the role of an existing member.
    select m.* into v_membership
    from public.memberships m
    where m.community_id = v_invitation.community_id
      and m.user_id = v_uid;
  else
    insert into public.memberships (community_id, user_id, role)
    values (v_invitation.community_id, v_uid, v_invitation.role)
    returning * into v_membership;

    insert into public.invitation_redemptions (invitation_id, user_id)
    values (v_invitation.id, v_uid);

    update public.invitation_codes
    set redemption_count = redemption_count + 1
    where id = v_invitation.id;
  end if;

  perform private.record_invitation_attempt(v_uid, true);

  return jsonb_build_object(
    'ok', true,
    'community_id', v_membership.community_id,
    'membership_id', v_membership.id,
    'role', v_membership.role,
    'already_member', v_result is not distinct from 'already_member'
  );
exception
  when foreign_key_violation then
    -- The user was deleted while this call ran; everything this call wrote is rolled back.
    if private.auth_user_exists(v_uid) then
      raise;
    end if;
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
end;
$$;

-- preview_creator_code: as C1, plus the caller check and the foreign key mapping.
create or replace function public.preview_creator_code(p_code text) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.community_creator_codes;
  v_result text;
begin
  if v_uid is null or not private.auth_user_exists(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  -- The same per-user lock and limiter as the invitation functions.
  perform private.lock_invitation_attempts(v_uid);
  if private.invitation_rate_limited(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  select cc.* into v_row
  from public.community_creator_codes cc
  where cc.code = private.normalize_invitation_code(p_code);

  v_result := private.check_creator_code(v_row);
  if v_result is not null then
    perform private.record_invitation_attempt(v_uid, false);
    return jsonb_build_object('ok', false, 'error', v_result);
  end if;

  perform private.record_invitation_attempt(v_uid, true);
  return jsonb_build_object('ok', true);
exception
  when foreign_key_violation then
    if private.auth_user_exists(v_uid) then
      raise;
    end if;
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
end;
$$;

-- create_community_with_code: as C1, plus the caller check and the foreign key mapping.
-- Order of checks: not_authenticated (no user id, or no such user), request id, (per-user lock)
-- idempotent replay, rate_limited, input (name, timezone, display name), community_limit_reached,
-- then the code under its row lock (failures counted).
create or replace function public.create_community_with_code(
  p_code text,
  p_name text,
  p_timezone text,
  p_display_name text,
  p_request_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_max_communities constant integer := 5;
  v_uid uuid := auth.uid();
  v_name text;
  v_display_name text;
  v_code public.community_creator_codes;
  v_previous public.community_creator_redemptions;
  v_result text;
  v_owned integer;
  v_community_id uuid;
  v_membership_id uuid;
begin
  if v_uid is null or not private.auth_user_exists(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if p_request_id is null then
    return jsonb_build_object('ok', false, 'error', 'validation_failed:request_id');
  end if;

  -- Serializes every code attempt of this user (invitations included): the replay lookup, the
  -- rate limit and the community count below are exact under concurrency.
  perform private.lock_invitation_attempts(v_uid);

  select r.* into v_previous
  from public.community_creator_redemptions r
  where r.user_id = v_uid
    and r.request_id = p_request_id;
  if found then
    return jsonb_build_object(
      'ok', true,
      'community_id', v_previous.community_id,
      'membership_id', v_previous.membership_id,
      'already_created', true
    );
  end if;

  if private.invitation_rate_limited(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  begin
    v_name := private.clean_required_text(p_name, 'name', 80, false);
  exception
    when sqlstate 'P0001' then
      return jsonb_build_object('ok', false, 'error', 'validation_failed:name');
  end;
  if not private.is_valid_timezone(p_timezone) then
    return jsonb_build_object('ok', false, 'error', 'validation_failed:timezone');
  end if;
  v_display_name := private.clean_display_name(p_display_name);
  if v_display_name is null then
    return jsonb_build_object('ok', false, 'error', 'validation_failed:display_name');
  end if;

  select count(*)::integer into v_owned
  from public.community_creator_redemptions r
  where r.user_id = v_uid;
  if v_owned >= c_max_communities then
    return jsonb_build_object('ok', false, 'error', 'community_limit_reached');
  end if;

  -- Row lock: concurrent uses of one code queue here and each re-reads the committed
  -- use_count / revoked_at after the previous one finishes.
  select cc.* into v_code
  from public.community_creator_codes cc
  where cc.code = private.normalize_invitation_code(p_code) for update;

  v_result := private.check_creator_code(v_code);
  if v_result is not null then
    perform private.record_invitation_attempt(v_uid, false);
    return jsonb_build_object('ok', false, 'error', v_result);
  end if;

  insert into public.communities (name, timezone)
  values (v_name, p_timezone)
  returning id into v_community_id;

  insert into public.profiles (id, display_name)
  values (v_uid, v_display_name)
  on conflict (id) do update
    set display_name = excluded.display_name,
        updated_at = now();

  insert into public.memberships (community_id, user_id, role)
  values (v_community_id, v_uid, 'organizer')
  returning id into v_membership_id;

  insert into public.community_creator_redemptions
    (code_id, user_id, community_id, membership_id, request_id)
  values
    (v_code.id, v_uid, v_community_id, v_membership_id, p_request_id);

  update public.community_creator_codes cc
  set use_count = cc.use_count + 1
  where cc.id = v_code.id;

  perform private.record_invitation_attempt(v_uid, true);

  return jsonb_build_object(
    'ok', true,
    'community_id', v_community_id,
    'membership_id', v_membership_id,
    'already_created', false
  );
exception
  when foreign_key_violation then
    -- The user was deleted while this call ran: the community, membership, redemption and the
    -- use are rolled back with the rest of this call.
    if private.auth_user_exists(v_uid) then
      raise;
    end if;
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
end;
$$;

-- O6: optimistic concurrency for update_community -----------------------------------------------
-- updated_at has millisecond precision (a JavaScript Date round-trips it exactly) and strictly
-- increases on every change made by update_community, so two changes in the same millisecond
-- still differ.
alter table public.communities
  add column updated_at timestamptz not null default date_trunc('milliseconds', now());
update public.communities c set updated_at = date_trunc('milliseconds', c.created_at);

drop function public.update_community(uuid, text, text);

-- Organizer of the community only. Renames it and / or changes its time zone. Existing
-- sessions are untouched (each stores its own time zone); new trainings default to the new
-- zone, and statistics week / month buckets are computed in the community's CURRENT zone, so a
-- change re-buckets history. Setting the same values again returns the row unchanged.
-- p_expected_updated_at: the updated_at the caller's form was loaded with. When given and the
-- row has changed since (another organizer saved), raises stale_data and changes nothing. Null
-- keeps the C1 behaviour (last write wins).
create function public.update_community(
  p_community_id uuid,
  p_name text,
  p_timezone text,
  p_expected_updated_at timestamptz default null
)
returns public.communities
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_current public.communities;
  v_row public.communities;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  -- Also the answer for a community that does not exist, so ids cannot be probed.
  if p_community_id is null or not public.is_organizer(p_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;

  v_name := private.clean_required_text(p_name, 'name', 80, false);
  select c.* into v_current from public.communities c where c.id = p_community_id;
  -- The stored zone was validated when it was set; pg_timezone_names is slow, so it is only
  -- consulted for a new zone.
  if p_timezone is distinct from v_current.timezone and not private.is_valid_timezone(p_timezone) then
    raise exception using errcode = 'P0001', message = 'validation_failed:timezone';
  end if;

  -- Lock order community -> caller's membership. NO KEY UPDATE does not block membership
  -- inserts (they only key-share the community). The membership share lock makes a concurrent
  -- removal or demotion wait; re-checked here, after the lock waits.
  select c.* into v_current
  from public.communities c
  where c.id = p_community_id
  for no key update;
  if not found then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  perform 1
  from public.memberships m
  where m.community_id = p_community_id
    and m.user_id = v_uid
    and m.status = 'active'
    and m.role = 'organizer'
  for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;

  -- Compared after the row lock: a concurrent save has committed and is seen here.
  if p_expected_updated_at is not null and p_expected_updated_at <> v_current.updated_at then
    raise exception using errcode = 'P0001', message = 'stale_data';
  end if;

  if v_current.name = v_name and v_current.timezone = p_timezone then
    return v_current;
  end if;

  update public.communities c
  set name = v_name,
      timezone = p_timezone,
      updated_at = greatest(
        date_trunc('milliseconds', clock_timestamp()),
        c.updated_at + interval '1 millisecond'
      )
  where c.id = p_community_id
  returning * into v_row;
  return v_row;
end;
$$;

-- D5: retention of invitation_attempts -----------------------------------------------------------
-- Deletes attempt rows older than 24 hours. The limiter only counts the last 15 minutes, so it
-- is unaffected. Rows locked by a running invitation call (its own opportunistic pruning in
-- record_invitation_attempt) are skipped instead of waited for, so the purge never deadlocks
-- with it; they go on the next run. Idempotent. Returns the number of rows deleted.
create or replace function private.purge_old_invitation_attempts() returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.invitation_attempts a
  where a.id in (
    select x.id
    from public.invitation_attempts x
    where x.attempted_at < now() - interval '24 hours'
    for update skip locked
  );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Same as M3-B3, plus private.purge_old_invitation_attempts() (run by the existing daily job
-- trainhive_purge_notification_data, 03:17). The return value is unchanged: the number of jobs
-- and notifications deleted (cascaded jobs and invitation attempts not counted).
create or replace function public.purge_old_notification_data() returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_jobs integer;
  v_stale integer;
  v_orphans integer;
  v_old integer;
begin
  delete from public.notification_delivery_jobs j
  where j.status in ('sent', 'skipped', 'dead')
    and j.created_at < now() - interval '30 days';
  get diagnostics v_jobs = row_count;

  delete from public.notification_delivery_jobs j
  where j.status in ('pending', 'failed')
    and j.expires_at < now() - interval '3 days';
  get diagnostics v_stale = row_count;

  delete from public.notifications n
  where not exists (select 1 from public.profiles p where p.id = n.user_id);
  get diagnostics v_orphans = row_count;

  delete from public.notifications n
  where (n.read_at is not null and n.created_at < now() - interval '90 days')
     or (n.read_at is null and n.created_at < now() - interval '180 days');
  get diagnostics v_old = row_count;

  perform private.purge_old_invitation_attempts();

  return v_jobs + v_stale + v_orphans + v_old;
end;
$$;

-- Grants (unchanged matrix, restated) -------------------------------------------------------------

revoke all on function private.clean_required_text(text, text, integer, boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.clean_display_name(text)
  from public, anon, authenticated, service_role;
revoke all on function private.auth_user_exists(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.purge_old_invitation_attempts()
  from public, anon, authenticated, service_role;
revoke all on function public.preview_invitation(text)
  from public, anon, authenticated, service_role;
revoke all on function public.redeem_invitation(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.preview_creator_code(text)
  from public, anon, authenticated, service_role;
revoke all on function public.create_community_with_code(text, text, text, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.update_community(uuid, text, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.purge_old_notification_data()
  from public, anon, authenticated, service_role;

grant execute on function public.preview_invitation(text) to authenticated;
grant execute on function public.redeem_invitation(text, text) to authenticated;
grant execute on function public.preview_creator_code(text) to authenticated;
grant execute on function public.create_community_with_code(text, text, text, text, uuid) to authenticated;
grant execute on function public.update_community(uuid, text, text, timestamptz) to authenticated;
grant execute on function public.purge_old_notification_data() to service_role;
