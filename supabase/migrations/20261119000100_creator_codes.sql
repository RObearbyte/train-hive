-- TrainHive C1: self-serve community creation gated by creator codes, and community editing.
-- Contract: docs/API_CONTRACT.md ("Creator codes and community management").
--
--   * community_creator_codes / community_creator_redemptions: RLS on, no grant and no policy
--     for any API role (service_role included). Only the definer functions below touch them;
--     the platform owner reads them from the SQL editor as `postgres`.
--   * admin_create_creator_code / admin_revoke_creator_code: service_role only (and `postgres`,
--     the owner, from the SQL editor), like admin_create_community, which stays as the
--     first-organizer bootstrap.
--   * preview_creator_code / create_community_with_code: authenticated. They RETURN
--     {ok:false,error} instead of raising so the failed-attempt row survives, and they share the
--     invitation limiter (invitation_attempts, its per-user advisory lock, 5 failures per
--     15 minutes counted over invitation AND creator codes together).
--   * create_community_with_code is idempotent per (caller, p_request_id): a retry after success
--     returns the first result instead of creating a second community.
--   * update_community: organizer only, re-checked after the row locks. Sessions keep their own
--     time zone; statistics buckets use the community's current one.
--   * list_my_communities: every active membership of the caller with its community.

-- Tables ------------------------------------------------------------------------------------

create table public.community_creator_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  note text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  max_uses integer not null default 1,
  use_count integer not null default 0,
  revoked_at timestamptz,
  -- Null when issued from the SQL editor or with the service-role key (no calling user).
  created_by uuid references auth.users (id) on delete set null,
  constraint community_creator_codes_code_key unique (code),
  -- Stored normalized, same alphabet as invitation codes.
  constraint community_creator_codes_code_format_check check (code ~ '^[2-9A-HJKMNP-TV-Z]{8}$'),
  constraint community_creator_codes_note_check check (note is null or char_length(note) between 1 and 100),
  constraint community_creator_codes_max_uses_check check (max_uses >= 1),
  constraint community_creator_codes_use_count_check check (use_count between 0 and max_uses)
);

create table public.community_creator_redemptions (
  id uuid primary key default gen_random_uuid(),
  -- Restrict: a code with redemptions is revoked, never deleted, so the per-user community
  -- limit keeps counting what was created with it.
  code_id uuid not null references public.community_creator_codes (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete cascade,
  community_id uuid not null references public.communities (id) on delete cascade,
  membership_id uuid not null references public.memberships (id) on delete cascade,
  -- The client's idempotency key for create_community_with_code.
  request_id uuid not null,
  redeemed_at timestamptz not null default now(),
  constraint community_creator_redemptions_code_community_key unique (code_id, community_id),
  constraint community_creator_redemptions_user_request_key unique (user_id, request_id)
);

create index community_creator_redemptions_community_id_idx
  on public.community_creator_redemptions (community_id);
create index community_creator_redemptions_membership_id_idx
  on public.community_creator_redemptions (membership_id);

revoke all on table public.community_creator_codes, public.community_creator_redemptions
  from public, anon, authenticated, service_role;

alter table public.community_creator_codes enable row level security;
alter table public.community_creator_redemptions enable row level security;
-- No policies: nobody but the definer functions (and the owner) can read or write them.

-- Internal helpers --------------------------------------------------------------------------

-- What a (possibly missing) creator code means right now: an error code, or null when it can
-- be used. clock_timestamp(): the real time, also after a wait for the code's row lock.
create function private.check_creator_code(p_code public.community_creator_codes) returns text
language plpgsql
volatile
set search_path = ''
as $$
begin
  if p_code.id is null then
    return 'invalid_code';
  end if;
  if p_code.revoked_at is not null then
    return 'revoked';
  end if;
  if p_code.expires_at <= clock_timestamp() then
    return 'expired';
  end if;
  if p_code.use_count >= p_code.max_uses then
    return 'exhausted';
  end if;
  return null;
end;
$$;

revoke all on function private.check_creator_code(public.community_creator_codes)
  from public, anon, authenticated, service_role;

-- admin_create_creator_code (service_role only) ---------------------------------------------

create function public.admin_create_creator_code(
  p_note text default null,
  p_expires_in_days integer default 14,
  p_max_uses integer default 1
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_note text;
  v_row public.community_creator_codes;
begin
  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    v_note := private.clean_required_text(p_note, 'note', 100, false);
  end if;
  if p_expires_in_days is null or p_expires_in_days not between 1 and 365 then
    raise exception using errcode = 'P0001', message = 'validation_failed:expires_in_days';
  end if;
  if p_max_uses is null or p_max_uses not between 1 and 50 then
    raise exception using errcode = 'P0001', message = 'validation_failed:max_uses';
  end if;

  for i in 1..5 loop
    begin
      insert into public.community_creator_codes (code, note, expires_at, max_uses, created_by)
      values (
        private.generate_invitation_code(), v_note,
        now() + make_interval(days => p_expires_in_days), p_max_uses, auth.uid()
      )
      returning * into v_row;
      return jsonb_build_object(
        'code', v_row.code,
        'expires_at', v_row.expires_at,
        'max_uses', v_row.max_uses
      );
    exception
      when unique_violation then
        -- The generated code collided with an existing one: try again with a new code.
        null;
    end;
  end loop;
  raise exception 'could not generate a unique creator code';
end;
$$;

-- admin_revoke_creator_code (service_role only) ---------------------------------------------

-- Idempotent: revoking a revoked code returns it unchanged (changed = false).
create function public.admin_revoke_creator_code(p_code text) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.community_creator_codes;
  v_changed boolean := false;
begin
  select cc.* into v_row
  from public.community_creator_codes cc
  where cc.code = private.normalize_invitation_code(p_code)
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  if v_row.revoked_at is null then
    update public.community_creator_codes cc
    set revoked_at = clock_timestamp()
    where cc.id = v_row.id
    returning * into v_row;
    v_changed := true;
  end if;

  return jsonb_build_object(
    'code', v_row.code,
    'revoked_at', v_row.revoked_at,
    'use_count', v_row.use_count,
    'max_uses', v_row.max_uses,
    'changed', v_changed
  );
end;
$$;

-- preview_creator_code ----------------------------------------------------------------------

create function public.preview_creator_code(p_code text) returns jsonb
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
  if v_uid is null then
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
end;
$$;

-- create_community_with_code ----------------------------------------------------------------

-- Order of checks: not_authenticated, request id, (per-user lock) idempotent replay,
-- rate_limited, input (name, timezone, display name: not code guesses, not counted, and they
-- reveal nothing about the code), community_limit_reached (also before the code is looked up),
-- then the code under its row lock (failures counted).
create function public.create_community_with_code(
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
  if v_uid is null then
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
end;
$$;

-- update_community --------------------------------------------------------------------------

-- Organizer of the community only. Renames it and / or changes its time zone. Existing
-- sessions are untouched (each stores its own time zone); new trainings default to the new
-- zone, and statistics week / month buckets are computed in the community's CURRENT zone, so a
-- change re-buckets history. Setting the same values again returns the row unchanged.
create function public.update_community(p_community_id uuid, p_name text, p_timezone text)
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

  if v_current.name = v_name and v_current.timezone = p_timezone then
    return v_current;
  end if;

  update public.communities c
  set name = v_name,
      timezone = p_timezone
  where c.id = p_community_id
  returning * into v_row;
  return v_row;
end;
$$;

-- list_my_communities -----------------------------------------------------------------------

-- Every ACTIVE membership of the caller, oldest first, with its community. Nothing about other
-- members. Removed memberships are not listed.
create function public.list_my_communities() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  return (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'community_id', c.id,
          'membership_id', m.id,
          'name', c.name,
          'timezone', c.timezone,
          'role', m.role,
          'joined_at', m.joined_at
        )
        order by m.joined_at, m.id
      ),
      '[]'::jsonb
    )
    from public.memberships m
    join public.communities c on c.id = m.community_id
    where m.user_id = v_uid
      and m.status = 'active'
  );
end;
$$;

-- Grants ------------------------------------------------------------------------------------

revoke all on function public.admin_create_creator_code(text, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_revoke_creator_code(text)
  from public, anon, authenticated, service_role;
revoke all on function public.preview_creator_code(text)
  from public, anon, authenticated, service_role;
revoke all on function public.create_community_with_code(text, text, text, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.update_community(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.list_my_communities()
  from public, anon, authenticated, service_role;

grant execute on function public.admin_create_creator_code(text, integer, integer) to service_role;
grant execute on function public.admin_revoke_creator_code(text) to service_role;
grant execute on function public.preview_creator_code(text) to authenticated;
grant execute on function public.create_community_with_code(text, text, text, text, uuid) to authenticated;
grant execute on function public.update_community(uuid, text, text) to authenticated;
grant execute on function public.list_my_communities() to authenticated;
