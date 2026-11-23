-- TrainHive P5: workout logs, the post-event prompt and workout statistics
-- (docs/EVENTS_PLAN.md section 5, docs/GDPR_PLAN.md sections 1-2, docs/STATS_DEFINITIONS.md
-- "Workout statistics (P5)"). Contract: docs/API_CONTRACT.md ("Workout logs (P5)").
--
--   private.workout_logs          one log per (member, event). The table lives in the private
--                                 schema: no API role can read or write it; all access goes through
--                                 the functions below, and only ever to the log's OWNER. Organizers
--                                 never read an individual log.
--   private.workout_prompt_runs   one row per event the prompt job has handled (idempotency).
--
--   save_workout_log(p_session_id, p_input)      create or replace the caller's log of an event
--   get_my_workout_log(p_session_id)             the caller's log + what the log screen needs
--   delete_my_workout_log(p_session_id)          deletes the caller's log of an event
--   list_my_workout_logs(p_limit, p_before)      the caller's logs, newest event first, paged
--   get_my_workout_stats(p_community_id, p_from, p_to)   personal totals
--   get_community_workout_stats(p_community_id, p_window) organizer: rounded community totals,
--                                                       only with >= 20 contributing members and
--                                                       never differenceable with a smaller window
--   enqueue_workout_log_prompts()                service_role / pg_cron every minute
--
-- Log type (derived from the event, never chosen by the client):
--   race kind (any subtype)                                   -> 'race'
--   training / sports_event whose activity type is running,
--     trail_running or ocr                                   -> 'running'
--   training / sports_event whose activity type is strength
--     or functional_fitness (crossfit_event included)        -> 'strength'
--   anything else (social events, activity 'other')          -> not loggable (no prompt either)
--
-- Who can log: an ACTIVE member of the event's community whose RSVP is `going` OR whose
-- attendance is recorded `present` (walk-ins included), on a `confirmed` or `completed` event
-- whose end (ends_at, else starts_at + 2 hours) has passed. Saving needs a current `workout_logs`
-- consent (consent_required:workout_logs). Reading, listing and deleting one's own logs need
-- neither membership nor consent (the data is the member's own).
--
-- Prompt: enqueue_workout_log_prompts() sends, once per event (private.workout_prompt_runs) and
-- once per member (dedupe key workout_log_prompt:<event id>), an in-app notification + push
-- "How did it go?" / "Log your workout: <title>" to the active members whose RSVP is `going` and
-- who have no log of that event yet, for loggable `confirmed` / `completed` events whose end + 15
-- minutes has passed and whose end lies within the last 48 hours (P5-QA-8: no backfill flood on
-- the first run or after an outage; older events are never prompted). Sent regardless of the workout_logs consent (a neutral reminder; owner decision
-- 2026-11-23). Push preference category: training_updates (the else branch of
-- claim_notification_jobs, unchanged); push consent is checked at send time as for every kind.
--
-- Leaving / removal: the member keeps their logs (they are personal); the community totals only
-- count logs of ACTIVE members (checked at read time), so a member who leaves drops out at once.
-- Events are never deleted except with their community (account erasure of the last member);
-- a log therefore keeps a snapshot of the event (title, start, kind, subtype, community) and its
-- session_id has no foreign key, so it survives and can still be read or deleted by session id.
--
-- GDPR: withdraw_consent('workout_logs') deletes all the member's logs (also when no grant is on
-- record, like push tokens and About you); private.erase_user deletes them; export_my_data gains
-- extensions.workout_logs and truncated.workout_logs.
--
-- Lock order (matches account erasure: consent lock -> profile -> ... -> sessions):
--   save:      consent lock (advisory, per user) -> profile (key share) -> event (key share) -> log
--   withdraw:  consent lock -> auth user (key share, through the ledger insert) -> logs
--   delete:    log only

-- Notification kind ------------------------------------------------------------------------------
-- Added values cannot be used in the transaction that adds them; nothing below uses it at
-- creation time (plpgsql bodies are resolved when they run).

alter type public.notification_kind add value if not exists 'workout_log_prompt';

-- Deep link allowlist: + /events/<uuid>/log ---------------------------------------------------------
-- Same pattern as P4 (20261129000100_event_feed.sql): every existing route kept, NOT VALID, then
-- validated.

alter table public.notifications drop constraint notifications_deep_link_check;
alter table public.notifications
  add constraint notifications_deep_link_check
  check (
    deep_link ~ '^/activity$'
    or deep_link ~ '^/trainings/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or deep_link ~ '^/announcements/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or deep_link ~ '^/events/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/feed$'
    or deep_link ~ '^/events/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/log$'
  ) not valid;

do $$
begin
  alter table public.notifications validate constraint notifications_deep_link_check;
exception
  when check_violation then
    raise warning
      'TrainHive: notifications rows with a deep_link outside the allowlist exist; the new '
      'check applies to new rows only.';
end
$$;

-- Tables ------------------------------------------------------------------------------------------

create table private.workout_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- No foreign key: the log outlives its event (see the header). Snapshot below.
  session_id uuid not null,
  community_id uuid not null,
  log_type text not null check (log_type in ('strength', 'running', 'race')),
  event_title text not null,
  event_starts_at timestamptz not null,
  event_kind public.event_kind not null,
  event_subtype text not null,
  distance_m integer check (distance_m between 1 and 1000000),
  duration_s integer check (duration_s between 1 and 604800),
  -- Seconds per kilometre, rounded half away from zero; only when both are known.
  pace_s_per_km integer generated always as (
    case when distance_m is not null and duration_s is not null
         then round(duration_s * 1000.0 / distance_m)::integer end
  ) stored,
  exercises jsonb check (exercises is null or jsonb_typeof(exercises) = 'array'),
  strength_volume_kg numeric(14, 2) check (strength_volume_kg >= 0),
  notes text check (notes is null or char_length(notes) between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workout_logs_user_session_key unique (user_id, session_id),
  constraint workout_logs_shape_check check (
    (log_type = 'strength' and distance_m is null and duration_s is null
     and exercises is not null and strength_volume_kg is not null)
    or (log_type in ('running', 'race') and exercises is null and strength_volume_kg is null)
  )
);

create index workout_logs_user_starts_idx on private.workout_logs (user_id, event_starts_at desc, id desc);
create index workout_logs_community_starts_idx on private.workout_logs (community_id, event_starts_at);
create index workout_logs_session_idx on private.workout_logs (session_id);

revoke all on table private.workout_logs from public, anon, authenticated, service_role;

create table private.workout_prompt_runs (
  session_id uuid primary key references public.training_sessions (id) on delete cascade,
  sent_at timestamptz not null default now()
);

revoke all on table private.workout_prompt_runs from public, anon, authenticated, service_role;

-- Helpers -----------------------------------------------------------------------------------------

-- The log type of an event (see the header); null = not loggable.
create function private.workout_log_type(p_kind public.event_kind, p_activity_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_kind = 'race' then 'race'
    when p_kind = 'social' then null
    when p_activity_type in ('running', 'trail_running', 'ocr') then 'running'
    when p_activity_type in ('strength', 'functional_fitness') then 'strength'
  end;
$$;

-- An event's end: ends_at, else starts_at + 2 hours (the default used everywhere).
create function private.workout_event_end(p_starts_at timestamptz, p_ends_at timestamptz)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_ends_at, p_starts_at + interval '2 hours');
$$;

-- Why p_user_id cannot log p_session right now (null = they can). In the order the save checks:
-- not_a_member, not_loggable (kind / activity or status), event_not_ended, not_eligible (neither
-- going nor recorded present).
create function private.workout_log_block_reason(p_user_id uuid, p_session public.training_sessions)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when not exists (
      select 1 from public.memberships m
      where m.community_id = p_session.community_id
        and m.user_id = p_user_id
        and m.status = 'active'
    ) then 'not_a_member'
    when private.workout_log_type(p_session.event_kind, p_session.activity_type) is null
         or p_session.status not in ('confirmed', 'completed') then 'not_loggable'
    when clock_timestamp() < private.workout_event_end(p_session.starts_at, p_session.ends_at)
      then 'event_not_ended'
    when not exists (
      select 1 from public.training_rsvps r
      where r.session_id = p_session.id
        and r.user_id = p_user_id
        and r.response = 'going'
    ) and not exists (
      select 1 from public.attendance_records a
      where a.session_id = p_session.id
        and a.user_id = p_user_id
        and a.status = 'present'
    ) then 'not_eligible'
  end;
$$;

-- The caller-facing shape of one log.
create function private.workout_log_json(p_row private.workout_logs) returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_row.id,
    'session_id', p_row.session_id,
    'community_id', p_row.community_id,
    'log_type', p_row.log_type,
    'event_title', p_row.event_title,
    'event_starts_at', p_row.event_starts_at,
    'event_kind', p_row.event_kind,
    'event_subtype', p_row.event_subtype,
    'distance_m', p_row.distance_m,
    'duration_s', p_row.duration_s,
    'pace_s_per_km', p_row.pace_s_per_km,
    'exercises', p_row.exercises,
    'strength_volume_kg', p_row.strength_volume_kg,
    'notes', p_row.notes,
    'created_at', p_row.created_at,
    'updated_at', p_row.updated_at
  );
$$;

-- Validates the exercises of a strength log and returns them normalized, with the volume
-- (sum of reps x weight_kg). Absent / null = no exercises.
--   exercises: array of at most 30 objects { name, sets } (no other key) -> validation_failed:exercises
--   name: string, private.clean_required_text single line, 1..80 -> validation_failed:exercise_name
--   sets: array of 1..20 objects { reps, weight_kg } (no other key) -> validation_failed:sets
--   reps: JSON integer 1..1000 -> validation_failed:reps
--   weight_kg: JSON number 0..1000 in steps of 0.25; absent / null = 0 (bodyweight)
--              -> validation_failed:weight_kg
create function private.parse_workout_exercises(
  p_value jsonb,
  out exercises jsonb,
  out volume_kg numeric
)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_exercise jsonb;
  v_set jsonb;
  v_value jsonb;
  v_name text;
  v_sets jsonb;
  v_reps numeric;
  v_weight numeric;
begin
  exercises := '[]'::jsonb;
  volume_kg := 0;
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    return;
  end if;
  if jsonb_typeof(p_value) <> 'array' or jsonb_array_length(p_value) > 30 then
    perform private.fail_validation('exercises');
  end if;

  for v_exercise in select e.value from jsonb_array_elements(p_value) e loop
    if jsonb_typeof(v_exercise) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_exercise) k where k not in ('name', 'sets')) then
      perform private.fail_validation('exercises');
    end if;

    v_value := v_exercise -> 'name';
    if v_value is null or jsonb_typeof(v_value) <> 'string' then
      perform private.fail_validation('exercise_name');
    end if;
    v_name := private.clean_required_text(v_value #>> '{}', 'exercise_name', 80, false);

    v_value := v_exercise -> 'sets';
    if v_value is null or jsonb_typeof(v_value) <> 'array'
       or jsonb_array_length(v_value) not between 1 and 20 then
      perform private.fail_validation('sets');
    end if;

    v_sets := '[]'::jsonb;
    for v_set in select s.value from jsonb_array_elements(v_value) s loop
      if jsonb_typeof(v_set) <> 'object'
         or exists (select 1 from jsonb_object_keys(v_set) k where k not in ('reps', 'weight_kg')) then
        perform private.fail_validation('sets');
      end if;

      if jsonb_typeof(v_set -> 'reps') is distinct from 'number' then
        perform private.fail_validation('reps');
      end if;
      v_reps := (v_set ->> 'reps')::numeric;
      if v_reps <> trunc(v_reps) or v_reps not between 1 and 1000 then
        perform private.fail_validation('reps');
      end if;

      if v_set -> 'weight_kg' is null or jsonb_typeof(v_set -> 'weight_kg') = 'null' then
        v_weight := 0;
      elsif jsonb_typeof(v_set -> 'weight_kg') <> 'number' then
        perform private.fail_validation('weight_kg');
      else
        v_weight := (v_set ->> 'weight_kg')::numeric;
        if v_weight not between 0 and 1000 or v_weight * 4 <> trunc(v_weight * 4) then
          perform private.fail_validation('weight_kg');
        end if;
      end if;

      v_sets := v_sets || jsonb_build_array(jsonb_build_object(
        'reps', v_reps::integer,
        'weight_kg', trim_scale(v_weight)
      ));
      volume_kg := volume_kg + v_reps * v_weight;
    end loop;

    exercises := exercises || jsonb_build_array(jsonb_build_object('name', v_name, 'sets', v_sets));
  end loop;
end;
$$;

-- RPCs: the member's own logs -----------------------------------------------------------------------

-- save_workout_log: creates or replaces (whole log, not a partial update) the caller's log of an
-- event. p_input by the event's log type (unknown keys refused):
--   strength:        { exercises?: [ { name, sets: [ { reps, weight_kg? } ] } ], notes? }
--                    at least one exercise or a note
--   running:         { distance_m?, duration_s?, notes? }   at least distance_m or duration_s
--   race:            { distance_m?, duration_s, notes? }    duration_s (finish time) required
-- distance_m: JSON integer 1..1 000 000; duration_s: JSON integer 1..604 800 (7 days); notes:
-- private.clean_required_text multiline, at most 1000 characters (blank = no note). Plausibility
-- (P5-QA-7): when both distance_m and duration_s are given, the pace must lie between 1:00 and
-- 30:00 min/km inclusive (60 <= 1000 x duration_s / distance_m <= 1800), else
-- validation_failed:duration_s. Pace is computed by the database. Returns the log
-- (private.workout_log_json).
-- Errors in order: not_authenticated, validation_failed:input (not an object), not_found
-- (unknown / null event), not_a_member, not_loggable, event_not_ended, not_eligible,
-- validation_failed:input (key not allowed for the log type), validation_failed:<field>, then
-- after the locks not_a_member (no profile: account being deleted), consent_required:workout_logs,
-- not_found (event deleted meanwhile).
create function public.save_workout_log(p_session_id uuid, p_input jsonb) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_session public.training_sessions;
  v_reason text;
  v_type text;
  v_allowed text[];
  v_notes text;
  v_distance integer;
  v_duration integer;
  v_exercises jsonb;
  v_volume numeric;
  v_row private.workout_logs;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception using errcode = 'P0001', message = 'validation_failed:input';
  end if;

  select s.* into v_session from public.training_sessions s where s.id = p_session_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  v_reason := private.workout_log_block_reason(v_uid, v_session);
  if v_reason is not null then
    raise exception using errcode = 'P0001', message = v_reason;
  end if;
  v_type := private.workout_log_type(v_session.event_kind, v_session.activity_type);

  -- Validation (before any lock).
  v_allowed := case when v_type = 'strength' then array['exercises', 'notes']
                    else array['distance_m', 'duration_s', 'notes'] end;
  if exists (select 1 from jsonb_object_keys(p_input) k where not (k = any (v_allowed))) then
    raise exception using errcode = 'P0001', message = 'validation_failed:input';
  end if;
  v_notes := private.input_clean_text(p_input, 'notes', 1000, false, true);

  if v_type = 'strength' then
    select x.exercises, x.volume_kg into v_exercises, v_volume
    from private.parse_workout_exercises(p_input -> 'exercises') x;
    if jsonb_array_length(v_exercises) = 0 and v_notes is null then
      perform private.fail_validation('exercises');
    end if;
  else
    v_distance := private.input_integer(p_input, 'distance_m');
    if v_distance is not null and v_distance not between 1 and 1000000 then
      perform private.fail_validation('distance_m');
    end if;
    v_duration := private.input_integer(p_input, 'duration_s');
    if v_duration is not null and v_duration not between 1 and 604800 then
      perform private.fail_validation('duration_s');
    end if;
    if v_type = 'race' and v_duration is null then
      perform private.fail_validation('duration_s');
    end if;
    if v_type = 'running' and v_distance is null and v_duration is null then
      perform private.fail_validation('distance_m');
    end if;
    -- P5-QA-7 plausibility: with both values, the pace must lie in [1:00, 30:00] min/km
    -- (60..1800 s/km, exact, before rounding).
    if v_distance is not null and v_duration is not null
       and (v_duration::bigint * 1000 < 60 * v_distance::bigint
            or v_duration::bigint * 1000 > 1800 * v_distance::bigint) then
      perform private.fail_validation('duration_s');
    end if;
  end if;

  -- A concurrent withdrawal of the consent cannot interleave between the check and the write.
  perform private.lock_consents(v_uid);
  perform 1 from public.profiles p where p.id = v_uid for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;
  if not private.has_consent(v_uid, 'workout_logs') then
    raise exception using errcode = 'P0001', message = 'consent_required:workout_logs';
  end if;
  perform 1 from public.training_sessions s where s.id = p_session_id for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  insert into private.workout_logs as l (
    user_id, session_id, community_id, log_type, event_title, event_starts_at, event_kind,
    event_subtype, distance_m, duration_s, exercises, strength_volume_kg, notes
  ) values (
    v_uid, p_session_id, v_session.community_id, v_type, v_session.title, v_session.starts_at,
    v_session.event_kind, v_session.event_subtype, v_distance, v_duration, v_exercises,
    case when v_type = 'strength' then v_volume end, v_notes
  )
  on conflict (user_id, session_id) do update
    set log_type = excluded.log_type,
        event_title = excluded.event_title,
        event_starts_at = excluded.event_starts_at,
        event_kind = excluded.event_kind,
        event_subtype = excluded.event_subtype,
        distance_m = excluded.distance_m,
        duration_s = excluded.duration_s,
        exercises = excluded.exercises,
        strength_volume_kg = excluded.strength_volume_kg,
        notes = excluded.notes,
        updated_at = now()
  returning * into v_row;

  return private.workout_log_json(v_row);
end;
$$;

-- get_my_workout_log: what the log screen needs for one event.
-- { session_id, community_id, event: { title, starts_at, ends_at, event_kind, event_subtype,
--   distance_km, status } | null, log_type, can_log, cannot_log_reason
--   (null | not_a_member | not_loggable | event_not_ended | not_eligible | not_found),
--   has_consent, log: <log> | null }
-- event is null when the event no longer exists AND when the caller is not an active member of
-- its community (P5-QA-6: a member who left or was removed sees only the snapshot stored in their
-- own log, never later edits of the event); log_type then comes from the log.
-- Errors: not_authenticated, not_found (unknown / null event and no own log), not_a_member (the
-- event exists, the caller is not an active member of its community and has no log of it).
create function public.get_my_workout_log(p_session_id uuid) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_session public.training_sessions;
  v_log private.workout_logs;
  v_reason text;
  v_show_event boolean;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;

  select l.* into v_log
  from private.workout_logs l
  where l.user_id = v_uid and l.session_id = p_session_id;
  select s.* into v_session from public.training_sessions s where s.id = p_session_id;

  if v_session.id is null then
    if v_log.id is null then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    v_reason := 'not_found';
  else
    v_reason := private.workout_log_block_reason(v_uid, v_session);
    if v_reason = 'not_a_member' and v_log.id is null then
      raise exception using errcode = 'P0001', message = 'not_a_member';
    end if;
  end if;
  -- Only an active member sees the current event; everyone else only their log's snapshot.
  v_show_event := v_session.id is not null and v_reason is distinct from 'not_a_member';

  return jsonb_build_object(
    'session_id', p_session_id,
    'community_id', coalesce(v_session.community_id, v_log.community_id),
    'event', case when v_show_event then jsonb_build_object(
      'title', v_session.title,
      'starts_at', v_session.starts_at,
      'ends_at', v_session.ends_at,
      'event_kind', v_session.event_kind,
      'event_subtype', v_session.event_subtype,
      'distance_km', v_session.distance_km,
      'status', v_session.status
    ) end,
    'log_type', case when v_show_event
                     then coalesce(private.workout_log_type(v_session.event_kind, v_session.activity_type),
                                   v_log.log_type)
                     else v_log.log_type end,
    'can_log', v_reason is null,
    'cannot_log_reason', v_reason,
    'has_consent', private.has_consent(v_uid, 'workout_logs'),
    'log', case when v_log.id is not null then private.workout_log_json(v_log) end
  );
end;
$$;

-- delete_my_workout_log: deletes the caller's log of an event (also after leaving the community
-- or when the event no longer exists). { session_id, deleted } (false when there was none).
-- Errors: not_authenticated.
create function public.delete_my_workout_log(p_session_id uuid) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  delete from private.workout_logs l
  where l.user_id = v_uid
    and l.session_id = p_session_id;
  get diagnostics v_count = row_count;
  return jsonb_build_object('session_id', p_session_id, 'deleted', v_count > 0);
end;
$$;

-- list_my_workout_logs: the caller's logs (every community, also ones left), newest event first
-- (event_starts_at desc, id desc). p_before: only logs of events that started strictly before it
-- (null = from the newest). A page holds p_limit logs plus any further logs of an event start
-- equal to the last one's (so a page boundary never splits a tie); next_before is the cursor for
-- the next page, null when there is none.
-- { logs: [ <log> ], next_before }
-- Errors: not_authenticated, validation_failed:limit (not 1..100).
create function public.list_my_workout_logs(p_limit integer default 20, p_before timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_edge timestamptz;
  v_logs jsonb;
  v_more boolean;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = 'P0001', message = 'validation_failed:limit';
  end if;

  -- The start of the p_limit-th log (null when there are fewer).
  select l.event_starts_at into v_edge
  from private.workout_logs l
  where l.user_id = v_uid
    and (p_before is null or l.event_starts_at < p_before)
  order by l.event_starts_at desc, l.id desc
  offset p_limit - 1
  limit 1;

  select coalesce(jsonb_agg(private.workout_log_json(l) order by l.event_starts_at desc, l.id desc),
                  '[]'::jsonb)
    into v_logs
  from private.workout_logs l
  where l.user_id = v_uid
    and (p_before is null or l.event_starts_at < p_before)
    and (v_edge is null or l.event_starts_at >= v_edge);

  v_more := v_edge is not null and exists (
    select 1 from private.workout_logs l
    where l.user_id = v_uid
      and l.event_starts_at < v_edge
  );

  return jsonb_build_object('logs', v_logs, 'next_before', case when v_more then v_edge end);
end;
$$;

-- Statistics ---------------------------------------------------------------------------------------

-- get_my_workout_stats: the caller's totals over their own logs (docs/STATS_DEFINITIONS.md,
-- "Workout statistics (P5)"). p_community_id null = every log (communities left included), else
-- the logs of that community's events. Window on the event's start as recorded in the log:
-- p_from <= event_starts_at <= p_to, either bound optional.
-- { community_id, from, to, sessions_logged, running_sessions, race_sessions, strength_sessions,
--   total_distance_m, total_duration_s, average_pace_s_per_km, pace_sessions,
--   strength_volume_kg, strength_sets }
-- Errors: not_authenticated, validation_failed:range (p_from after p_to).
create function public.get_my_workout_stats(
  p_community_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception using errcode = 'P0001', message = 'validation_failed:range';
  end if;

  with logs as (
    select l.*
    from private.workout_logs l
    where l.user_id = v_uid
      and (p_community_id is null or l.community_id = p_community_id)
      and (p_from is null or l.event_starts_at >= p_from)
      and (p_to is null or l.event_starts_at <= p_to)
  ),
  paced as (
    select coalesce(sum(x.duration_s), 0)::bigint as duration, coalesce(sum(x.distance_m), 0)::bigint as distance,
           count(*)::integer as n
    from logs x
    where x.distance_m is not null and x.duration_s is not null
  )
  select jsonb_build_object(
    'community_id', p_community_id,
    'from', p_from,
    'to', p_to,
    'sessions_logged', (select count(*)::integer from logs),
    'running_sessions', (select count(*)::integer from logs x where x.log_type = 'running'),
    'race_sessions', (select count(*)::integer from logs x where x.log_type = 'race'),
    'strength_sessions', (select count(*)::integer from logs x where x.log_type = 'strength'),
    'total_distance_m', (select coalesce(sum(x.distance_m), 0)::bigint from logs x),
    'total_duration_s', (select coalesce(sum(x.duration_s), 0)::bigint from logs x),
    'average_pace_s_per_km', (
      select case when p.distance > 0 then round(p.duration * 1000.0 / p.distance)::integer end
      from paced p
    ),
    'pace_sessions', (select p.n from paced p),
    'strength_volume_kg', (select coalesce(sum(x.strength_volume_kg), 0) from logs x),
    'strength_sets', (
      select coalesce(sum(jsonb_array_length(e.value -> 'sets')), 0)::integer
      from logs x
      cross join lateral jsonb_array_elements(x.exercises) e
      where x.log_type = 'strength'
    )
  ) into v_result;

  return v_result;
end;
$$;

-- get_community_workout_stats: an active organizer of the community gets APPROXIMATE totals of
-- the workout logs of the community's events whose start lies in the window (p_window '7d', '30d',
-- '90d', 'all', as the attendance statistics: [now - N x 24 h, now]), counting only logs of
-- members who are ACTIVE members now and hold a current workout_logs consent, of events that are
-- not cancelled. Publication rule (docs/API_CONTRACT.md "Workout logs (P5)", fixed after
-- P5-QA-1/2/3; the floor matches the About-you demographics, 20261130000100_about_you.sql):
--   * floor: nothing is shown (insufficient_data, every metric null) unless at least 20 distinct
--     members contributed a log in the window;
--   * per metric: each metric additionally needs at least 20 distinct members contributing to IT
--     (a distance, a duration, both for the pace), else it is null;
--   * nesting (the windows 7d c 30d c 90d c all share their end, so two answers can be subtracted):
--     the windows are evaluated from the smallest up to the requested one; a window (resp. a
--     metric of it) is published only if the members contributing (to that metric) with a log in
--     the BAND between it and the next smaller window in which it was published, i.e. logs of
--     events starting in [from(W), from(P)), number 0 or at least 20. Subtracting any two
--     published answers therefore always covers 0 or >= 20 members (a union of such bands), and
--     a member who also logged in the smaller window is counted in the band too (their older
--     logs cannot be isolated either). The windows are recomputed for every call with the same
--     now(), so the requested window's answer is the one the chain decides;
--   * shown values are rounded: sessions_logged and members_contributing to the nearest 5,
--     distance to the nearest 10 km, time to the nearest 30 minutes, average pace to the nearest
--     10 seconds per km (half away from zero).
-- Known limit (documented in docs/STATS_DEFINITIONS.md): patient differencing over time (two reads
-- of the same window before and after one member's log appears, leaves, or is removed) reveals
-- that member's contribution to within the rounding (10 km, 30 min); an organizer who controls 19
-- accounts that log known values can do the same. The floor and the rounding make single answers
-- non-identifying, not repeated ones.
-- Members never get community totals (forbidden). No per-member breakdown exists.
-- { community_id, window, from, to, min_contributors: 20, insufficient_data, members_contributing,
--   sessions_logged, total_distance_km, total_duration_minutes, average_pace_s_per_km }
-- Errors: not_authenticated, forbidden (not an active organizer; also null / unknown community),
-- validation_failed:window.
create function public.get_community_workout_stats(p_community_id uuid, p_window text default '30d')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_min constant integer := 20;
  c_windows constant text[] := array['7d', '30d', '90d', 'all'];
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_from timestamptz;
  v_target integer;
  v_starts timestamptz[];
  v_bands jsonb;
  v_full jsonb;
  v_w integer;
  -- Index of the last window in which each quantity was published (-1 = none yet).
  v_last_any integer := -1;
  v_last_distance integer := -1;
  v_last_duration integer := -1;
  v_last_pace integer := -1;
  v_any boolean := false;
  v_distance boolean := false;
  v_duration boolean := false;
  v_pace boolean := false;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if p_community_id is null or not public.is_organizer(p_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  v_from := private.stats_window_start(p_window, v_now);
  v_target := array_position(c_windows, p_window) - 1;
  v_starts := array[
    private.stats_window_start('7d', v_now),
    private.stats_window_start('30d', v_now),
    private.stats_window_start('90d', v_now)
  ];

  -- Each log falls in exactly one band: 0 = 7d, 1 = 30d minus 7d, 2 = 90d minus 30d, 3 = older.
  -- For every pair k < w (k = -1 .. 2, w = 0 .. 3) the totals over the bands k+1 .. w: (-1, w) is
  -- window w itself, (k, w) the difference between windows w and k. Keyed 'k:w'.
  with logs as (
    select l.user_id, l.distance_m, l.duration_s,
           case when s.starts_at >= v_starts[1] then 0
                when s.starts_at >= v_starts[2] then 1
                when s.starts_at >= v_starts[3] then 2
                else 3 end as band
    from private.workout_logs l
    join public.training_sessions s on s.id = l.session_id and s.community_id = l.community_id
    join public.memberships m
      on m.community_id = l.community_id
     and m.user_id = l.user_id
     and m.status = 'active'
    where l.community_id = p_community_id
      and s.status <> 'cancelled'
      and s.starts_at <= v_now
      and private.has_consent(l.user_id, 'workout_logs')
  ),
  pairs as (
    select k, w from generate_series(-1, 2) k cross join generate_series(0, 3) w where k < w
  ),
  totals as (
    select p.k, p.w,
           count(distinct x.user_id)::integer as members,
           count(x.user_id)::integer as sessions,
           count(distinct x.user_id) filter (where x.distance_m is not null)::integer as distance_members,
           coalesce(sum(x.distance_m), 0)::bigint as distance,
           count(distinct x.user_id) filter (where x.duration_s is not null)::integer as duration_members,
           coalesce(sum(x.duration_s), 0)::bigint as duration,
           count(distinct x.user_id) filter (where x.distance_m is not null and x.duration_s is not null)::integer
             as pace_members,
           coalesce(sum(x.duration_s) filter (where x.distance_m is not null and x.duration_s is not null), 0)::bigint
             as pace_duration,
           coalesce(sum(x.distance_m) filter (where x.distance_m is not null and x.duration_s is not null), 0)::bigint
             as pace_distance
    from pairs p
    left join logs x on x.band > p.k and x.band <= p.w
    group by p.k, p.w
  )
  select jsonb_object_agg(t.k || ':' || t.w, to_jsonb(t) - 'k' - 'w') into v_bands
  from totals t;

  -- The chain: smallest window first, up to the requested one. A band count is safe when it is
  -- 0 or >= c_min (for k = -1 the band is the window itself, already >= c_min when it matters).
  for v_w in 0 .. v_target loop
    v_full := v_bands -> ('-1:' || v_w);
    v_any := (v_full ->> 'members')::integer >= c_min
             and (v_bands -> (v_last_any || ':' || v_w) ->> 'members')::integer not between 1 and c_min - 1;
    v_distance := v_any
             and (v_full ->> 'distance_members')::integer >= c_min
             and (v_bands -> (v_last_distance || ':' || v_w) ->> 'distance_members')::integer
                 not between 1 and c_min - 1;
    v_duration := v_any
             and (v_full ->> 'duration_members')::integer >= c_min
             and (v_bands -> (v_last_duration || ':' || v_w) ->> 'duration_members')::integer
                 not between 1 and c_min - 1;
    v_pace := v_any
             and (v_full ->> 'pace_members')::integer >= c_min
             and (v_full ->> 'pace_distance')::bigint > 0
             and (v_bands -> (v_last_pace || ':' || v_w) ->> 'pace_members')::integer
                 not between 1 and c_min - 1;
    if v_any then v_last_any := v_w; end if;
    if v_distance then v_last_distance := v_w; end if;
    if v_duration then v_last_duration := v_w; end if;
    if v_pace then v_last_pace := v_w; end if;
  end loop;

  return jsonb_build_object(
    'community_id', p_community_id,
    'window', p_window,
    'from', v_from,
    'to', v_now,
    'min_contributors', c_min,
    'insufficient_data', not v_any,
    'members_contributing',
      case when v_any then (round((v_full ->> 'members')::integer / 5.0) * 5)::integer end,
    'sessions_logged',
      case when v_any then (round((v_full ->> 'sessions')::integer / 5.0) * 5)::integer end,
    'total_distance_km',
      case when v_distance then (round((v_full ->> 'distance')::bigint / 10000.0) * 10)::integer end,
    'total_duration_minutes',
      case when v_duration then (round((v_full ->> 'duration')::bigint / 1800.0) * 30)::integer end,
    'average_pace_s_per_km',
      case when v_pace
           then (round((v_full ->> 'pace_duration')::bigint * 1000.0
                       / (v_full ->> 'pace_distance')::bigint / 10.0) * 10)::integer end
  );
end;
$$;

-- The post-event prompt ------------------------------------------------------------------------------

-- service_role only; scheduled by pg_cron every minute. See the header for the rule. Each event is
-- claimed once in private.workout_prompt_runs (a concurrent run waits on the claim and then skips
-- it); the per-member dedupe key makes a repeat harmless as well. Events locked by an edit right
-- now are skipped and picked up by the next run. Returns the number of notifications inserted.
create function public.enqueue_workout_log_prompts() returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_session record;
  v_total integer := 0;
begin
  for v_session in
    select s.id, s.community_id, s.title
    from public.training_sessions s
    where s.status in ('confirmed', 'completed')
      and s.starts_at <= v_now
      and private.workout_log_type(s.event_kind, s.activity_type) is not null
      and private.workout_event_end(s.starts_at, s.ends_at) + interval '15 minutes' <= v_now
      and private.workout_event_end(s.starts_at, s.ends_at) > v_now - interval '48 hours'
      and not exists (select 1 from private.workout_prompt_runs r where r.session_id = s.id)
    order by s.id
    for no key update of s skip locked
  loop
    insert into private.workout_prompt_runs (session_id, sent_at)
    values (v_session.id, v_now)
    on conflict (session_id) do nothing;
    if not found then
      continue;
    end if;

    v_total := v_total + private.enqueue_notification(
      (select coalesce(array_agg(m.user_id order by m.user_id), '{}')
       from public.memberships m
       join public.training_rsvps r
         on r.session_id = v_session.id
        and r.user_id = m.user_id
        and r.response = 'going'
       where m.community_id = v_session.community_id
         and m.status = 'active'
         and not exists (
           select 1 from private.workout_logs l
           where l.user_id = m.user_id and l.session_id = v_session.id
         )),
      v_session.community_id,
      'workout_log_prompt',
      'How did it go?',
      'Log your workout: ' || v_session.title,
      '/events/' || v_session.id || '/log',
      v_session.id,
      null,
      'workout_log_prompt:' || v_session.id,
      private.push_expiry(now() + interval '1 day')
    );
  end loop;
  return v_total;
end;
$$;

-- Consent withdrawal deletes the data -----------------------------------------------------------------
-- Same as P3 (20261130000100_about_you.sql) except: workout_logs deletes every log of the caller,
-- in both branches, like push_notifications removes the push tokens: also when no grant is on
-- record (nothing is then written to the ledger, changed = false).

create or replace function public.withdraw_consent(p_purpose text) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_latest public.consent_records;
  v_row public.consent_records;
begin
  if v_uid is null or not private.auth_user_exists(v_uid) then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if p_purpose is null or not (p_purpose = any (private.consent_purposes())) then
    raise exception using errcode = 'P0001', message = 'validation_failed:purpose';
  end if;
  if p_purpose in ('terms_privacy', 'age_16') then
    raise exception using errcode = 'P0001', message = 'not_withdrawable';
  end if;

  perform private.lock_consents(v_uid);

  v_latest := private.latest_consent(v_uid, p_purpose);
  if v_latest.id is null or not v_latest.granted then
    if p_purpose in ('push_notifications', 'profile_demographics', 'emergency_contact',
                     'workout_logs') then
      perform 1 from auth.users u where u.id = v_uid for key share;
      if not found then
        -- Deleted while this call waited for the consent lock.
        raise exception using errcode = 'P0001', message = 'not_authenticated';
      end if;
      if p_purpose = 'push_notifications' then
        delete from public.device_push_tokens t where t.user_id = v_uid;
      elsif p_purpose = 'workout_logs' then
        delete from private.workout_logs wl where wl.user_id = v_uid;
      else
        perform private.erase_about_you_purpose(v_uid, p_purpose);
      end if;
    end if;
    return private.consent_event_json(p_purpose, v_latest, false);
  end if;

  -- Ledger row first: its foreign key key-share-locks the auth user, so a concurrent account
  -- deletion is either waited for here (then not_authenticated) or waits for this call, before
  -- this call locks any token, About-you row or workout log.
  insert into public.consent_records (user_id, purpose, document_version, granted, created_at)
  values (v_uid, p_purpose, private.privacy_version(), false, private.next_consent_at(v_uid))
  returning * into v_row;

  if p_purpose = 'push_notifications' then
    delete from public.device_push_tokens t where t.user_id = v_uid;
  elsif p_purpose in ('profile_demographics', 'emergency_contact') then
    perform private.erase_about_you_purpose(v_uid, p_purpose);
  elsif p_purpose = 'workout_logs' then
    delete from private.workout_logs wl where wl.user_id = v_uid;
  end if;

  return private.consent_event_json(p_purpose, v_row, true);
exception
  when foreign_key_violation then
    if private.auth_user_exists(v_uid) then
      raise;
    end if;
    raise exception using errcode = 'P0001', message = 'not_authenticated';
end;
$$;

-- GDPR: export ---------------------------------------------------------------------------------------
-- Same as P3 (20261130000100_about_you.sql) plus extensions.workout_logs (the caller's logs,
-- oldest event first, at most 5000), truncated.workout_logs and one README sentence.

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
      'workout_logs', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from workouts x)
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


-- GDPR: erasure --------------------------------------------------------------------------------------
-- Same as P3 (20261130000100_about_you.sql) plus the workout logs. The summary is unchanged.

create or replace function private.erase_user(p_user_id uuid) returns jsonb
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
  -- the only way the ledger's append-only guard lets rows go.
  delete from public.profiles p where p.id = p_user_id;
  delete from auth.users u where u.id = p_user_id;

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

-- Schedule ----------------------------------------------------------------------------------------
-- Same guarded pattern as 20261115000500_schedule_notifications.sql: no-op without pg_cron (the
-- embedded test database), idempotent (unscheduled first), a warning naming the manual step when
-- pg_cron is listed but unusable.

do $$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron with schema pg_catalog;
      perform cron.unschedule(c.jobid) from cron.job c where c.jobname = 'trainhive_workout_log_prompts';
      perform cron.schedule('trainhive_workout_log_prompts', '* * * * *',
                            'select public.enqueue_workout_log_prompts()');
    exception
      when others then
        raise warning
          'TrainHive: could not schedule the workout log prompt job with pg_cron (%: %). '
          'Post-event "Log your workout" prompts will NOT be sent until this is done manually: '
          'enable the pg_cron extension for the project, then run '
          'select cron.schedule(''trainhive_workout_log_prompts'', ''* * * * *'', '
          '''select public.enqueue_workout_log_prompts()'');',
          sqlstate, sqlerrm;
    end;
  end if;
end
$$;

-- Grants -------------------------------------------------------------------------------------------

revoke all on function private.workout_log_type(public.event_kind, text) from public, anon, authenticated, service_role;
revoke all on function private.workout_event_end(timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.workout_log_block_reason(uuid, public.training_sessions)
  from public, anon, authenticated, service_role;
revoke all on function private.workout_log_json(private.workout_logs) from public, anon, authenticated, service_role;
revoke all on function private.parse_workout_exercises(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.erase_user(uuid) from public, anon, authenticated, service_role;

revoke all on function public.save_workout_log(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.get_my_workout_log(uuid) from public, anon, authenticated, service_role;
revoke all on function public.delete_my_workout_log(uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_my_workout_logs(integer, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.get_my_workout_stats(uuid, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.get_community_workout_stats(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.enqueue_workout_log_prompts() from public, anon, authenticated, service_role;
revoke all on function public.withdraw_consent(text) from public, anon, authenticated, service_role;
revoke all on function public.export_my_data() from public, anon, authenticated, service_role;

grant execute on function public.save_workout_log(uuid, jsonb) to authenticated;
grant execute on function public.get_my_workout_log(uuid) to authenticated;
grant execute on function public.delete_my_workout_log(uuid) to authenticated;
grant execute on function public.list_my_workout_logs(integer, timestamptz) to authenticated;
grant execute on function public.get_my_workout_stats(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.get_community_workout_stats(uuid, text) to authenticated;
grant execute on function public.enqueue_workout_log_prompts() to service_role;
grant execute on function public.withdraw_consent(text) to authenticated;
grant execute on function public.export_my_data() to authenticated;
