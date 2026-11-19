-- TrainHive P1: Events. A "training" becomes one kind of event: training | race | sports_event |
-- social. Plan: docs/EVENTS_PLAN.md ("Confirmed decisions", "1. Events"). Contract:
-- docs/API_CONTRACT.md ("Events (P1)").
--
-- "Event" is UI vocabulary only: the table stays public.training_sessions and the RPCs keep their
-- names and signatures (create_training, update_training, cancel_training, set_rsvp, ...); they
-- accept the new keys.
--
--   * event_kind (enum, immutable after creation) and event_subtype (lookup event_subtypes, per
--     kind). activity_type stays as a compatibility column, always derived from the subtype
--     (event_subtypes.activity_type; identity for trainings), kept in sync by a BEFORE trigger, so
--     existing readers (statistics history, the app's list) keep working.
--   * Course fields distance_km / elevation_gain_m (running, trail_running, asphalt_running, ocr
--     subtypes of any kind) and obstacle_count (ocr only); event_notes (any kind).
--   * min_participants: required (>= 1) for trainings, null for every other kind. Only trainings
--     are decided by finalize_due_sessions. Other kinds are created `confirmed`, take RSVPs while
--     confirmed and before their deadline (subject to capacity), and are never decided or
--     auto-cancelled; the organizer can still cancel them.
--   * Notification texts name the kind; the `training_confirmed` notification only ever comes from
--     the finalizer's decision of a training.
--   * Statistics count completed events of every kind exactly like trainings (no change to the
--     set S); history items and top sessions gain event_kind (additive).
--
-- Lock order and every Milestone 1-4 / G1-G2 rule are unchanged.

-- Enum and lookup -----------------------------------------------------------------------------

create type public.event_kind as enum ('training', 'race', 'sports_event', 'social');

-- The subtypes of each kind. activity_type is the legacy activity type written to
-- training_sessions.activity_type for events of this subtype (compatibility; identity for
-- trainings). Extensible by inserting rows; no RPC writes this table.
create table public.event_subtypes (
  kind public.event_kind not null,
  key text not null,
  label text not null,
  sort_order integer not null default 0,
  activity_type text not null references public.activity_types (key),
  primary key (kind, key),
  constraint event_subtypes_key_check check (key ~ '^[a-z][a-z0-9_]{0,49}$'),
  constraint event_subtypes_label_check
    check (label = btrim(label) and char_length(label) between 1 and 60)
);

-- Training subtypes are exactly the activity types (identity mapping), including any type a
-- deployment added to activity_types, so every existing row can be backfilled.
insert into public.event_subtypes (kind, key, label, sort_order, activity_type)
select 'training', a.key, a.label, a.sort_order, a.key
from public.activity_types a;

insert into public.event_subtypes (kind, key, label, sort_order, activity_type) values
  ('race', 'trail_running', 'Trail running', 10, 'trail_running'),
  ('race', 'asphalt_running', 'Asphalt running', 20, 'running'),
  ('race', 'ocr', 'OCR', 30, 'ocr'),
  ('sports_event', 'crossfit_event', 'CrossFit event', 10, 'functional_fitness'),
  ('sports_event', 'public_training', 'Public training', 20, 'other'),
  ('sports_event', 'other', 'Other', 100, 'other'),
  ('social', 'social_gathering', 'Social gathering', 10, 'other'),
  ('social', 'other', 'Other', 100, 'other');

revoke all on table public.event_subtypes from public, anon, authenticated, service_role;
grant select on table public.event_subtypes to authenticated;

alter table public.event_subtypes enable row level security;

create policy event_subtypes_select_authenticated on public.event_subtypes
  for select to authenticated
  using (true);

-- training_sessions: new columns and backfill ---------------------------------------------------

alter table public.training_sessions
  add column event_kind public.event_kind not null default 'training',
  add column event_subtype text,
  add column distance_km numeric(6, 2),
  add column elevation_gain_m integer,
  add column obstacle_count integer,
  add column event_notes text;

-- Every existing row is a training whose subtype is its activity type.
update public.training_sessions
set event_subtype = activity_type
where event_subtype is null;

alter table public.training_sessions
  alter column event_subtype set not null,
  alter column min_participants drop not null,
  add constraint training_sessions_event_subtype_fkey
    foreign key (event_kind, event_subtype) references public.event_subtypes (kind, key),
  drop constraint training_sessions_max_participants_check,
  add constraint training_sessions_max_participants_check
    check (max_participants is null or max_participants >= coalesce(min_participants, 1)),
  -- A minimum exactly for trainings.
  add constraint training_sessions_min_by_kind_check
    check ((event_kind = 'training') = (min_participants is not null)),
  -- Only trainings wait for a decision; other kinds are created confirmed.
  add constraint training_sessions_kind_status_check
    check (event_kind = 'training' or status <> 'scheduled'),
  add constraint training_sessions_distance_km_check
    check (distance_km is null or (distance_km > 0 and distance_km <= 1000)),
  add constraint training_sessions_elevation_gain_m_check
    check (elevation_gain_m is null or elevation_gain_m between 0 and 20000),
  add constraint training_sessions_obstacle_count_check
    check (obstacle_count is null or obstacle_count between 0 and 500),
  add constraint training_sessions_course_fields_check
    check (
      (distance_km is null and elevation_gain_m is null)
      or event_subtype in ('running', 'trail_running', 'asphalt_running', 'ocr')
    ),
  add constraint training_sessions_obstacle_subtype_check
    check (obstacle_count is null or event_subtype = 'ocr'),
  add constraint training_sessions_event_notes_check
    check (event_notes is null or char_length(event_notes) between 1 and 1000);

comment on column public.training_sessions.activity_type is
  'Compatibility: derived from (event_kind, event_subtype) via event_subtypes.activity_type.';
comment on column public.training_sessions.min_participants is
  'Trainings only (>= 1); null for races, sports events and social events.';

-- Keeps activity_type derived from the subtype on every write path (RPCs, fixtures, legacy
-- inserts that only name activity_type), and the kind immutable.
--   INSERT without event_subtype (legacy shape): a training takes its activity_type as subtype.
--   UPDATE of activity_type alone on a training (legacy shape): the subtype follows it.
-- Then activity_type := event_subtypes.activity_type of (kind, subtype). An unknown pair is left
-- to the foreign key.
create function private.sync_event_subtype() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity text;
begin
  if tg_op = 'INSERT' then
    if new.event_subtype is null and new.event_kind = 'training' then
      new.event_subtype := new.activity_type;
    end if;
  else
    if new.event_kind is distinct from old.event_kind then
      raise exception using errcode = 'P0001', message = 'validation_failed:event_kind';
    end if;
    if new.event_kind = 'training'
       and new.event_subtype is not distinct from old.event_subtype
       and new.activity_type is distinct from old.activity_type then
      new.event_subtype := new.activity_type;
    end if;
  end if;

  select st.activity_type into v_activity
  from public.event_subtypes st
  where st.kind = new.event_kind
    and st.key = new.event_subtype;
  if found then
    new.activity_type := v_activity;
  end if;
  return new;
end;
$$;

create trigger training_sessions_sync_event_subtype
  before insert or update of event_kind, event_subtype, activity_type
  on public.training_sessions
  for each row
  execute function private.sync_event_subtype();

-- Labels used in notification texts -----------------------------------------------------------

-- 'training' | 'race' | 'sports event' | 'social event'
create function private.event_kind_label(p_kind public.event_kind) returns text
language sql
immutable
set search_path = ''
as $$
  select case p_kind
    when 'training' then 'training'
    when 'race' then 'race'
    when 'sports_event' then 'sports event'
    when 'social' then 'social event'
  end;
$$;

-- Same, capitalized: 'Training' | 'Race' | 'Sports event' | 'Social event'
create function private.event_kind_title(p_kind public.event_kind) returns text
language sql
immutable
set search_path = ''
as $$
  select upper(left(l, 1)) || substr(l, 2)
  from (select private.event_kind_label(p_kind) as l) x;
$$;

-- Input parsing ---------------------------------------------------------------------------------

-- Replaces private.parse_training_input. Validates the client-editable fields of an event and
-- returns them in a row value. p_current is the stored row on update, null on create.
-- Rules for the P1 keys (the Milestone 1 keys keep their full-replace meaning):
--   event_kind     absent/null: create 'training', update the stored kind. Never changes.
--   event_subtype  must belong to the kind. Absent/null: a training takes activity_type (default
--                  'other', validated as before: validation_failed:activity_type); other kinds keep
--                  the stored subtype on update, and on create default to sports_event 'other',
--                  social 'social_gathering'; a race has no default (validation_failed:event_subtype).
--                  A training that sends both must send the same value (validation_failed:activity_type).
--                  Other kinds ignore activity_type (it is derived).
--   distance_km, elevation_gain_m, obstacle_count, event_notes
--                  absent: create null, update keeps the stored value; null clears it.
-- Unknown keys are ignored, as before.
create function private.parse_event_input(
  p_input jsonb,
  p_default_timezone text,
  p_known_timezones text[],
  p_current public.training_sessions
)
returns public.training_sessions
language plpgsql
stable
set search_path = ''
as $$
declare
  r public.training_sessions;
  v_updating boolean := p_current.id is not null;
  v_value jsonb;
  v_text text;
  v_number numeric;
  v_subtype text;
  v_activity text;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    perform private.fail_validation('input');
  end if;

  r.title := private.input_text(p_input, 'title', 80, true, false);
  r.description := private.input_text(p_input, 'description', 2000, false, true);

  -- Kind.
  v_value := p_input -> 'event_kind';
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    r.event_kind := case when v_updating then p_current.event_kind else 'training' end;
  else
    if jsonb_typeof(v_value) <> 'string'
       or not ((v_value #>> '{}') = any (enum_range(null::public.event_kind)::text[])) then
      perform private.fail_validation('event_kind');
    end if;
    r.event_kind := (v_value #>> '{}')::public.event_kind;
    if v_updating and r.event_kind <> p_current.event_kind then
      perform private.fail_validation('event_kind');
    end if;
  end if;

  -- Subtype (and the derived legacy activity type).
  v_subtype := private.input_text(p_input, 'event_subtype', 50, false, false);
  if r.event_kind = 'training' then
    v_activity := private.input_text(p_input, 'activity_type', 50, false, false);
    if v_subtype is null then
      v_subtype := coalesce(v_activity, 'other');
      if not exists (select 1 from public.activity_types a where a.key = v_subtype)
         or not exists (
           select 1 from public.event_subtypes st
           where st.kind = 'training' and st.key = v_subtype
         ) then
        perform private.fail_validation('activity_type');
      end if;
    else
      if not exists (
        select 1 from public.event_subtypes st
        where st.kind = 'training' and st.key = v_subtype
      ) then
        perform private.fail_validation('event_subtype');
      end if;
      if v_activity is not null and v_activity <> v_subtype then
        perform private.fail_validation('activity_type');
      end if;
    end if;
  else
    if v_subtype is null then
      if v_updating then
        v_subtype := p_current.event_subtype;
      else
        v_subtype := case r.event_kind
          when 'sports_event' then 'other'
          when 'social' then 'social_gathering'
        end;
        if v_subtype is null then
          perform private.fail_validation('event_subtype');
        end if;
      end if;
    elsif not exists (
      select 1 from public.event_subtypes st
      where st.kind = r.event_kind and st.key = v_subtype
    ) then
      perform private.fail_validation('event_subtype');
    end if;
  end if;
  r.event_subtype := v_subtype;
  select st.activity_type into r.activity_type
  from public.event_subtypes st
  where st.kind = r.event_kind
    and st.key = r.event_subtype;

  r.starts_at := private.input_timestamptz(p_input, 'starts_at');
  if r.starts_at is null then
    perform private.fail_validation('starts_at');
  end if;

  r.ends_at := private.input_timestamptz(p_input, 'ends_at');
  if r.ends_at is not null and r.ends_at <= r.starts_at then
    perform private.fail_validation('ends_at');
  end if;

  r.rsvp_deadline := private.input_timestamptz(p_input, 'rsvp_deadline');

  r.timezone := coalesce(private.input_text(p_input, 'timezone', 64, false, false), p_default_timezone);
  if r.timezone <> all (p_known_timezones) and not private.is_valid_timezone(r.timezone) then
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

  -- Participants: a minimum for trainings only.
  r.min_participants := private.input_integer(p_input, 'min_participants');
  if r.event_kind = 'training' then
    if r.min_participants is null or r.min_participants < 1 then
      perform private.fail_validation('min_participants');
    end if;
  elsif r.min_participants is not null then
    perform private.fail_validation('min_participants');
  end if;

  r.max_participants := private.input_integer(p_input, 'max_participants');
  if r.max_participants is not null
     and r.max_participants < coalesce(r.min_participants, 1) then
    perform private.fail_validation('max_participants');
  end if;

  -- Course fields. Absent key on update: keep the stored value.
  if v_updating and not (p_input ? 'distance_km') then
    r.distance_km := p_current.distance_km;
  else
    v_value := p_input -> 'distance_km';
    if v_value is not null and jsonb_typeof(v_value) <> 'null' then
      if jsonb_typeof(v_value) <> 'number' then
        perform private.fail_validation('distance_km');
      end if;
      v_number := (v_value #>> '{}')::numeric;
      -- At most 2 decimals (the column is numeric(6,2)); never rounded silently.
      if v_number <= 0 or v_number > 1000 or v_number <> round(v_number, 2) then
        perform private.fail_validation('distance_km');
      end if;
      r.distance_km := v_number;
    end if;
  end if;

  if v_updating and not (p_input ? 'elevation_gain_m') then
    r.elevation_gain_m := p_current.elevation_gain_m;
  else
    r.elevation_gain_m := private.input_integer(p_input, 'elevation_gain_m');
    if r.elevation_gain_m is not null and r.elevation_gain_m not between 0 and 20000 then
      perform private.fail_validation('elevation_gain_m');
    end if;
  end if;

  if v_updating and not (p_input ? 'obstacle_count') then
    r.obstacle_count := p_current.obstacle_count;
  else
    r.obstacle_count := private.input_integer(p_input, 'obstacle_count');
    if r.obstacle_count is not null and r.obstacle_count not between 0 and 500 then
      perform private.fail_validation('obstacle_count');
    end if;
  end if;

  if r.event_subtype not in ('running', 'trail_running', 'asphalt_running', 'ocr') then
    if r.distance_km is not null then
      perform private.fail_validation('distance_km');
    end if;
    if r.elevation_gain_m is not null then
      perform private.fail_validation('elevation_gain_m');
    end if;
  end if;
  if r.obstacle_count is not null and r.event_subtype <> 'ocr' then
    perform private.fail_validation('obstacle_count');
  end if;

  -- Notes: the announcement text hygiene (controls and bidi controls stripped, line breaks
  -- normalized, invisible-only text rejected). Blank = null.
  if v_updating and not (p_input ? 'event_notes') then
    r.event_notes := p_current.event_notes;
  else
    v_value := p_input -> 'event_notes';
    if v_value is not null and jsonb_typeof(v_value) <> 'null' then
      if jsonb_typeof(v_value) <> 'string' then
        perform private.fail_validation('event_notes');
      end if;
      v_text := v_value #>> '{}';
      if btrim(v_text, E' \t\n\r') <> '' then
        r.event_notes := private.clean_required_text(v_text, 'event_notes', 1000, true);
      end if;
    end if;
  end if;

  return r;
end;
$$;

drop function private.parse_training_input(jsonb, text, text[]);

-- create_training -------------------------------------------------------------------------------
-- As 20261124000200_data_rights.sql (locks, checks, errors unchanged), plus the P1 fields.
-- A training starts `scheduled` (decided at its deadline); every other kind starts `confirmed`.

create or replace function public.create_training(p_community_id uuid, p_input jsonb)
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

  v_in := private.parse_event_input(p_input, v_timezone, array[v_timezone], null);
  v_in.rsvp_deadline := coalesce(v_in.rsvp_deadline, v_in.starts_at - interval '2 hours');

  -- Lock order profile -> membership (the session row is new).
  perform 1 from public.profiles p where p.id = v_uid for key share;
  perform 1
  from public.memberships m
  where m.community_id = p_community_id
    and m.user_id = v_uid
    and m.status = 'active'
    and m.role = 'organizer'
  for no key update;
  if not found then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;

  if v_in.starts_at <= clock_timestamp() then
    perform private.fail_validation('starts_at');
  end if;
  -- The deadline must be in the future and strictly before the start.
  if v_in.rsvp_deadline <= clock_timestamp() or v_in.rsvp_deadline >= v_in.starts_at then
    perform private.fail_validation('rsvp_deadline');
  end if;

  insert into public.training_sessions (
    community_id, organizer_id, title, description, activity_type, starts_at, ends_at,
    rsvp_deadline, timezone, location_name, address, latitude, longitude, map_url,
    meeting_instructions, min_participants, max_participants,
    event_kind, event_subtype, distance_km, elevation_gain_m, obstacle_count, event_notes, status
  ) values (
    p_community_id, v_uid, v_in.title, v_in.description, v_in.activity_type, v_in.starts_at,
    v_in.ends_at, v_in.rsvp_deadline, v_in.timezone, v_in.location_name, v_in.address,
    v_in.latitude, v_in.longitude, v_in.map_url, v_in.meeting_instructions,
    v_in.min_participants, v_in.max_participants,
    v_in.event_kind, v_in.event_subtype, v_in.distance_km, v_in.elevation_gain_m,
    v_in.obstacle_count, v_in.event_notes,
    case when v_in.event_kind = 'training' then 'scheduled' else 'confirmed' end::public.session_status
  )
  returning * into v_session;

  return v_session;
end;
$$;

-- update_training -------------------------------------------------------------------------------
-- As 20261115000200_attendance_rpcs.sql for trainings (every rule unchanged). For the other kinds
-- (always `confirmed` until cancelled or completed):
--   * registration open (before the deadline): like an open training: the start (future only),
--     the deadline (future, before the start) and the maximum (not below going_count) are
--     editable;
--   * deadline passed: the deadline is frozen; the maximum stays editable (not below
--     going_count); the start may move to the future and after the deadline, as for a confirmed
--     training;
--   * the attendance time freeze (ended, or any attendance record) applies to every kind;
--   * the kind never changes (validation_failed:event_kind); the subtype changes within the kind.

create or replace function public.update_training(p_session_id uuid, p_input jsonb)
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

  -- Serializes with set_rsvp, cancel_training, the finalizer and every attendance writer.
  select s.* into v_session
  from public.training_sessions s
  where s.id = p_session_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  -- Re-checked after the lock wait: the caller may have been removed or demoted meanwhile.
  if not public.is_organizer(v_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;

  if v_session.status in ('cancelled', 'completed') then
    raise exception using errcode = 'P0001', message = 'session_not_editable';
  end if;

  select c.timezone into v_timezone from public.communities c where c.id = v_community_id;
  v_in := private.parse_event_input(
    p_input, v_timezone, array[v_timezone, v_session.timezone], v_session);

  -- "Open" = still collecting RSVPs. A training whose deadline has passed is only waiting for the
  -- finalizer (or decided); it is treated like a confirmed one so that the pending decision
  -- cannot be escaped by moving the deadline or changing the limits. Other kinds are open while
  -- confirmed and before their deadline.
  v_open := clock_timestamp() < v_session.rsvp_deadline
            and v_session.status = case when v_session.event_kind = 'training'
                                        then 'scheduled' else 'confirmed' end::public.session_status;

  if v_open then
    v_in.rsvp_deadline := coalesce(v_in.rsvp_deadline, v_in.starts_at - interval '2 hours');
    if v_in.starts_at <= clock_timestamp() then
      perform private.fail_validation('starts_at');
    end if;
    if v_in.rsvp_deadline <= clock_timestamp() or v_in.rsvp_deadline >= v_in.starts_at then
      perform private.fail_validation('rsvp_deadline');
    end if;
    if v_in.max_participants is not null and v_in.max_participants < v_session.going_count then
      perform private.fail_validation('max_participants');
    end if;
  else
    -- Attendance time freeze. No lock on attendance_records is needed: every writer of them
    -- holds this session's row lock, which this transaction holds now.
    if v_session.status = 'confirmed'
       and (
         private.session_ended(v_session.starts_at, v_session.ends_at, clock_timestamp())
         or exists (
           select 1
           from public.attendance_records a
           where a.session_id = p_session_id
         )
       ) then
      if date_trunc('milliseconds', v_in.starts_at)
           is distinct from date_trunc('milliseconds', v_session.starts_at) then
        perform private.fail_validation('starts_at');
      end if;
      if date_trunc('milliseconds', v_in.ends_at)
           is distinct from date_trunc('milliseconds', v_session.ends_at) then
        perform private.fail_validation('ends_at');
      end if;
      -- Keep the stored values (full precision).
      v_in.starts_at := v_session.starts_at;
      v_in.ends_at := v_session.ends_at;
    end if;

    -- Compared as instants at millisecond precision: clients hold timestamps as JavaScript
    -- dates, which cannot carry the microseconds a stored value may have. The stored value
    -- is kept either way.
    if v_in.rsvp_deadline is not null
       and date_trunc('milliseconds', v_in.rsvp_deadline)
           is distinct from date_trunc('milliseconds', v_session.rsvp_deadline) then
      perform private.fail_validation('rsvp_deadline');
    end if;
    v_in.rsvp_deadline := v_session.rsvp_deadline;
    if v_session.event_kind = 'training' then
      if v_in.min_participants is distinct from v_session.min_participants then
        perform private.fail_validation('min_participants');
      end if;
      if v_in.max_participants is distinct from v_session.max_participants then
        perform private.fail_validation('max_participants');
      end if;
    elsif v_in.max_participants is not null and v_in.max_participants < v_session.going_count then
      perform private.fail_validation('max_participants');
    end if;
    -- The start may move, but only to a future time (and never to or before the frozen
    -- deadline).
    if date_trunc('milliseconds', v_in.starts_at)
         is distinct from date_trunc('milliseconds', v_session.starts_at)
       and (v_in.starts_at <= clock_timestamp() or v_in.starts_at <= v_session.rsvp_deadline) then
      perform private.fail_validation('starts_at');
    end if;
  end if;

  update public.training_sessions
  set title = v_in.title,
      description = v_in.description,
      activity_type = v_in.activity_type,
      event_subtype = v_in.event_subtype,
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
      distance_km = v_in.distance_km,
      elevation_gain_m = v_in.elevation_gain_m,
      obstacle_count = v_in.obstacle_count,
      event_notes = v_in.event_notes,
      updated_at = now()
  where id = p_session_id
  returning * into v_session;

  return v_session;
end;
$$;

-- set_rsvp --------------------------------------------------------------------------------------
-- As 20261114000400_trainings_rpcs.sql (locks, order, errors unchanged). Open for RSVPs:
-- a `scheduled` training, or a `confirmed` event of another kind, before the deadline. A training
-- confirmed by the finalizer keeps refusing changes (rsvp_closed), as before.

create or replace function public.set_rsvp(p_session_id uuid, p_response public.rsvp_response)
returns jsonb
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

  -- Lock order profile -> membership -> session (see 20261114000400_trainings_rpcs.sql).
  perform 1 from public.profiles p where p.id = v_uid for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;

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
  if not (
       v_session.status = 'scheduled'
       or (v_session.status = 'confirmed' and v_session.event_kind <> 'training')
     )
     or clock_timestamp() >= v_session.rsvp_deadline then
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

-- finalize_due_sessions -------------------------------------------------------------------------
-- As 20261114000400_trainings_rpcs.sql, restricted to trainings (the only kind with a minimum).
-- Other kinds are never `scheduled` (table check), so this is a second guard.

create or replace function public.finalize_due_sessions() returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with due as (
    select s.id
    from public.training_sessions s
    where s.status = 'scheduled'
      and s.event_kind = 'training'
      and s.min_participants is not null
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

-- Releasing a removed member's RSVPs ------------------------------------------------------------
-- As 20261114000400_trainings_rpcs.sql; "still open" now also covers a confirmed event of another
-- kind before its deadline (it still takes RSVPs, so a removed member must not hold a place).

create or replace function private.release_rsvps_of_removed_member() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_community_id uuid;
  v_user_id uuid;
  v_session_id uuid;
begin
  if tg_op = 'DELETE' then
    v_community_id := old.community_id;
    v_user_id := old.user_id;
  else
    v_community_id := new.community_id;
    v_user_id := new.user_id;
  end if;

  for v_session_id in
    select s.id
    from public.training_sessions s
    where s.community_id = v_community_id
      and (s.status = 'scheduled' or (s.status = 'confirmed' and s.event_kind <> 'training'))
      and s.rsvp_deadline > clock_timestamp()
    order by s.id
    for update
  loop
    update public.training_rsvps
    set response = 'no_response',
        responded_at = now(),
        updated_at = now()
    where session_id = v_session_id
      and user_id = v_user_id
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

-- Notification triggers -------------------------------------------------------------------------
-- As 20261115000400_notifications_rpcs.sql (recipients, dedupe keys, deep links, expiry
-- unchanged); texts name the kind:
--   created    'New training: X' | 'New race: X' | 'New sports event: X' | 'New social event: X'
--   updated    '<Kind> updated: X'      cancelled  '<Kind> cancelled: X'
--   confirmed  'Training confirmed: X', only for trainings (the finalizer's decision). An event
--              created already confirmed fires only the AFTER INSERT (created) trigger.

create or replace function private.notify_training_created() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enqueue_notification(
    private.training_recipients(new.community_id, new.id, new.organizer_id, false, null),
    new.community_id,
    'training_created',
    'New ' || private.event_kind_label(new.event_kind) || ': ' || new.title,
    private.training_when(new.starts_at, new.timezone) || ' · ' || new.location_name,
    '/trainings/' || new.id,
    new.id,
    null,
    'training_created:' || new.id,
    private.push_expiry(coalesce(new.ends_at, new.starts_at + interval '2 hours'))
  );
  return null;
end;
$$;

create or replace function private.notify_training_changed() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The acting user; null for the finalizer (pg_cron / service_role).
  v_actor uuid := auth.uid();
  v_link text := '/trainings/' || new.id;
  v_when text := private.training_when(new.starts_at, new.timezone);
  v_expires timestamptz :=
    private.push_expiry(coalesce(new.ends_at, new.starts_at + interval '2 hours'));
  v_kind text := private.event_kind_title(new.event_kind);
  v_time_changed boolean;
  v_place_changed boolean;
  v_title_changed boolean;
begin
  if new.status is distinct from old.status then
    if new.status = 'confirmed' and new.event_kind = 'training' then
      perform private.enqueue_notification(
        private.training_recipients(new.community_id, new.id, null, true, new.organizer_id),
        new.community_id,
        'training_confirmed',
        'Training confirmed: ' || new.title,
        v_when || ' · ' || new.location_name || '. See you there!',
        v_link, new.id, null,
        'training_confirmed:' || new.id,
        v_expires
      );
    elsif new.status = 'cancelled' then
      perform private.enqueue_notification(
        private.training_recipients(new.community_id, new.id, v_actor, false, null),
        new.community_id,
        'training_cancelled',
        v_kind || ' cancelled: ' || new.title,
        v_when || ' · ' || new.location_name || ' - '
          || case
               when new.cancel_reason = 'insufficient_participation'
                 then 'not enough participants.'
               else 'cancelled by the organizer.'
             end,
        v_link, new.id, null,
        'training_cancelled:' || new.id,
        v_expires
      );
    end if;
    return null;
  end if;

  if new.status not in ('scheduled', 'confirmed') then
    return null;
  end if;

  -- Instants compared at millisecond precision, as update_training does.
  v_time_changed :=
    date_trunc('milliseconds', new.starts_at) is distinct from date_trunc('milliseconds', old.starts_at)
    or date_trunc('milliseconds', new.ends_at) is distinct from date_trunc('milliseconds', old.ends_at);
  v_place_changed :=
    (new.location_name, new.address, new.latitude, new.longitude)
      is distinct from (old.location_name, old.address, old.latitude, old.longitude);
  v_title_changed := new.title is distinct from old.title;

  if v_time_changed or v_place_changed or v_title_changed then
    perform private.enqueue_notification(
      private.training_recipients(new.community_id, new.id, v_actor, false, null),
      new.community_id,
      'training_updated',
      v_kind || ' updated: ' || new.title,
      concat_ws(' ',
        case when v_time_changed then 'New time.' end,
        case when v_place_changed then 'New location.' end,
        case when v_title_changed then 'New title.' end,
        v_when || ' · ' || new.location_name),
      v_link, new.id, null,
      'training_updated:' || new.id || ':' || (extract(epoch from now()) * 1000000)::bigint,
      v_expires
    );
  end if;
  return null;
end;
$$;

-- Statistics: event_kind in history items and top sessions (additive) ----------------------------
-- Copies of 20261117000100_statistics.sql with event_kind (and, in the history, event_subtype)
-- added to each item. The session set S is unchanged: completed events of every kind count.

create or replace function private.stats_history_payload(
  p_community_id uuid,
  p_user_id uuid,
  p_window text,
  p_limit integer,
  p_before timestamptz,
  p_now timestamptz
) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_from timestamptz := private.stats_window_start(p_window, p_now);
  v_count integer;
  v_min timestamptz;
  v_max timestamptz;
  v_low timestamptz;
  v_low_inclusive boolean := false;
  v_items jsonb;
  v_next timestamptz;
  v_more boolean := false;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using errcode = 'P0001', message = 'validation_failed:limit';
  end if;

  select count(*)::integer, min(c.starts_at), max(c.starts_at)
  into v_count, v_min, v_max
  from (
    select r.starts_at
    from private.stats_rows(p_community_id, v_from, p_now, p_user_id) r
    where r.eligible
      and (p_before is null or r.starts_at < p_before)
    order by r.starts_at desc
    limit p_limit + 1
  ) c;

  if v_count > p_limit then
    v_low := v_min;
    -- Every candidate shares one start: return that whole group.
    v_low_inclusive := v_min = v_max;
  end if;

  with page as (
    select r.*
    from private.stats_rows(p_community_id, v_from, p_now, p_user_id) r
    where r.eligible
      and (p_before is null or r.starts_at < p_before)
      and (v_low is null or r.starts_at > v_low or (v_low_inclusive and r.starts_at = v_low))
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'session_id', s.id,
          'title', s.title,
          'activity_type', s.activity_type,
          'event_kind', s.event_kind,
          'event_subtype', s.event_subtype,
          'starts_at', s.starts_at,
          'ends_at', s.ends_at,
          'timezone', s.timezone,
          'location_name', s.location_name,
          'rsvp_response', page.rsvp,
          'outcome', page.attendance,
          'is_walk_in', page.is_walk_in
        )
        order by s.starts_at desc, s.id desc
      ),
      '[]'::jsonb
    ),
    min(s.starts_at)
  into v_items, v_next
  from page
  join public.training_sessions s on s.id = page.session_id;

  if v_count > p_limit then
    v_more := exists (
      select 1
      from private.stats_rows(p_community_id, v_from, p_now, p_user_id) r
      where r.eligible
        and r.starts_at < v_next
    );
  end if;

  return jsonb_build_object(
    'window', p_window,
    'from', v_from,
    'to', p_now,
    'generated_at', now(),
    'items', v_items,
    'has_more', v_more,
    'next_before', case when v_more then v_next end
  );
end;
$$;

create or replace function private.stats_community_payload(
  p_community_id uuid,
  p_window text,
  p_now timestamptz
) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_from timestamptz := private.stats_window_start(p_window, p_now);
  v_unit text := case when p_window in ('7d', '30d') then 'week' else 'month' end;
  v_timezone text;
  v_active integer;
  v_cancelled_min integer;
  v_cancelled_org integer;
  v_result jsonb;
begin
  select c.timezone into v_timezone from public.communities c where c.id = p_community_id;

  select count(*)::integer into v_active
  from public.memberships m
  where m.community_id = p_community_id
    and m.status = 'active';

  -- The only numbers that look at cancelled sessions.
  select
    count(*) filter (where s.cancel_reason = 'insufficient_participation')::integer,
    count(*) filter (where s.cancel_reason = 'organizer')::integer
  into v_cancelled_min, v_cancelled_org
  from public.training_sessions s
  where s.community_id = p_community_id
    and s.status = 'cancelled'
    and (v_from is null or s.starts_at >= v_from)
    and s.starts_at <= p_now;

  with r as (
    select x.* from private.stats_rows(p_community_id, v_from, p_now, null) x
  ),
  per_session as (
    select s.id, s.title, s.starts_at, s.timezone, s.min_participants, s.going_count, s.event_kind,
           coalesce(a.present, 0) as present,
           coalesce(a.marked, 0) as marked
    from private.stats_sessions(p_community_id, v_from, p_now) s
    left join (
      select r.session_id,
             count(*) filter (where r.attendance = 'present')::integer as present,
             count(*) filter (where r.attendance in ('present', 'absent'))::integer as marked
      from r
      group by r.session_id
    ) a on a.session_id = s.id
  ),
  t as (
    select
      count(*)::integer as completed,
      coalesce(sum(ps.present), 0)::integer as total_present,
      coalesce(sum(ps.present) filter (where ps.marked > 0), 0)::integer as counted_present,
      count(*) filter (where ps.marked > 0)::integer as counted,
      count(*) filter (where ps.marked = 0)::integer as incomplete,
      coalesce(sum(ps.going_count), 0)::integer as going_total,
      min(ps.starts_at) as first_start
    from per_session ps
  ),
  conv as (
    select
      count(*) filter (where r.rsvp = 'going' and r.attendance = 'present')::integer
        as going_present,
      count(*) filter (where r.rsvp = 'going' and r.attendance in ('present', 'absent'))::integer
        as going_recorded,
      count(distinct r.user_id) filter (
        where r.eligible and r.membership_status = 'active' and r.attendance = 'present'
      )::integer as members_attended
    from r
  ),
  trend as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'period', b.period,
          'from', b.period_from,
          'to', b.period_to,
          'sessions', b.sessions,
          'present', b.present,
          'incomplete_sessions', b.sessions - b.counted,
          'average_attendees', private.stats_average(b.counted_present, b.counted)
        )
        order by b.period_from
      ),
      '[]'::jsonb
    ) as list
    from (
      select k.period, k.period_from, k.period_to,
             count(ps.id)::integer as sessions,
             coalesce(sum(ps.present), 0)::integer as present,
             count(ps.id) filter (where ps.marked > 0)::integer as counted,
             coalesce(sum(ps.present) filter (where ps.marked > 0), 0)::integer as counted_present
      from t
      cross join lateral private.stats_buckets(
        v_timezone, v_unit, coalesce(v_from, t.first_start), p_now
      ) k
      left join per_session ps
        on ps.starts_at >= k.period_from
       and ps.starts_at < k.period_to
      group by k.period, k.period_from, k.period_to
    ) b
  ),
  top as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'session_id', x.id,
          'title', x.title,
          'starts_at', x.starts_at,
          'timezone', x.timezone,
          'present', x.present,
          'min_participants', x.min_participants,
          'going_count', x.going_count,
          'event_kind', x.event_kind
        )
        order by x.present desc, x.starts_at desc, x.id desc
      ),
      '[]'::jsonb
    ) as list
    from (
      select ps.*
      from per_session ps
      order by ps.present desc, ps.starts_at desc, ps.id desc
      limit 5
    ) x
  )
  select jsonb_build_object(
    'window', p_window,
    'from', v_from,
    'to', p_now,
    'generated_at', now(),
    'timezone', v_timezone,
    'community_id', p_community_id,
    'completed_trainings', t.completed,
    'total_attendances', t.total_present,
    'average_attendees', private.stats_average(t.counted_present, t.counted),
    'average_attendees_sessions', t.counted,
    'incomplete_sessions', t.incomplete,
    'rsvp_going_total', t.going_total,
    'average_rsvp_participation', private.stats_average(t.going_total, t.completed),
    'rsvp_going_present', conv.going_present,
    'rsvp_going_recorded', conv.going_recorded,
    'rsvp_conversion', private.stats_rate(conv.going_present, conv.going_recorded),
    'active_members', v_active,
    'members_attended', conv.members_attended,
    'cancelled_insufficient_participation', v_cancelled_min,
    'cancelled_by_organizer', v_cancelled_org,
    'trend_unit', v_unit,
    'trend', trend.list,
    'top_sessions', top.list
  ) into v_result
  from t, conv, trend, top;

  return v_result;
end;
$$;

-- Grants ----------------------------------------------------------------------------------------
-- Private helpers: no API role. Replaced public functions: restated, privilege matrix unchanged.

revoke all on function private.sync_event_subtype()
  from public, anon, authenticated, service_role;
revoke all on function private.event_kind_label(public.event_kind)
  from public, anon, authenticated, service_role;
revoke all on function private.event_kind_title(public.event_kind)
  from public, anon, authenticated, service_role;
revoke all on function private.parse_event_input(jsonb, text, text[], public.training_sessions)
  from public, anon, authenticated, service_role;
revoke all on function private.release_rsvps_of_removed_member()
  from public, anon, authenticated, service_role;
revoke all on function private.notify_training_created()
  from public, anon, authenticated, service_role;
revoke all on function private.notify_training_changed()
  from public, anon, authenticated, service_role;
revoke all on function private.stats_history_payload(uuid, uuid, text, integer, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.stats_community_payload(uuid, text, timestamptz)
  from public, anon, authenticated, service_role;

revoke all on function public.create_training(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.update_training(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.set_rsvp(uuid, public.rsvp_response)
  from public, anon, authenticated, service_role;
revoke all on function public.finalize_due_sessions()
  from public, anon, authenticated, service_role;

grant execute on function public.create_training(uuid, jsonb) to authenticated;
grant execute on function public.update_training(uuid, jsonb) to authenticated;
grant execute on function public.set_rsvp(uuid, public.rsvp_response) to authenticated;
grant execute on function public.finalize_due_sessions() to service_role;
