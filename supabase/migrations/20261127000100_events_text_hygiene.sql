-- Q8-1: one text hygiene for every free-text field of an event.
-- Before, event_notes went through private.clean_required_text (controls and bidi controls
-- stripped, line breaks normalized, invisible-only rejected) while title, description and
-- meeting_instructions only had whitespace trimmed. They now use the same cleaner. Normal text
-- is unchanged. Only functions are replaced; signatures and the privilege matrix are unchanged.

-- Reads an optional/required string like private.input_text, but cleans it with
-- private.clean_required_text. Blank = null (error when required); invisible-only text and text
-- over the limit (after cleaning) fail with validation_failed:<key>.
create function private.input_clean_text(
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
    if v_text !~ '^\s*$' then
      return private.clean_required_text(v_text, p_key, p_max_length, p_multiline);
    end if;
  end if;
  if p_required then
    perform private.fail_validation(p_key);
  end if;
  return null;
end;
$$;

create or replace function private.parse_event_input(
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

  r.title := private.input_clean_text(p_input, 'title', 80, true, false);
  r.description := private.input_clean_text(p_input, 'description', 2000, false, true);

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

  r.meeting_instructions := private.input_clean_text(p_input, 'meeting_instructions', 1000, false, true);

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

revoke all on function private.input_clean_text(jsonb, text, integer, boolean, boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.parse_event_input(jsonb, text, text[], public.training_sessions)
  from public, anon, authenticated, service_role;
