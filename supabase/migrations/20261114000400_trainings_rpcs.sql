-- TrainHive M1-B2: training, RSVP and deadline-finalization RPCs.
-- Contract: docs/API_CONTRACT.md ("Trainings").
--
-- Invariants enforced here:
--   * going_count always equals the number of `going` RSVP rows of the session. It changes
--     only under a FOR UPDATE lock on the session row (set_rsvp), plus two safety-net triggers
--     for paths that bypass set_rsvp (member removed, RSVP row deleted by a cascade).
--   * The confirm / cancel decision is taken once, by finalize_due_sessions, from the count at
--     the deadline. Once the deadline has passed, RSVPs are closed and the deadline and the
--     participant limits are frozen, so nothing can change or escape the decision.
--   * Lock order is always membership row -> session row, so set_rsvp and member removal
--     cannot deadlock.

-- Input parsing helpers (schema private) ------------------------------------------------------

create function private.fail_validation(p_field text) returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = 'validation_failed:' || p_field;
end;
$$;

-- Reads an optional/required string. Blank becomes null. Single-line values get whitespace
-- runs collapsed; multi-line values are only trimmed.
create function private.input_text(
  p_input jsonb,
  p_key text,
  p_max_length integer,
  p_required boolean,
  p_multiline boolean
) returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value jsonb := p_input -> p_key;
  v_text text;
begin
  if v_value is not null and jsonb_typeof(v_value) <> 'null' then
    if jsonb_typeof(v_value) <> 'string' then
      perform private.fail_validation(p_key);
    end if;
    v_text := v_value #>> '{}';
    if p_multiline then
      v_text := btrim(v_text, E' \t\n\r');
    else
      v_text := btrim(regexp_replace(v_text, '\s+', ' ', 'g'));
    end if;
    v_text := nullif(v_text, '');
  end if;

  if v_text is null then
    if p_required then
      perform private.fail_validation(p_key);
    end if;
    return null;
  end if;
  if char_length(v_text) > p_max_length then
    perform private.fail_validation(p_key);
  end if;
  return v_text;
end;
$$;

-- Reads an optional ISO 8601 timestamp. An explicit UTC offset (or Z) is mandatory so the
-- instant never depends on the database session's time zone.
create function private.input_timestamptz(p_input jsonb, p_key text) returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value jsonb := p_input -> p_key;
  v_text text;
begin
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v_value) <> 'string' then
    perform private.fail_validation(p_key);
  end if;
  v_text := btrim(v_value #>> '{}');
  if v_text !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$' then
    perform private.fail_validation(p_key);
  end if;
  begin
    return v_text::timestamptz;
  exception
    when data_exception then
      -- Well-formed but not a real instant (e.g. February 30th).
      perform private.fail_validation(p_key);
  end;
end;
$$;

create function private.input_integer(p_input jsonb, p_key text) returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value jsonb := p_input -> p_key;
  v_number numeric;
begin
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v_value) <> 'number' then
    perform private.fail_validation(p_key);
  end if;
  v_number := (v_value #>> '{}')::numeric;
  if v_number <> trunc(v_number) or v_number not between -2147483648 and 2147483647 then
    perform private.fail_validation(p_key);
  end if;
  return v_number::integer;
end;
$$;

create function private.input_number(p_input jsonb, p_key text, p_min numeric, p_max numeric)
returns double precision
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value jsonb := p_input -> p_key;
  v_number numeric;
begin
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v_value) <> 'number' then
    perform private.fail_validation(p_key);
  end if;
  v_number := (v_value #>> '{}')::numeric;
  if v_number not between p_min and p_max then
    perform private.fail_validation(p_key);
  end if;
  return v_number::double precision;
end;
$$;

-- Validates the client-editable fields of a training and returns them in a row value.
-- Only the keys listed in the contract are read: unknown keys (including going_count, status,
-- organizer_id, decided_at and the cancel fields) are ignored.
-- rsvp_deadline is returned null when not supplied; the caller applies the default.
create function private.parse_training_input(p_input jsonb, p_default_timezone text)
returns public.training_sessions
language plpgsql
stable
set search_path = ''
as $$
declare
  r public.training_sessions;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    perform private.fail_validation('input');
  end if;

  r.title := private.input_text(p_input, 'title', 80, true, false);
  r.description := private.input_text(p_input, 'description', 2000, false, true);

  r.activity_type := coalesce(private.input_text(p_input, 'activity_type', 50, false, false), 'other');
  if not exists (select 1 from public.activity_types a where a.key = r.activity_type) then
    perform private.fail_validation('activity_type');
  end if;

  r.starts_at := private.input_timestamptz(p_input, 'starts_at');
  if r.starts_at is null then
    perform private.fail_validation('starts_at');
  end if;

  r.ends_at := private.input_timestamptz(p_input, 'ends_at');
  if r.ends_at is not null and r.ends_at <= r.starts_at then
    perform private.fail_validation('ends_at');
  end if;

  r.rsvp_deadline := private.input_timestamptz(p_input, 'rsvp_deadline');
  if r.rsvp_deadline is not null and r.rsvp_deadline > r.starts_at then
    perform private.fail_validation('rsvp_deadline');
  end if;

  r.timezone := coalesce(private.input_text(p_input, 'timezone', 64, false, false), p_default_timezone);
  if not exists (select 1 from pg_catalog.pg_timezone_names tz where tz.name = r.timezone) then
    perform private.fail_validation('timezone');
  end if;

  r.location_name := private.input_text(p_input, 'location_name', 120, true, false);
  r.address := private.input_text(p_input, 'address', 200, false, false);

  r.latitude := private.input_number(p_input, 'latitude', -90, 90);
  r.longitude := private.input_number(p_input, 'longitude', -180, 180);
  if r.latitude is null and r.longitude is not null then
    perform private.fail_validation('latitude');
  end if;
  if r.latitude is not null and r.longitude is null then
    perform private.fail_validation('longitude');
  end if;

  r.map_url := private.input_text(p_input, 'map_url', 2048, false, false);
  if r.map_url is not null and r.map_url !~* '^https?://[^[:space:]/]+[^[:space:]]*$' then
    perform private.fail_validation('map_url');
  end if;

  r.meeting_instructions := private.input_text(p_input, 'meeting_instructions', 1000, false, true);

  r.min_participants := private.input_integer(p_input, 'min_participants');
  if r.min_participants is null or r.min_participants < 1 then
    perform private.fail_validation('min_participants');
  end if;

  r.max_participants := private.input_integer(p_input, 'max_participants');
  if r.max_participants is not null and r.max_participants < r.min_participants then
    perform private.fail_validation('max_participants');
  end if;

  return r;
end;
$$;

-- create_training ----------------------------------------------------------------------------

create function public.create_training(p_community_id uuid, p_input jsonb)
returns public.training_sessions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_timezone text;
  v_in public.training_sessions;
  v_session public.training_sessions;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  -- Also the answer for a community that does not exist, so ids cannot be probed.
  if p_community_id is null or not public.is_organizer(p_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;

  select c.timezone into v_timezone from public.communities c where c.id = p_community_id;

  v_in := private.parse_training_input(p_input, v_timezone);
  v_in.rsvp_deadline := coalesce(v_in.rsvp_deadline, v_in.starts_at - interval '2 hours');

  if v_in.starts_at <= now() then
    perform private.fail_validation('starts_at');
  end if;
  if v_in.rsvp_deadline <= now() then
    perform private.fail_validation('rsvp_deadline');
  end if;

  insert into public.training_sessions (
    community_id, organizer_id, title, description, activity_type, starts_at, ends_at,
    rsvp_deadline, timezone, location_name, address, latitude, longitude, map_url,
    meeting_instructions, min_participants, max_participants
  ) values (
    p_community_id, v_uid, v_in.title, v_in.description, v_in.activity_type, v_in.starts_at,
    v_in.ends_at, v_in.rsvp_deadline, v_in.timezone, v_in.location_name, v_in.address,
    v_in.latitude, v_in.longitude, v_in.map_url, v_in.meeting_instructions,
    v_in.min_participants, v_in.max_participants
  )
  returning * into v_session;

  return v_session;
end;
$$;

-- update_training ----------------------------------------------------------------------------

create function public.update_training(p_session_id uuid, p_input jsonb)
returns public.training_sessions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_community_id uuid;
  v_timezone text;
  v_session public.training_sessions;
  v_in public.training_sessions;
  v_open boolean;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;

  -- Authorize before taking the row lock, so only organizers can ever hold it.
  select s.community_id into v_community_id
  from public.training_sessions s
  where s.id = p_session_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if not public.is_organizer(v_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;

  -- Serializes with set_rsvp, cancel_training and the finalizer.
  select s.* into v_session
  from public.training_sessions s
  where s.id = p_session_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  if v_session.status in ('cancelled', 'completed') then
    raise exception using errcode = 'P0001', message = 'session_not_editable';
  end if;

  select c.timezone into v_timezone from public.communities c where c.id = v_community_id;
  v_in := private.parse_training_input(p_input, v_timezone);

  -- "Open" = still collecting RSVPs. A scheduled session whose deadline has passed is only
  -- waiting for the finalizer; it is treated like a confirmed one so that the pending
  -- decision cannot be escaped by moving the deadline or changing the limits.
  v_open := v_session.status = 'scheduled' and clock_timestamp() < v_session.rsvp_deadline;

  if v_open then
    v_in.rsvp_deadline := coalesce(v_in.rsvp_deadline, v_in.starts_at - interval '2 hours');
    if v_in.starts_at <= now() then
      perform private.fail_validation('starts_at');
    end if;
    if v_in.rsvp_deadline <= now() then
      perform private.fail_validation('rsvp_deadline');
    end if;
    if v_in.max_participants is not null and v_in.max_participants < v_session.going_count then
      perform private.fail_validation('max_participants');
    end if;
  else
    if v_in.rsvp_deadline is not null and v_in.rsvp_deadline is distinct from v_session.rsvp_deadline then
      perform private.fail_validation('rsvp_deadline');
    end if;
    v_in.rsvp_deadline := v_session.rsvp_deadline;
    if v_in.min_participants is distinct from v_session.min_participants then
      perform private.fail_validation('min_participants');
    end if;
    if v_in.max_participants is distinct from v_session.max_participants then
      perform private.fail_validation('max_participants');
    end if;
    -- The start may move, but only to a future time (and never before the frozen deadline).
    if v_in.starts_at is distinct from v_session.starts_at
       and (v_in.starts_at <= now() or v_in.starts_at < v_session.rsvp_deadline) then
      perform private.fail_validation('starts_at');
    end if;
  end if;

  update public.training_sessions
  set title = v_in.title,
      description = v_in.description,
      activity_type = v_in.activity_type,
      starts_at = v_in.starts_at,
      ends_at = v_in.ends_at,
      rsvp_deadline = v_in.rsvp_deadline,
      timezone = v_in.timezone,
      location_name = v_in.location_name,
      address = v_in.address,
      latitude = v_in.latitude,
      longitude = v_in.longitude,
      map_url = v_in.map_url,
      meeting_instructions = v_in.meeting_instructions,
      min_participants = v_in.min_participants,
      max_participants = v_in.max_participants,
      updated_at = now()
  where id = p_session_id
  returning * into v_session;

  return v_session;
end;
$$;

-- cancel_training ----------------------------------------------------------------------------

create function public.cancel_training(p_session_id uuid) returns public.training_sessions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_community_id uuid;
  v_session public.training_sessions;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;

  select s.community_id into v_community_id
  from public.training_sessions s
  where s.id = p_session_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if not public.is_organizer(v_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;

  select s.* into v_session
  from public.training_sessions s
  where s.id = p_session_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  if v_session.status = 'cancelled' then
    return v_session;
  end if;
  if v_session.status = 'completed' then
    raise exception using errcode = 'P0001', message = 'session_not_cancellable';
  end if;

  update public.training_sessions
  set status = 'cancelled',
      cancel_reason = 'organizer',
      cancelled_at = now(),
      cancelled_by = v_uid,
      updated_at = now()
  where id = p_session_id
  returning * into v_session;

  return v_session;
end;
$$;

-- set_rsvp -----------------------------------------------------------------------------------

create function public.set_rsvp(p_session_id uuid, p_response public.rsvp_response) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_community_id uuid;
  v_session public.training_sessions;
  v_previous public.rsvp_response;
  v_delta integer;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if p_response is null then
    raise exception using errcode = 'P0001', message = 'validation_failed:response';
  end if;

  -- community_id never changes, so it is safe to read it before locking.
  select s.community_id into v_community_id
  from public.training_sessions s
  where s.id = p_session_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  -- Share-lock the caller's membership: a concurrent removal waits for this transaction and
  -- then sees (and releases) the RSVP written below; if the removal got there first, this
  -- statement waits for it and then no longer finds an active membership.
  perform 1
  from public.memberships m
  where m.community_id = v_community_id
    and m.user_id = v_uid
    and m.status = 'active'
  for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;

  -- Everything below is serialized per session.
  select s.* into v_session
  from public.training_sessions s
  where s.id = p_session_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  -- clock_timestamp(): the real time after any lock wait, not the transaction start time.
  if v_session.status <> 'scheduled' or clock_timestamp() >= v_session.rsvp_deadline then
    raise exception using errcode = 'P0001', message = 'rsvp_closed';
  end if;

  select r.response into v_previous
  from public.training_rsvps r
  where r.session_id = p_session_id
    and r.user_id = v_uid;
  v_previous := coalesce(v_previous, 'no_response');

  if v_previous <> p_response then
    if p_response = 'going'
       and v_session.max_participants is not null
       and v_session.going_count >= v_session.max_participants then
      raise exception using errcode = 'P0001', message = 'session_full';
    end if;

    insert into public.training_rsvps (session_id, community_id, user_id, response)
    values (p_session_id, v_community_id, v_uid, p_response)
    on conflict (session_id, user_id) do update
      set response = excluded.response,
          responded_at = now(),
          updated_at = now();

    v_delta := (p_response = 'going')::integer - (v_previous = 'going')::integer;
    if v_delta <> 0 then
      update public.training_sessions
      set going_count = going_count + v_delta
      where id = p_session_id
      returning going_count into v_session.going_count;
    end if;
  end if;

  return jsonb_build_object(
    'response', p_response,
    'going_count', v_session.going_count,
    'status', v_session.status
  );
end;
$$;

-- finalize_due_sessions (service_role only; scheduled by pg_cron) -----------------------------

create function public.finalize_due_sessions() returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  -- Only `scheduled` rows are selected, so a decided session is never looked at again and a
  -- second run (or a concurrent one, thanks to SKIP LOCKED) changes nothing.
  with due as (
    select s.id
    from public.training_sessions s
    where s.status = 'scheduled'
      and s.rsvp_deadline <= now()
    order by s.rsvp_deadline, s.id
    for update skip locked
  )
  update public.training_sessions s
  set status = case
        when s.going_count >= s.min_participants then 'confirmed'::public.session_status
        else 'cancelled'::public.session_status
      end,
      cancel_reason = case
        when s.going_count >= s.min_participants then null
        else 'insufficient_participation'::public.cancel_reason
      end,
      cancelled_at = case when s.going_count >= s.min_participants then null else now() end,
      decided_at = now(),
      updated_at = now()
  from due
  where s.id = due.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Safety nets for going_count ----------------------------------------------------------------

-- When a membership goes from active to removed, the member's `going` RSVPs on sessions that
-- are still `scheduled` are cleared and the counts adjusted. Decided sessions keep their
-- history. Lock order matches set_rsvp: the membership row is already locked by the UPDATE
-- that fired this trigger, then the sessions.
create function private.release_rsvps_of_removed_member() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_id uuid;
begin
  for v_session_id in
    select s.id
    from public.training_sessions s
    where s.community_id = new.community_id
      and s.status = 'scheduled'
    order by s.id
    for update
  loop
    update public.training_rsvps
    set response = 'no_response',
        responded_at = now(),
        updated_at = now()
    where session_id = v_session_id
      and user_id = new.user_id
      and response = 'going';

    if found then
      update public.training_sessions
      set going_count = going_count - 1
      where id = v_session_id;
    end if;
  end loop;
  return null;
end;
$$;

create trigger memberships_release_rsvps_on_removal
  after update of status on public.memberships
  for each row
  when (old.status = 'active' and new.status = 'removed')
  execute function private.release_rsvps_of_removed_member();

-- RSVP rows are never deleted by the app, but a cascade (a deleted profile / auth user) can
-- remove them. Keep the count of still-scheduled sessions correct in that case.
create function private.uncount_deleted_rsvp() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.training_sessions
  set going_count = going_count - 1
  where id = old.session_id
    and status = 'scheduled';
  return null;
end;
$$;

create trigger training_rsvps_uncount_on_delete
  after delete on public.training_rsvps
  for each row
  when (old.response = 'going')
  execute function private.uncount_deleted_rsvp();

-- Grants -------------------------------------------------------------------------------------

revoke all on all functions in schema private from public;

revoke all on function public.create_training(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.update_training(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.cancel_training(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.set_rsvp(uuid, public.rsvp_response)
  from public, anon, authenticated, service_role;
revoke all on function public.finalize_due_sessions()
  from public, anon, authenticated, service_role;

grant execute on function public.create_training(uuid, jsonb) to authenticated;
grant execute on function public.update_training(uuid, jsonb) to authenticated;
grant execute on function public.cancel_training(uuid) to authenticated;
grant execute on function public.set_rsvp(uuid, public.rsvp_response) to authenticated;
grant execute on function public.finalize_due_sessions() to service_role;
