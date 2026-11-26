-- TrainHive: personal records (best efforts). Contract: docs/API_CONTRACT.md ("Personal records");
-- definitions: docs/STATS_DEFINITIONS.md ("Personal records"). Builds on the P5 workout logs
-- (20261201000100_workout_logs.sql); every earlier migration is frozen, the functions replaced
-- below (save_workout_log, export_my_data) are copies of their latest versions with the additions
-- described here (one function per name).
--
-- Owner request: "keep a record of the member's best efforts".
--
-- RUNNING (computed live from the member's own running and race logs, nothing stored):
--   best 5 km, 10 km, half marathon (21 097.5 m), marathon (42 195 m) and the longest distance.
--   A log counts for distance D when floor(D) <= distance_m <= D x 1.05 (logged distances are
--   whole metres, so the half marathon is reached at 21 097 m) and it has a duration; its counted
--   time is duration_s x D / distance_m, rounded to the second (half away from zero): the logged
--   time scaled to exactly D at the log's average pace. A log under D never counts (no
--   extrapolation). Best = the shortest counted time; ties -> the earliest event start, then the
--   smallest session id. Longest = the largest distance_m (a duration is not needed); ties as above.
--
-- STRENGTH (needs the member's confirmation):
--   lifts: deadlift, bench_press, back_squat, front_squat, strict_press, push_press.
--   Exercise names are free text: private.normalize_lift_name maps a name to a lift key or null.
--   A set QUALIFIES when its exercise name maps to a lift, reps is 1, 2 or 3 and weight_kg > 0.
--   After saving a log the app asks whether a qualifying set was a maximal effort; only confirmed
--   sets become records. private.lift_max_efforts holds one confirmation per
--   (member, event, lift, reps), with the confirmed weight.
--   Record per lift x reps = the highest confirmed weight; ties -> the earliest event start, then
--   the earliest confirmation, then the smallest session id.
--
-- Records are PRIVATE to the member: no organizer access, no community aggregate, no function takes
-- another member's id.
--
-- Consistency (a confirmation always matches a set of the member's current log of that event):
--   * private.lift_max_efforts (user_id, session_id) references private.workout_logs
--     (user_id, session_id) ON DELETE CASCADE, so every path that deletes a log deletes its
--     confirmations in the same statement: delete_my_workout_log, withdraw_consent('workout_logs'),
--     private.erase_user (explicit log delete, and the profile cascade). Those functions are
--     therefore NOT replaced here. (Deleting a community or event never deletes logs, so it never
--     deletes confirmations either; a log and its records outlive their event.)
--   * save_workout_log (replaced) replaces the whole log; afterwards it deletes the confirmations
--     of that event whose (lift, reps, weight_kg) no longer exists as a qualifying set of the new
--     log (also all of them when the log is no longer a strength log).
--   * confirm_max_effort takes the per-user consent lock (as save_workout_log does), then locks the
--     log row FOR SHARE, so a concurrent save, delete or withdrawal is either finished before it
--     reads the log or waits for it.
--
-- GDPR: confirmations are workout-log data (same consent purpose 'workout_logs'; confirming
-- requires a current consent like saving a log). export_my_data gains extensions.personal_records
-- { lift_max_efforts: [ confirmations ], running: <running bests> } and
-- truncated.lift_max_efforts, plus one README sentence.
--
-- Lock order: confirm: consent lock (advisory, per user) -> log row (share) -> confirmation.
-- save: unchanged (consent lock -> profile -> event -> log), then the confirmations of that log.

-- Table ---------------------------------------------------------------------------------------------

create table private.lift_max_efforts (
  user_id uuid not null,
  session_id uuid not null,
  lift text not null check (lift in ('deadlift', 'bench_press', 'back_squat', 'front_squat',
                                     'strict_press', 'push_press')),
  reps integer not null check (reps between 1 and 3),
  weight_kg numeric(6, 2) not null check (weight_kg > 0 and weight_kg <= 1000),
  confirmed_at timestamptz not null default now(),
  primary key (user_id, session_id, lift, reps),
  constraint lift_max_efforts_log_fkey foreign key (user_id, session_id)
    references private.workout_logs (user_id, session_id) on delete cascade
);

revoke all on table private.lift_max_efforts from public, anon, authenticated, service_role;

-- Helpers -------------------------------------------------------------------------------------------

-- The lift keys, in display order.
create function private.lift_keys() returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['deadlift', 'bench_press', 'back_squat', 'front_squat', 'strict_press', 'push_press'];
$$;

-- The display label of a lift key (null for anything else).
create function private.lift_label(p_lift text) returns text
language sql
immutable
set search_path = ''
as $$
  select case p_lift
    when 'deadlift' then 'Deadlift'
    when 'bench_press' then 'Bench press'
    when 'back_squat' then 'Back squat'
    when 'front_squat' then 'Front squat'
    when 'strict_press' then 'Strict press'
    when 'push_press' then 'Push press'
  end;
$$;

-- A free-text exercise name -> a lift key, or null. Lowercase; every run of whitespace, hyphens,
-- underscores and slashes becomes one space; every other character that is not a-z or 0-9 is
-- removed (so "O.H.P." is "ohp" and "Bench-press" is "bench press"); trimmed. The canonical names
-- the app saves from its exercise list (owner decision 2026-11-26: 'Deadlift', 'Bench press',
-- 'Back squat', 'Front squat', 'Strict press', 'Push press', any case) map first; the synonyms
-- serve older and free-text ('Other') logs. Names are not validated against the list. Exact matches:
--   deadlift      'deadlift', 'dl', 'conventional deadlift'
--   bench_press   'bench', 'bench press', 'bp', 'flat bench'
--   back_squat    'squat', 'back squat', 'bs', 'high bar squat', 'low bar squat'
--   front_squat   'front squat', 'fs'
--   strict_press  'strict press', 'press', 'overhead press', 'ohp', 'military press', 'shoulder press'
--   push_press    'push press', 'pp'
-- Anything else (plurals, other languages, variations such as "sumo deadlift") -> null.
create function private.normalize_lift_name(p_name text) returns text
language sql
immutable
set search_path = ''
as $$
  select case btrim(regexp_replace(
                 regexp_replace(
                   regexp_replace(lower(p_name), '[[:space:]_/-]+', ' ', 'g'),
                   '[^a-z0-9 ]', '', 'g'),
                 ' +', ' ', 'g'))
    when 'deadlift' then 'deadlift'
    when 'dl' then 'deadlift'
    when 'conventional deadlift' then 'deadlift'
    when 'bench' then 'bench_press'
    when 'bench press' then 'bench_press'
    when 'bp' then 'bench_press'
    when 'flat bench' then 'bench_press'
    when 'squat' then 'back_squat'
    when 'back squat' then 'back_squat'
    when 'bs' then 'back_squat'
    when 'high bar squat' then 'back_squat'
    when 'low bar squat' then 'back_squat'
    when 'front squat' then 'front_squat'
    when 'fs' then 'front_squat'
    when 'strict press' then 'strict_press'
    when 'press' then 'strict_press'
    when 'overhead press' then 'strict_press'
    when 'ohp' then 'strict_press'
    when 'military press' then 'strict_press'
    when 'shoulder press' then 'strict_press'
    when 'push press' then 'push_press'
    when 'pp' then 'push_press'
  end;
$$;

-- The qualifying sets of a log's exercises (stored, normalized shape): one row per set whose name
-- maps to a lift, with reps 1..3 and weight_kg > 0. Null / non-array -> no rows.
create function private.lift_sets(p_exercises jsonb)
returns table (lift text, reps integer, weight_kg numeric)
language sql
immutable
set search_path = ''
as $$
  select x.lift, x.reps, x.weight_kg
  from (
    select private.normalize_lift_name(e.value ->> 'name') as lift,
           (s.value ->> 'reps')::integer as reps,
           coalesce((s.value ->> 'weight_kg')::numeric, 0) as weight_kg
    from jsonb_array_elements(case when jsonb_typeof(p_exercises) = 'array' then p_exercises
                                   else '[]'::jsonb end) e
    cross join lateral jsonb_array_elements(case when jsonb_typeof(e.value -> 'sets') = 'array'
                                                 then e.value -> 'sets' else '[]'::jsonb end) s
  ) x
  where x.lift is not null
    and x.reps between 1 and 3
    and x.weight_kg > 0;
$$;

-- Would a confirmation of (p_lift, p_reps, p_weight_kg) on p_session_id, of an event that started
-- at p_starts_at, confirmed at p_confirmed_at, be the member's record for that lift x reps? True
-- unless another event's confirmation ranks before it (higher weight; equal weight and earlier
-- event start; then earlier confirmation; then smaller session id).
create function private.lift_is_record(
  p_user_id uuid,
  p_session_id uuid,
  p_lift text,
  p_reps integer,
  p_weight_kg numeric,
  p_starts_at timestamptz,
  p_confirmed_at timestamptz
) returns boolean
language sql
stable
set search_path = ''
as $$
  select not exists (
    select 1
    from private.lift_max_efforts e
    join private.workout_logs l on l.user_id = e.user_id and l.session_id = e.session_id
    where e.user_id = p_user_id
      and e.lift = p_lift
      and e.reps = p_reps
      and e.session_id <> p_session_id
      and (e.weight_kg > p_weight_kg
           or (e.weight_kg = p_weight_kg
               and (l.event_starts_at, e.confirmed_at, e.session_id)
                   < (p_starts_at, p_confirmed_at, p_session_id)))
  );
$$;

-- The best confirmed weight of a lift x reps in the member's OTHER events (null = none).
create function private.lift_previous_best(p_user_id uuid, p_session_id uuid, p_lift text, p_reps integer)
returns numeric
language sql
stable
set search_path = ''
as $$
  select trim_scale(max(e.weight_kg))
  from private.lift_max_efforts e
  where e.user_id = p_user_id
    and e.lift = p_lift
    and e.reps = p_reps
    and e.session_id <> p_session_id;
$$;

-- The member's running bests (see the header), computed from their running and race logs.
-- { best_5k, best_10k, best_half, best_marathon, longest }, each null when no log counts.
--   best_*:  { distance_m (D, the record distance), time_s, pace_s_per_km (round(time_s x 1000 / D)),
--              logged_distance_m, logged_duration_s, session_id, event_title, event_starts_at, log_type }
--   longest: { distance_m, duration_s, pace_s_per_km (the log's, null without a duration),
--              session_id, event_title, event_starts_at, log_type }
create function private.running_bests(p_user_id uuid) returns jsonb
language sql
stable
set search_path = ''
as $$
  with targets (key, d) as (
    values ('best_5k', 5000::numeric), ('best_10k', 10000::numeric),
           ('best_half', 21097.5::numeric), ('best_marathon', 42195::numeric)
  ),
  counted as (
    select t.key, t.d, l.session_id, l.event_title, l.event_starts_at, l.log_type,
           l.distance_m, l.duration_s,
           round(l.duration_s * t.d / l.distance_m)::integer as time_s
    from targets t
    join private.workout_logs l
      on l.user_id = p_user_id
     and l.log_type in ('running', 'race')
     and l.duration_s is not null
     and l.distance_m >= floor(t.d)
     and l.distance_m <= t.d * 1.05
  ),
  best as (
    select distinct on (c.key) c.*
    from counted c
    order by c.key, c.time_s, c.event_starts_at, c.session_id
  ),
  longest as (
    select l.*
    from private.workout_logs l
    where l.user_id = p_user_id
      and l.log_type in ('running', 'race')
      and l.distance_m is not null
    order by l.distance_m desc, l.event_starts_at, l.session_id
    limit 1
  )
  select jsonb_build_object(
           'best_5k', null, 'best_10k', null, 'best_half', null, 'best_marathon', null
         )
         || coalesce((
              select jsonb_object_agg(b.key, jsonb_build_object(
                       'distance_m', trim_scale(b.d),
                       'time_s', b.time_s,
                       'pace_s_per_km', round(b.time_s * 1000.0 / b.d)::integer,
                       'logged_distance_m', b.distance_m,
                       'logged_duration_s', b.duration_s,
                       'session_id', b.session_id,
                       'event_title', b.event_title,
                       'event_starts_at', b.event_starts_at,
                       'log_type', b.log_type))
              from best b), '{}'::jsonb)
         || jsonb_build_object('longest', (
              select jsonb_build_object(
                       'distance_m', x.distance_m,
                       'duration_s', x.duration_s,
                       'pace_s_per_km', x.pace_s_per_km,
                       'session_id', x.session_id,
                       'event_title', x.event_title,
                       'event_starts_at', x.event_starts_at,
                       'log_type', x.log_type)
              from longest x));
$$;

-- The member's lift records: every lift key in display order,
-- [ { lift, label, one_rm, two_rm, three_rm } ], each rm
-- { weight_kg, session_id, event_title, event_starts_at, achieved_at } or null.
-- achieved_at = the event's start as recorded in the log (the day of the effort); confirmed_at is
-- the moment of the confirmation.
create function private.lift_records(p_user_id uuid) returns jsonb
language sql
stable
set search_path = ''
as $$
  with ranked as (
    select e.lift, e.reps, e.weight_kg, e.session_id, e.confirmed_at, l.event_title, l.event_starts_at,
           row_number() over (partition by e.lift, e.reps
                              order by e.weight_kg desc, l.event_starts_at, e.confirmed_at, e.session_id) as rn
    from private.lift_max_efforts e
    join private.workout_logs l on l.user_id = e.user_id and l.session_id = e.session_id
    where e.user_id = p_user_id
  ),
  best as (
    select r.lift, r.reps, jsonb_build_object(
             'weight_kg', trim_scale(r.weight_kg),
             'session_id', r.session_id,
             'event_title', r.event_title,
             'event_starts_at', r.event_starts_at,
             'achieved_at', r.event_starts_at,
             'confirmed_at', r.confirmed_at) as j
    from ranked r
    where r.rn = 1
  )
  select jsonb_agg(jsonb_build_object(
           'lift', k.lift,
           'label', private.lift_label(k.lift),
           'one_rm', (select b.j from best b where b.lift = k.lift and b.reps = 1),
           'two_rm', (select b.j from best b where b.lift = k.lift and b.reps = 2),
           'three_rm', (select b.j from best b where b.lift = k.lift and b.reps = 3))
         order by k.ord)
  from unnest(private.lift_keys()) with ordinality as k(lift, ord);
$$;

-- RPCs ----------------------------------------------------------------------------------------------

-- get_max_effort_candidates: the qualifying sets of the caller's log of an event, best weight per
-- lift x reps, for the "was this a maximal effort?" question after saving.
-- { session_id, log_type, event_title, event_starts_at, has_consent,
--   candidates: [ { lift, label, reps, weight_kg, confirmed, confirmed_weight_kg,
--                   previous_best_kg, is_new_record } ] }
-- Order: lift display order, then reps. A non-strength log has no candidates.
--   confirmed: a confirmation of this lift x reps exists for this event (confirmed_weight_kg = its
--              weight; normally weight_kg, lower when a lighter existing set was confirmed).
--   previous_best_kg: the best confirmed weight of this lift x reps in the caller's OTHER events.
--   is_new_record: confirming weight_kg now would make it the record (also true when the
--              confirmation exists and is the record).
-- Errors: not_authenticated, not_found (no log of the caller for that event; also null).
create function public.get_max_effort_candidates(p_session_id uuid) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_log private.workout_logs;
  v_now timestamptz := clock_timestamp();
  v_candidates jsonb;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;

  select l.* into v_log
  from private.workout_logs l
  where l.user_id = v_uid and l.session_id = p_session_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  with best as (
    select s.lift, s.reps, max(s.weight_kg) as weight_kg
    from private.lift_sets(v_log.exercises) s
    group by s.lift, s.reps
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'lift', b.lift,
           'label', private.lift_label(b.lift),
           'reps', b.reps,
           'weight_kg', trim_scale(b.weight_kg),
           'confirmed', e.lift is not null,
           'confirmed_weight_kg', trim_scale(e.weight_kg),
           'previous_best_kg', private.lift_previous_best(v_uid, p_session_id, b.lift, b.reps),
           'is_new_record', private.lift_is_record(
             v_uid, p_session_id, b.lift, b.reps, b.weight_kg, v_log.event_starts_at,
             case when e.weight_kg = b.weight_kg then e.confirmed_at else v_now end))
         order by array_position(private.lift_keys(), b.lift), b.reps), '[]'::jsonb)
    into v_candidates
  from best b
  left join private.lift_max_efforts e
    on e.user_id = v_uid
   and e.session_id = p_session_id
   and e.lift = b.lift
   and e.reps = b.reps;

  return jsonb_build_object(
    'session_id', p_session_id,
    'log_type', v_log.log_type,
    'event_title', v_log.event_title,
    'event_starts_at', v_log.event_starts_at,
    'has_consent', private.has_consent(v_uid, 'workout_logs'),
    'candidates', v_candidates
  );
end;
$$;

-- confirm_max_effort: p_confirmed true stores (or updates the weight of) the confirmation that the
-- caller's set (p_lift, p_reps, p_weight_kg) in their log of the event was a maximal effort;
-- false removes the confirmation of that lift x reps for the event (whatever its weight; no
-- consent needed, nothing happens when there is none).
-- p_lift: a lift key, or an exercise name that private.normalize_lift_name maps to one.
-- The set must really exist in the caller's current log of that event: an exercise whose name maps
-- to the same lift, with exactly p_reps reps and exactly p_weight_kg kg.
-- Returns { lift, reps, weight_kg, confirmed, is_new_record } (is_new_record false when removing).
-- Errors in order: not_authenticated, validation_failed:lift (null / not recognized),
-- validation_failed:reps (not 1..3), validation_failed:weight_kg (null, <= 0, > 1000),
-- validation_failed:confirmed (null); after the locks: not_found (no log of the caller for that
-- event), consent_required:workout_logs (confirming only), set_not_found (confirming only).
create function public.confirm_max_effort(
  p_session_id uuid,
  p_lift text,
  p_reps integer,
  p_weight_kg numeric,
  p_confirmed boolean
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_lift text;
  v_log private.workout_logs;
  v_row private.lift_max_efforts;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  v_lift := case when p_lift = any (private.lift_keys()) then p_lift
                 else private.normalize_lift_name(p_lift) end;
  if v_lift is null then
    raise exception using errcode = 'P0001', message = 'validation_failed:lift';
  end if;
  if p_reps is null or p_reps not between 1 and 3 then
    raise exception using errcode = 'P0001', message = 'validation_failed:reps';
  end if;
  if p_weight_kg is null or p_weight_kg <= 0 or p_weight_kg > 1000 then
    raise exception using errcode = 'P0001', message = 'validation_failed:weight_kg';
  end if;
  if p_confirmed is null then
    raise exception using errcode = 'P0001', message = 'validation_failed:confirmed';
  end if;

  -- Same lock as save_workout_log and withdraw_consent: no save, withdrawal or erasure interleaves.
  perform private.lock_consents(v_uid);
  select l.* into v_log
  from private.workout_logs l
  where l.user_id = v_uid and l.session_id = p_session_id
  for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  if not p_confirmed then
    delete from private.lift_max_efforts e
    where e.user_id = v_uid
      and e.session_id = p_session_id
      and e.lift = v_lift
      and e.reps = p_reps;
    return jsonb_build_object('lift', v_lift, 'reps', p_reps, 'weight_kg', trim_scale(p_weight_kg),
                              'confirmed', false, 'is_new_record', false);
  end if;

  if not private.has_consent(v_uid, 'workout_logs') then
    raise exception using errcode = 'P0001', message = 'consent_required:workout_logs';
  end if;
  if not exists (
    select 1 from private.lift_sets(v_log.exercises) s
    where s.lift = v_lift and s.reps = p_reps and s.weight_kg = p_weight_kg
  ) then
    raise exception using errcode = 'P0001', message = 'set_not_found';
  end if;

  insert into private.lift_max_efforts as e (user_id, session_id, lift, reps, weight_kg, confirmed_at)
  values (v_uid, p_session_id, v_lift, p_reps, p_weight_kg, clock_timestamp())
  on conflict (user_id, session_id, lift, reps) do update
    set weight_kg = excluded.weight_kg,
        -- Re-confirming the same weight keeps the original moment (tie order stays stable).
        confirmed_at = case when e.weight_kg = excluded.weight_kg then e.confirmed_at
                            else excluded.confirmed_at end
  returning * into v_row;

  return jsonb_build_object(
    'lift', v_row.lift,
    'reps', v_row.reps,
    'weight_kg', trim_scale(v_row.weight_kg),
    'confirmed', true,
    'is_new_record', private.lift_is_record(v_uid, p_session_id, v_row.lift, v_row.reps, v_row.weight_kg,
                                            v_log.event_starts_at, v_row.confirmed_at)
  );
end;
$$;

-- get_my_personal_records: the caller's records. Own data only; no membership or consent needed
-- to read (withdrawing the consent deletes the logs and so the records).
-- { running: { best_5k, best_10k, best_half, best_marathon, longest }  (private.running_bests),
--   lifts: [ { lift, label, one_rm, two_rm, three_rm } ]              (private.lift_records) }
-- Errors: not_authenticated.
create function public.get_my_personal_records() returns jsonb
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
  return jsonb_build_object(
    'running', private.running_bests(v_uid),
    'lifts', private.lift_records(v_uid)
  );
end;
$$;

-- Replaced: save_workout_log ----------------------------------------------------------------------
-- save_workout_log: body identical to 20261201000100_workout_logs.sql (contract unchanged) plus,
-- after the write, the removal of the confirmations of that event whose set no longer exists.

create or replace function public.save_workout_log(p_session_id uuid, p_input jsonb) returns jsonb
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

  -- Personal records: a confirmation must match a qualifying set of the new log, else it goes.
  delete from private.lift_max_efforts e
  where e.user_id = v_uid
    and e.session_id = p_session_id
    and not exists (
      select 1 from private.lift_sets(v_row.exercises) s
      where s.lift = e.lift and s.reps = e.reps and s.weight_kg = e.weight_kg
    );

  return private.workout_log_json(v_row);
end;
$$;

-- Replaced: export_my_data ------------------------------------------------------------------------
-- GDPR: export. Same as 20261204000100_anonymous_comments.sql plus extensions.personal_records
-- { lift_max_efforts: [ { session_id, event_title, event_starts_at, lift, reps, weight_kg,
-- confirmed_at } ] (oldest confirmation first, at most 5000), running: <private.running_bests> },
-- truncated.lift_max_efforts and one README sentence. Nothing of other members.

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
             'kind', ep.kind,
             'is_anonymous', ep.is_anonymous,
             -- The caller's own nickname on that event for an anonymous item, else null.
             'alias', case when ep.is_anonymous then al.alias end,
             'body', ep.body,
             'created_at', ep.created_at,
             'deleted_at', ep.deleted_at
           ) as j,
           row_number() over (order by ep.created_at, ep.id) as n
    from public.event_posts ep
    join public.training_sessions s on s.id = ep.session_id
    join public.communities c on c.id = ep.community_id
    left join private.event_aliases al
      on al.session_id = ep.session_id
     and al.user_id = v_uid
    where ep.author_id = v_uid
       or ep.id in (select a.post_id
                    from private.event_post_anonymous_authors a
                    where a.author_id = v_uid)
    order by ep.created_at, ep.id
    limit c_limit + 1
  ),
  aliases as (
    select jsonb_build_object(
             'session_id', al.session_id,
             'community_id', s.community_id,
             'event_title', s.title,
             'alias', al.alias,
             'created_at', al.created_at
           ) as j,
           row_number() over (order by al.created_at, al.session_id) as n
    from private.event_aliases al
    join public.training_sessions s on s.id = al.session_id
    where al.user_id = v_uid
    order by al.created_at, al.session_id
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
  ),
  max_efforts as (
    select jsonb_build_object(
             'session_id', e.session_id,
             'event_title', wl.event_title,
             'event_starts_at', wl.event_starts_at,
             'lift', e.lift,
             'reps', e.reps,
             'weight_kg', trim_scale(e.weight_kg),
             'confirmed_at', e.confirmed_at
           ) as j,
           row_number() over (order by e.confirmed_at, e.session_id, e.lift, e.reps) as n
    from private.lift_max_efforts e
    join private.workout_logs wl on wl.user_id = e.user_id and wl.session_id = e.session_id
    where e.user_id = v_uid
    order by e.confirmed_at, e.session_id, e.lift, e.reps
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
      || 'including your event posts, comments and replies (a deleted one has no text); '
      || 'is_anonymous marks the ones you posted anonymously (other members never see your name '
      || 'on them; they see your nickname for that event instead, listed in event_aliases). '
      || 'If you delete your account, announcements and organizer event posts stay in '
      || 'the community without your name and your comments and replies are deleted. '
      || 'extensions.about_you: the optional About you details you saved '
      || '(birth year, gender, emergency contact, T-shirt size), null when there are none. '
      || 'extensions.workout_logs: your workout logs (exercises and sets, distance, time, pace, '
      || 'notes) with the event each one belongs to; only you can see them. '
      || 'extensions.personal_records: the lifts you confirmed as maximal efforts (lift, reps, '
      || 'weight, event) and your best running times computed from your logs; only you can see '
      || 'them. '
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
      'event_aliases', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from aliases x),
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
      'personal_records', jsonb_build_object(
        'lift_max_efforts', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from max_efforts x),
        'running', private.running_bests(v_uid)
      ),
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
      'event_aliases', (select count(*) > c_limit from aliases),
      'events_organized', (select count(*) > c_limit from organized),
      'invitation_codes', (select count(*) > c_limit from codes),
      'invitation_attempts', (select count(*) > c_limit from attempts),
      'data_export_requests', (select count(*) > c_limit from exports),
      'workout_logs', (select count(*) > c_limit from workouts),
      'lift_max_efforts', (select count(*) > c_limit from max_efforts)
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

-- Grants -------------------------------------------------------------------------------------------

revoke all on function private.lift_keys() from public, anon, authenticated, service_role;
revoke all on function private.lift_label(text) from public, anon, authenticated, service_role;
revoke all on function private.normalize_lift_name(text) from public, anon, authenticated, service_role;
revoke all on function private.lift_sets(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.lift_is_record(uuid, uuid, text, integer, numeric, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.lift_previous_best(uuid, uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function private.running_bests(uuid) from public, anon, authenticated, service_role;
revoke all on function private.lift_records(uuid) from public, anon, authenticated, service_role;

revoke all on function public.get_max_effort_candidates(uuid) from public, anon, authenticated, service_role;
revoke all on function public.confirm_max_effort(uuid, text, integer, numeric, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.get_my_personal_records() from public, anon, authenticated, service_role;
revoke all on function public.save_workout_log(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.export_my_data() from public, anon, authenticated, service_role;

grant execute on function public.get_max_effort_candidates(uuid) to authenticated;
grant execute on function public.confirm_max_effort(uuid, text, integer, numeric, boolean) to authenticated;
grant execute on function public.get_my_personal_records() to authenticated;
grant execute on function public.save_workout_log(uuid, jsonb) to authenticated;
grant execute on function public.export_my_data() to authenticated;
