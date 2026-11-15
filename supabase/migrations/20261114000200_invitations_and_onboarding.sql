-- TrainHive M1-B1: invitation, onboarding and bootstrap RPCs.
-- Contract: docs/API_CONTRACT.md ("Invitations and onboarding").
--
-- * Every public function is security definer with an empty search_path, and has its
--   default grants (PUBLIC, plus Supabase's default grants to the API roles) revoked before
--   the single intended role is granted execute.
-- * preview_invitation / redeem_invitation RETURN {ok:false,error} instead of raising, so
--   the rate-limit attempt row written in the same transaction is committed.
-- * The only way to obtain the organizer role is to redeem an organizer invitation, and the
--   only function that creates one is admin_create_community (service_role only).

-- Internal helpers (schema private: not reachable by API roles) ------------------------------

-- Upper-cases and strips whitespace and dashes (ASCII hyphen and Unicode U+2010..U+2015).
create function private.normalize_invitation_code(p_code text) returns text
language sql
immutable
set search_path = ''
as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[\s‐-―-]', '', 'g'));
$$;

-- A time zone the clients can display: listed by this Postgres build AND either `UTC` or a
-- strict IANA `Area/Location` identifier. pg_timezone_names alone also lists names such as
-- `Factory`, `posixrules`, `localtime`, abbreviations (`EST`) and the `posix/` and `right/`
-- trees, which Intl / date-fns on a device may not accept.
create function private.is_valid_timezone(p_timezone text) returns boolean
language sql
stable
set search_path = ''
as $$
  select p_timezone is not null
    and (
      p_timezone = 'UTC'
      or (
        p_timezone ~ '^[A-Z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)+$'
        and p_timezone !~ '^(posix|right)/'
      )
    )
    and exists (select 1 from pg_catalog.pg_timezone_names tz where tz.name = p_timezone);
$$;

-- Returns the cleaned display name (whitespace runs collapsed, trimmed), or null when the
-- result is not 2-40 characters long.
create function private.clean_display_name(p_display_name text) returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_name text := btrim(regexp_replace(coalesce(p_display_name, ''), '\s+', ' ', 'g'));
begin
  if char_length(v_name) between 2 and 40 then
    return v_name;
  end if;
  return null;
end;
$$;

-- 8 characters from a 30-character alphabet, using rejection sampling (bytes >= 240 are
-- discarded) so every character is uniformly distributed.
create function private.generate_invitation_code() returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  c_alphabet constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_bytes bytea;
  v_byte integer;
  v_code text := '';
begin
  loop
    v_bytes := extensions.gen_random_bytes(16);
    for i in 0..15 loop
      v_byte := get_byte(v_bytes, i);
      if v_byte < 240 then
        v_code := v_code || substr(c_alphabet, (v_byte % 30) + 1, 1);
        if char_length(v_code) = 8 then
          return v_code;
        end if;
      end if;
    end loop;
  end loop;
end;
$$;

create function private.insert_invitation(
  p_community_id uuid,
  p_role public.membership_role,
  p_created_by uuid,
  p_expires_at timestamptz,
  p_max_redemptions integer
) returns public.invitation_codes
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_row public.invitation_codes;
begin
  for i in 1..5 loop
    begin
      insert into public.invitation_codes
        (community_id, code, role, created_by, expires_at, max_redemptions)
      values
        (p_community_id, private.generate_invitation_code(), p_role, p_created_by,
         p_expires_at, p_max_redemptions)
      returning * into v_row;
      return v_row;
    exception
      when unique_violation then
        -- The generated code collided with an existing one: try again with a new code.
        null;
    end;
  end loop;
  raise exception 'could not generate a unique invitation code';
end;
$$;

-- Serializes invitation attempts of one user for the rest of the transaction, so parallel
-- requests cannot slip past the rate limit or double-redeem.
create function private.lock_invitation_attempts(p_user_id uuid) returns void
language sql
volatile
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('invitation_attempts:' || p_user_id::text, 0));
$$;

-- True when the user has 5 or more failed attempts in the last 15 minutes.
create function private.invitation_rate_limited(p_user_id uuid) returns boolean
language sql
stable
set search_path = ''
as $$
  select count(*) >= 5
  from public.invitation_attempts a
  where a.user_id = p_user_id
    and not a.success
    and a.attempted_at > now() - interval '15 minutes';
$$;

create function private.record_invitation_attempt(p_user_id uuid, p_success boolean) returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  -- Opportunistic pruning: rows this old can no longer affect the rate limit.
  delete from public.invitation_attempts a
  where a.user_id = p_user_id
    and a.attempted_at < now() - interval '1 day';

  insert into public.invitation_attempts (user_id, success) values (p_user_id, p_success);
end;
$$;

-- Decides what a (possibly missing) invitation means for a user.
-- Returns an error code, 'already_member', or null when the invitation can be redeemed.
create function private.check_invitation(p_invitation public.invitation_codes, p_user_id uuid)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_status public.membership_status;
begin
  if p_invitation.id is null then
    return 'invalid_code';
  end if;
  if p_invitation.revoked_at is not null then
    return 'revoked';
  end if;
  -- clock_timestamp(): the real time, after any wait for the invitation row lock.
  if p_invitation.expires_at is not null and p_invitation.expires_at <= clock_timestamp() then
    return 'expired';
  end if;

  select m.status into v_status
  from public.memberships m
  where m.community_id = p_invitation.community_id
    and m.user_id = p_user_id;

  if found then
    if v_status = 'active' then
      return 'already_member';
    end if;
    -- A removed member cannot rejoin by code.
    return 'invalid_code';
  end if;

  if p_invitation.max_redemptions is not null
     and p_invitation.redemption_count >= p_invitation.max_redemptions then
    return 'exhausted';
  end if;

  return null;
end;
$$;

revoke all on all functions in schema private from public;

-- preview_invitation -------------------------------------------------------------------------

create function public.preview_invitation(p_code text) returns jsonb
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
  if v_uid is null then
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
end;
$$;

-- redeem_invitation --------------------------------------------------------------------------

create function public.redeem_invitation(p_code text, p_display_name text) returns jsonb
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
  if v_uid is null then
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
end;
$$;

-- create_invitation --------------------------------------------------------------------------

create function public.create_invitation(
  p_community_id uuid,
  p_expires_at timestamptz default null,
  p_max_redemptions integer default null
) returns public.invitation_codes
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  -- Also the answer for a community that does not exist, so ids cannot be probed.
  if p_community_id is null or not public.is_organizer(p_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'validation_failed:expires_at';
  end if;
  if p_max_redemptions is not null and p_max_redemptions < 1 then
    raise exception using errcode = 'P0001', message = 'validation_failed:max_redemptions';
  end if;

  -- The role is fixed: organizers cannot mint organizer invitations.
  return private.insert_invitation(p_community_id, 'member', v_uid, p_expires_at, p_max_redemptions);
end;
$$;

-- revoke_invitation --------------------------------------------------------------------------

create function public.revoke_invitation(p_invitation_id uuid) returns public.invitation_codes
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_invitation public.invitation_codes;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;

  select ic.* into v_invitation
  from public.invitation_codes ic
  where ic.id = p_invitation_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if not public.is_organizer(v_invitation.community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;

  if v_invitation.revoked_at is null then
    update public.invitation_codes
    set revoked_at = now()
    where id = v_invitation.id
    returning * into v_invitation;
  end if;

  return v_invitation;
end;
$$;

-- admin_create_community (service_role only) -------------------------------------------------

create function public.admin_create_community(p_name text, p_timezone text) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_community_id uuid;
  v_invitation public.invitation_codes;
begin
  if char_length(v_name) not between 1 and 80 then
    raise exception using errcode = 'P0001', message = 'validation_failed:name';
  end if;
  if not private.is_valid_timezone(p_timezone) then
    raise exception using errcode = 'P0001', message = 'validation_failed:timezone';
  end if;

  insert into public.communities (name, timezone)
  values (v_name, p_timezone)
  returning id into v_community_id;

  v_invitation := private.insert_invitation(
    v_community_id, 'organizer', null, now() + interval '7 days', 1
  );

  return jsonb_build_object(
    'community_id', v_community_id,
    'organizer_code', v_invitation.code
  );
end;
$$;

-- update_display_name ------------------------------------------------------------------------

create function public.update_display_name(p_display_name text) returns public.profiles
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_profile public.profiles;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;

  v_name := private.clean_display_name(p_display_name);
  if v_name is null then
    raise exception using errcode = 'P0001', message = 'validation_failed:display_name';
  end if;

  update public.profiles
  set display_name = v_name,
      updated_at = now()
  where id = v_uid
  returning * into v_profile;

  if not found then
    -- Profiles are only created by redeeming an invitation.
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  return v_profile;
end;
$$;

-- Grants -------------------------------------------------------------------------------------

revoke all on function public.preview_invitation(text)
  from public, anon, authenticated, service_role;
revoke all on function public.redeem_invitation(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.create_invitation(uuid, timestamptz, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.revoke_invitation(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_create_community(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.update_display_name(text)
  from public, anon, authenticated, service_role;

grant execute on function public.preview_invitation(text) to authenticated;
grant execute on function public.redeem_invitation(text, text) to authenticated;
grant execute on function public.create_invitation(uuid, timestamptz, integer) to authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;
grant execute on function public.update_display_name(text) to authenticated;
grant execute on function public.admin_create_community(text, text) to service_role;
