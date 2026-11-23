-- TrainHive P3: "About you" (docs/EVENTS_PLAN.md section 3, docs/GDPR_PLAN.md sections 1-2).
-- Contract: docs/API_CONTRACT.md ("About you (P3)").
--
--   private.member_about_you   one row per member: birth year, gender, emergency contact (name,
--                              phone, relationship), T-shirt size. Every field optional. The table
--                              lives in the private schema: no API role can read or write it; all
--                              access goes through the functions below.
--   get_my_about_you()                          the caller's own details (+ consent state, allowed
--                                               birth-year range from the server clock)
--   save_my_about_you(p_input jsonb)            partial update: absent key = unchanged, null =
--                                               clear the field
--   clear_my_about_you()                        deletes everything (consents are NOT withdrawn)
--   get_member_emergency_info(community, user)  organizer of the community, target an ACTIVE
--                                               member: emergency contact + T-shirt size
--   list_community_emergency_info(community)    organizer: every active member with such data
--                                               (cap 500)
--   get_community_demographics(community)       organizer: approximate age-band and gender group
--                                               totals: nothing unless >= 20 members gave a value,
--                                               cells < 5 suppressed (complementary suppression),
--                                               shown cells rounded to a multiple of 5 (P3-QA-1)
--
-- Consent (G1 ledger, private.has_consent):
--   * birth_year / gender need a current `profile_demographics` grant to be SET (not to clear);
--   * emergency contact fields AND the T-shirt size need a current `emergency_contact` grant to be
--     SET (docs/GDPR_PLAN.md groups them: "safety at events, race kits", visible to organizers);
--   * withdraw_consent('profile_demographics') deletes birth_year and gender,
--     withdraw_consent('emergency_contact') deletes the three emergency contact fields and the
--     T-shirt size, in the
--     same transaction, also when no grant is on record (as push tokens since Q7-2). A row left
--     with no field is deleted.
--   * Reads also re-check consent (defence in depth): a field whose consent is not current is
--     never returned to an organizer and never counted.
--
-- Visibility: birth year and gender never leave the database per person except to the member
-- themselves (get_my_about_you, export_my_data). Organizers see emergency contact and T-shirt size
-- of ACTIVE members of a community they actively organize; leaving or being removed ends it at
-- once (checked at read time, no copy is kept). Age and gender reach organizers only as rounded
-- group totals (see get_community_demographics for what that does and does not protect against).
--
-- Consent version (P3-QA-7): record_consent (20261123000100_consents.sql, unchanged) already takes
-- an optional p_document_version for optional purposes and refuses one that is not the privacy
-- version in force (validation_failed:document_version, which the app maps to
-- app_update_required, as for terms_privacy). The app sends the privacy version it shows.
--
-- GDPR: export_my_data gains extensions.about_you; private.erase_user deletes the row (the foreign
-- key to profiles cascades too).
--
-- Lock order (matches account erasure: consent lock -> profile -> ...):
--   save:      consent lock (advisory, per user) -> profile (key share) -> about-you row (update)
--   withdraw:  consent lock -> auth user (key share, through the ledger insert) -> about-you row
--   clear:     about-you row only

-- Table -------------------------------------------------------------------------------------------

create table private.member_about_you (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  -- The allowed range (server year - 100 .. server year - 16) moves with the clock, so it is
  -- checked by save_my_about_you; the table only rules out nonsense.
  birth_year integer check (birth_year between 1800 and 2200),
  gender text check (gender in ('woman', 'man', 'other', 'prefer_not_to_say')),
  emergency_contact_name text check (char_length(emergency_contact_name) between 1 and 80),
  emergency_contact_phone text check (char_length(emergency_contact_phone) between 1 and 30),
  emergency_contact_relationship text check (char_length(emergency_contact_relationship) between 1 and 40),
  tshirt_size text check (tshirt_size in ('XS', 'S', 'M', 'L', 'XL', 'XXL')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- An emergency contact is a name and a phone (relationship optional), or nothing at all.
  constraint member_about_you_emergency_check check (
    (emergency_contact_name is null and emergency_contact_phone is null
     and emergency_contact_relationship is null)
    or (emergency_contact_name is not null and emergency_contact_phone is not null)
  ),
  -- A row with no field is deleted instead of kept.
  constraint member_about_you_not_empty_check check (
    num_nonnulls(birth_year, gender, emergency_contact_name, emergency_contact_phone,
                 emergency_contact_relationship, tshirt_size) > 0
  )
);

revoke all on table private.member_about_you from public, anon, authenticated, service_role;

-- Helpers -----------------------------------------------------------------------------------------

-- The server's current calendar year (UTC). Birth-year limits and ages use it; never the client's.
create function private.about_you_year() returns integer
language sql
stable
set search_path = ''
as $$
  select extract(year from (now() at time zone 'UTC'))::integer;
$$;

-- Deletes the fields a consent purpose covers. A row left with no field is deleted. Call under
-- private.lock_consents(p_user_id).
create function private.erase_about_you_purpose(p_user_id uuid, p_purpose text) returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if p_purpose = 'profile_demographics' then
    delete from private.member_about_you a
    where a.user_id = p_user_id
      and num_nonnulls(a.emergency_contact_name, a.emergency_contact_phone,
                       a.emergency_contact_relationship, a.tshirt_size) = 0;
    update private.member_about_you a
    set birth_year = null, gender = null, updated_at = now()
    where a.user_id = p_user_id
      and (a.birth_year is not null or a.gender is not null);
  elsif p_purpose = 'emergency_contact' then
    delete from private.member_about_you a
    where a.user_id = p_user_id
      and num_nonnulls(a.birth_year, a.gender) = 0;
    update private.member_about_you a
    set emergency_contact_name = null,
        emergency_contact_phone = null,
        emergency_contact_relationship = null,
        tshirt_size = null,
        updated_at = now()
    where a.user_id = p_user_id
      and (a.emergency_contact_name is not null or a.tshirt_size is not null);
  end if;
end;
$$;

-- The caller-facing shape of get_my_about_you / save_my_about_you / clear_my_about_you.
create function private.about_you_self_json(p_user_id uuid) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_row private.member_about_you;
  v_year integer := private.about_you_year();
begin
  select a.* into v_row from private.member_about_you a where a.user_id = p_user_id;
  return jsonb_build_object(
    'has_data', v_row.user_id is not null,
    'birth_year', v_row.birth_year,
    'gender', v_row.gender,
    'emergency_contact_name', v_row.emergency_contact_name,
    'emergency_contact_phone', v_row.emergency_contact_phone,
    'emergency_contact_relationship', v_row.emergency_contact_relationship,
    'tshirt_size', v_row.tshirt_size,
    'updated_at', v_row.updated_at,
    'birth_year_min', v_year - 100,
    'birth_year_max', v_year - 16,
    'consents', jsonb_build_object(
      'profile_demographics', private.has_consent(p_user_id, 'profile_demographics'),
      'emergency_contact', private.has_consent(p_user_id, 'emergency_contact')
    )
  );
end;
$$;

-- Small-cell suppression for one dimension whose cells partition a population of known size.
-- Rule (min group size p_min, here 5):
--   1. every cell with a count below p_min (0 included) is suppressed;
--   2. while some cells are suppressed and (only one is, or their sum is below p_min), the
--      smallest remaining cell (first in the given order on ties) is suppressed as well;
--   3. stop when no cell is suppressed, when at least two are and they add up to p_min or more,
--      or when every cell is suppressed.
-- The organizer knows the population size (the member list), so the suppressed cells' SUM can
-- always be derived by subtraction; rule 2 makes that sum cover at least p_min people spread over
-- at least two categories, so no single small cell (and no "nobody / everybody is X" fact about a
-- group below p_min) can be recovered by differencing. Returns
-- [ { key, count (null when suppressed), suppressed } ] in the given order.
create function private.suppress_small_cells(p_keys text[], p_counts integer[], p_min integer)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_n integer := coalesce(array_length(p_keys, 1), 0);
  v_suppressed boolean[];
  v_count integer;
  v_sum integer;
  v_pick integer;
  v_result jsonb := '[]'::jsonb;
  i integer;
begin
  if v_n = 0 then
    return v_result;
  end if;
  v_suppressed := array_fill(false, array[v_n]);
  for i in 1 .. v_n loop
    if p_counts[i] < p_min then
      v_suppressed[i] := true;
    end if;
  end loop;

  loop
    v_count := 0;
    v_sum := 0;
    for i in 1 .. v_n loop
      if v_suppressed[i] then
        v_count := v_count + 1;
        v_sum := v_sum + p_counts[i];
      end if;
    end loop;
    exit when v_count = 0 or (v_count >= 2 and v_sum >= p_min);

    v_pick := null;
    for i in 1 .. v_n loop
      if not v_suppressed[i] and (v_pick is null or p_counts[i] < p_counts[v_pick]) then
        v_pick := i;
      end if;
    end loop;
    exit when v_pick is null;
    v_suppressed[v_pick] := true;
  end loop;

  for i in 1 .. v_n loop
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'key', p_keys[i],
      'count', case when v_suppressed[i] then null else p_counts[i] end,
      'suppressed', v_suppressed[i]
    ));
  end loop;
  return v_result;
end;
$$;

-- What get_community_demographics publishes for one dimension (P3-QA-1). Live exact counts can be
-- differenced by an organizer who adds or removes accounts (invitation codes, anonymous sign-in),
-- so on top of private.suppress_small_cells:
--   1. minimum data: unless at least p_min_with_data members have a value for the dimension (every
--      cell except the one keyed 'not_provided'), every cell is suppressed and insufficient_data is
--      true;
--   2. complementary suppression of the EXACT counts with p_min (as before);
--   3. every shown cell is rounded to the nearest multiple of p_round (counts are integers, so
--      there are no ties: remainder 0-2 down, 3-4 up); a cell whose rounded value would be 0 is
--      suppressed (cannot happen while p_min >= p_round / 2, kept as a guard).
-- Returns { insufficient_data, cells: [ { key, count (null when suppressed), suppressed } ] }.
create function private.publish_demographic_cells(
  p_keys text[],
  p_counts integer[],
  p_min integer,
  p_min_with_data integer,
  p_round integer
) returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_with_data integer;
  v_cells jsonb;
begin
  select coalesce(sum(t.n), 0)::integer into v_with_data
  from unnest(p_keys, p_counts) as t(k, n)
  where t.k <> 'not_provided';

  if v_with_data < p_min_with_data then
    select coalesce(jsonb_agg(jsonb_build_object('key', t.k, 'count', null, 'suppressed', true)
                              order by t.o), '[]'::jsonb)
      into v_cells
    from unnest(p_keys) with ordinality as t(k, o);
    return jsonb_build_object('insufficient_data', true, 'cells', v_cells);
  end if;

  select coalesce(jsonb_agg(
           case
             when (e.c ->> 'suppressed')::boolean then e.c
             when round((e.c ->> 'count')::numeric / p_round) = 0 then
               jsonb_build_object('key', e.c ->> 'key', 'count', null, 'suppressed', true)
             else
               jsonb_build_object('key', e.c ->> 'key',
                                  'count', (round((e.c ->> 'count')::numeric / p_round) * p_round)::integer,
                                  'suppressed', false)
           end
           order by e.o), '[]'::jsonb)
    into v_cells
  from jsonb_array_elements(private.suppress_small_cells(p_keys, p_counts, p_min))
       with ordinality as e(c, o);
  return jsonb_build_object('insufficient_data', false, 'cells', v_cells);
end;
$$;

-- One row per ACTIVE member of the community: age band and gender, 'not_provided' when missing or
-- when the member's profile_demographics consent is not current. Age = p_year - birth year.
create function private.about_you_population(p_community_id uuid, p_year integer)
returns table (age_band text, gender text)
language sql
stable
set search_path = ''
as $$
  select case when a.birth_year is null then 'not_provided'
              when p_year - a.birth_year < 18 then 'under_18'
              when p_year - a.birth_year < 30 then '18_29'
              when p_year - a.birth_year < 40 then '30_39'
              when p_year - a.birth_year < 50 then '40_49'
              when p_year - a.birth_year < 60 then '50_59'
              else '60_plus' end,
         coalesce(a.gender, 'not_provided')
  from public.memberships m
  left join lateral (
    select x.birth_year, x.gender
    from private.member_about_you x
    where x.user_id = m.user_id
      and private.has_consent(m.user_id, 'profile_demographics')
  ) a on true
  where m.community_id = p_community_id
    and m.status = 'active';
$$;

-- What an organizer sees of one member: emergency contact and T-shirt size, both only with a
-- current emergency_contact consent.
create function private.member_emergency_json(
  p_user_id uuid,
  p_display_name text,
  p_role public.membership_role,
  p_row private.member_about_you
) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_consent boolean := private.has_consent(p_user_id, 'emergency_contact');
  v_contact boolean := v_consent and p_row.emergency_contact_name is not null;
begin
  return jsonb_build_object(
    'user_id', p_user_id,
    'display_name', p_display_name,
    'role', p_role,
    'emergency_contact_name', case when v_contact then p_row.emergency_contact_name end,
    'emergency_contact_phone', case when v_contact then p_row.emergency_contact_phone end,
    'emergency_contact_relationship', case when v_contact then p_row.emergency_contact_relationship end,
    'tshirt_size', case when v_consent then p_row.tshirt_size end,
    'has_emergency_contact', v_contact,
    'updated_at', p_row.updated_at
  );
end;
$$;

-- RPCs: the member's own data -----------------------------------------------------------------------

-- get_my_about_you: the caller's details. Works without a profile (all fields null).
-- Errors: not_authenticated.
create function public.get_my_about_you() returns jsonb
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
  return private.about_you_self_json(v_uid);
end;
$$;

-- save_my_about_you: partial update. p_input is a JSON object with any of the keys
--   birth_year (integer, server year - 100 .. server year - 16), gender ('woman' | 'man' |
--   'other' | 'prefer_not_to_say'), emergency_contact_name (1-80), emergency_contact_phone
--   (digits, spaces, + ( ) . / -, 6-20 digits, at most 30 characters),
--   emergency_contact_relationship (1-40), tshirt_size ('XS' .. 'XXL').
-- A key that is absent leaves the field unchanged; a key with JSON null clears it. Texts go
-- through private.clean_required_text (single line: controls and bidi controls stripped,
-- whitespace collapsed, trimmed, invisible-only rejected). After merging, an emergency contact
-- needs both a name and a phone (relationship optional). A save that leaves no field deletes the
-- row. Returns the same object as get_my_about_you.
-- Errors in order: not_authenticated, validation_failed:input (not an object, unknown key),
-- validation_failed:<field>, then after the locks not_a_member (no profile: the caller never
-- joined a community, or the account is being deleted), consent_required:profile_demographics
-- (setting birth_year / gender), consent_required:emergency_contact (setting a contact field or
-- tshirt_size), validation_failed:emergency_contact_name /
-- validation_failed:emergency_contact_phone (incomplete contact after the merge).
create function public.save_my_about_you(p_input jsonb) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_keys constant text[] := array['birth_year', 'gender', 'emergency_contact_name',
                                  'emergency_contact_phone', 'emergency_contact_relationship',
                                  'tshirt_size'];
  v_uid uuid := auth.uid();
  v_year integer := private.about_you_year();
  v_value jsonb;
  v_number numeric;
  v_text text;
  v_birth_year integer;
  v_gender text;
  v_name text;
  v_phone text;
  v_relationship text;
  v_tshirt text;
  v_old private.member_about_you;
  v_new private.member_about_you;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception using errcode = 'P0001', message = 'validation_failed:input';
  end if;
  if exists (select 1 from jsonb_object_keys(p_input) k where not (k = any (c_keys))) then
    raise exception using errcode = 'P0001', message = 'validation_failed:input';
  end if;

  -- Validation (before any lock).
  v_value := p_input -> 'birth_year';
  if v_value is not null and jsonb_typeof(v_value) <> 'null' then
    if jsonb_typeof(v_value) <> 'number' then
      raise exception using errcode = 'P0001', message = 'validation_failed:birth_year';
    end if;
    v_number := (v_value #>> '{}')::numeric;
    if v_number <> trunc(v_number) or v_number < v_year - 100 or v_number > v_year - 16 then
      raise exception using errcode = 'P0001', message = 'validation_failed:birth_year';
    end if;
    v_birth_year := v_number::integer;
  end if;

  v_value := p_input -> 'gender';
  if v_value is not null and jsonb_typeof(v_value) <> 'null' then
    if jsonb_typeof(v_value) <> 'string'
       or (v_value #>> '{}') not in ('woman', 'man', 'other', 'prefer_not_to_say') then
      raise exception using errcode = 'P0001', message = 'validation_failed:gender';
    end if;
    v_gender := v_value #>> '{}';
  end if;

  v_value := p_input -> 'emergency_contact_name';
  if v_value is not null and jsonb_typeof(v_value) <> 'null' then
    if jsonb_typeof(v_value) <> 'string' then
      raise exception using errcode = 'P0001', message = 'validation_failed:emergency_contact_name';
    end if;
    v_name := private.clean_required_text(v_value #>> '{}', 'emergency_contact_name', 80, false);
  end if;

  v_value := p_input -> 'emergency_contact_phone';
  if v_value is not null and jsonb_typeof(v_value) <> 'null' then
    if jsonb_typeof(v_value) <> 'string' then
      raise exception using errcode = 'P0001', message = 'validation_failed:emergency_contact_phone';
    end if;
    v_phone := private.clean_required_text(v_value #>> '{}', 'emergency_contact_phone', 30, false);
    if v_phone !~ '^\+?[0-9 ()./-]+$'
       or char_length(regexp_replace(v_phone, '[^0-9]', '', 'g')) not between 6 and 20 then
      raise exception using errcode = 'P0001', message = 'validation_failed:emergency_contact_phone';
    end if;
  end if;

  v_value := p_input -> 'emergency_contact_relationship';
  if v_value is not null and jsonb_typeof(v_value) <> 'null' then
    if jsonb_typeof(v_value) <> 'string' then
      raise exception using errcode = 'P0001', message = 'validation_failed:emergency_contact_relationship';
    end if;
    v_relationship := private.clean_required_text(
      v_value #>> '{}', 'emergency_contact_relationship', 40, false);
  end if;

  v_value := p_input -> 'tshirt_size';
  if v_value is not null and jsonb_typeof(v_value) <> 'null' then
    if jsonb_typeof(v_value) <> 'string' then
      raise exception using errcode = 'P0001', message = 'validation_failed:tshirt_size';
    end if;
    v_text := upper(btrim(v_value #>> '{}'));
    if v_text not in ('XS', 'S', 'M', 'L', 'XL', 'XXL') then
      raise exception using errcode = 'P0001', message = 'validation_failed:tshirt_size';
    end if;
    v_tshirt := v_text;
  end if;

  -- A concurrent withdrawal of a consent cannot interleave between the check and the write.
  perform private.lock_consents(v_uid);
  perform 1 from public.profiles p where p.id = v_uid for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;

  if (v_birth_year is not null or v_gender is not null)
     and not private.has_consent(v_uid, 'profile_demographics') then
    raise exception using errcode = 'P0001', message = 'consent_required:profile_demographics';
  end if;
  if (v_name is not null or v_phone is not null or v_relationship is not null
      or v_tshirt is not null)
     and not private.has_consent(v_uid, 'emergency_contact') then
    raise exception using errcode = 'P0001', message = 'consent_required:emergency_contact';
  end if;

  select a.* into v_old from private.member_about_you a where a.user_id = v_uid for update;

  v_new.user_id := v_uid;
  v_new.birth_year := case when p_input ? 'birth_year' then v_birth_year else v_old.birth_year end;
  v_new.gender := case when p_input ? 'gender' then v_gender else v_old.gender end;
  v_new.emergency_contact_name :=
    case when p_input ? 'emergency_contact_name' then v_name else v_old.emergency_contact_name end;
  v_new.emergency_contact_phone :=
    case when p_input ? 'emergency_contact_phone' then v_phone else v_old.emergency_contact_phone end;
  v_new.emergency_contact_relationship :=
    case when p_input ? 'emergency_contact_relationship' then v_relationship
         else v_old.emergency_contact_relationship end;
  v_new.tshirt_size := case when p_input ? 'tshirt_size' then v_tshirt else v_old.tshirt_size end;

  if v_new.emergency_contact_name is not null or v_new.emergency_contact_phone is not null
     or v_new.emergency_contact_relationship is not null then
    if v_new.emergency_contact_name is null then
      raise exception using errcode = 'P0001', message = 'validation_failed:emergency_contact_name';
    end if;
    if v_new.emergency_contact_phone is null then
      raise exception using errcode = 'P0001', message = 'validation_failed:emergency_contact_phone';
    end if;
  end if;

  if num_nonnulls(v_new.birth_year, v_new.gender, v_new.emergency_contact_name,
                  v_new.emergency_contact_phone, v_new.emergency_contact_relationship,
                  v_new.tshirt_size) = 0 then
    delete from private.member_about_you a where a.user_id = v_uid;
  else
    insert into private.member_about_you as a (
      user_id, birth_year, gender, emergency_contact_name, emergency_contact_phone,
      emergency_contact_relationship, tshirt_size
    ) values (
      v_uid, v_new.birth_year, v_new.gender, v_new.emergency_contact_name,
      v_new.emergency_contact_phone, v_new.emergency_contact_relationship, v_new.tshirt_size
    )
    on conflict (user_id) do update
      set birth_year = excluded.birth_year,
          gender = excluded.gender,
          emergency_contact_name = excluded.emergency_contact_name,
          emergency_contact_phone = excluded.emergency_contact_phone,
          emergency_contact_relationship = excluded.emergency_contact_relationship,
          tshirt_size = excluded.tshirt_size,
          updated_at = now()
      where (a.birth_year, a.gender, a.emergency_contact_name, a.emergency_contact_phone,
             a.emergency_contact_relationship, a.tshirt_size)
            is distinct from
            (excluded.birth_year, excluded.gender, excluded.emergency_contact_name,
             excluded.emergency_contact_phone, excluded.emergency_contact_relationship,
             excluded.tshirt_size);
  end if;

  return private.about_you_self_json(v_uid);
end;
$$;

-- clear_my_about_you: deletes every About-you field of the caller (the row). Consents stay as they
-- are (withdraw them with withdraw_consent). Returns the same object as get_my_about_you plus
-- `cleared` (false when there was nothing). Errors: not_authenticated.
create function public.clear_my_about_you() returns jsonb
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
  delete from private.member_about_you a where a.user_id = v_uid;
  get diagnostics v_count = row_count;
  return private.about_you_self_json(v_uid) || jsonb_build_object('cleared', v_count > 0);
end;
$$;

-- RPCs: organizers ------------------------------------------------------------------------------------

-- get_member_emergency_info: an active organizer of the community reads one ACTIVE member's
-- emergency contact and T-shirt size (fields null when not given or when the member's
-- emergency_contact consent is not current). Never birth year or gender.
-- Errors: not_authenticated, forbidden (not an active organizer of the community; also unknown or
-- null community), validation_failed:user_id, not_found (unknown user, removed member, member of
-- another community).
create function public.get_member_emergency_info(p_community_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.membership_role;
  v_name text;
  v_row private.member_about_you;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if p_community_id is null or not public.is_organizer(p_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  if p_user_id is null then
    raise exception using errcode = 'P0001', message = 'validation_failed:user_id';
  end if;

  select m.role, p.display_name into v_role, v_name
  from public.memberships m
  join public.profiles p on p.id = m.user_id
  where m.community_id = p_community_id
    and m.user_id = p_user_id
    and m.status = 'active';
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  select a.* into v_row from private.member_about_you a where a.user_id = p_user_id;
  return jsonb_build_object('community_id', p_community_id)
         || private.member_emergency_json(p_user_id, v_name, v_role, v_row);
end;
$$;

-- list_community_emergency_info: an active organizer of the community lists the ACTIVE members
-- (organizers included) that gave an emergency contact or a T-shirt size (current consent),
-- by display name; at most 500 (truncated = true when more exist).
-- { community_id, members: [ <as get_member_emergency_info without community_id> ], truncated }
-- Errors: not_authenticated, forbidden.
create function public.list_community_emergency_info(p_community_id uuid) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_limit constant integer := 500;
  v_uid uuid := auth.uid();
  v_members jsonb;
  v_total integer;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if p_community_id is null or not public.is_organizer(p_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;

  with candidates as (
    select private.member_emergency_json(m.user_id, p.display_name, m.role, a) as j,
           p.display_name, m.user_id
    from public.memberships m
    join public.profiles p on p.id = m.user_id
    join private.member_about_you a on a.user_id = m.user_id
    where m.community_id = p_community_id
      and m.status = 'active'
  ),
  shown as (
    select r.*, row_number() over (order by r.display_name, r.user_id) as n
    from candidates r
    where (r.j ->> 'has_emergency_contact')::boolean or r.j ->> 'tshirt_size' is not null
  )
  select coalesce(jsonb_agg(s.j order by s.n) filter (where s.n <= c_limit), '[]'::jsonb),
         count(*)::integer
    into v_members, v_total
  from shown s;

  return jsonb_build_object(
    'community_id', p_community_id,
    'members', v_members,
    'truncated', v_total > c_limit
  );
end;
$$;

-- get_community_demographics: an active organizer of the community gets APPROXIMATE group totals
-- over the community's ACTIVE members (organizers included):
--   age_bands: under_18, 18_29, 30_39, 40_49, 50_59, 60_plus, not_provided
--     (age = server year - birth year, i.e. the age reached this calendar year)
--   genders:   woman, man, other, prefer_not_to_say, not_provided
-- Each dimension separately through private.publish_demographic_cells: nothing is shown unless at
-- least 20 active members gave a value for it (insufficient_data); cells below 5 are suppressed
-- with complementary suppression (on the exact counts); every shown cell is rounded to a multiple
-- of 5 (so it is at least 5 and within 2 of the real count). There is no age x gender
-- cross-table. A field without a current consent counts as not_provided. member_count is exact
-- (organizers see the member list anyway).
-- What this protects: an organizer never sees a person's age or gender, and cannot read a small
-- group's exact size from one answer or by adding a few accounts once (P3-QA-1). What it does not:
-- an organizer who adds or removes accounts one at a time and watches a rounded total change can
-- still find where it crosses a rounding boundary (docs/API_CONTRACT.md, known limits).
-- { community_id, min_group_size: 5, min_members_with_data: 20, rounded_to: 5, member_count,
--   reference_year, insufficient_data: { age_bands, genders },
--   age_bands: [ { key, count, suppressed } ], genders: [ { key, count, suppressed } ] }
-- Errors: not_authenticated, forbidden.
create function public.get_community_demographics(p_community_id uuid) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_min constant integer := 5;
  c_min_with_data constant integer := 20;
  c_round constant integer := 5;
  c_age_keys constant text[] := array['under_18', '18_29', '30_39', '40_49', '50_59', '60_plus',
                                      'not_provided'];
  c_gender_keys constant text[] := array['woman', 'man', 'other', 'prefer_not_to_say',
                                         'not_provided'];
  v_uid uuid := auth.uid();
  v_year integer := private.about_you_year();
  v_total integer;
  v_age_counts integer[];
  v_gender_counts integer[];
  v_ages jsonb;
  v_genders jsonb;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if p_community_id is null or not public.is_organizer(p_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;

  select count(*)::integer into v_total
  from private.about_you_population(p_community_id, v_year);

  select array_agg(coalesce(c.n, 0) order by t.o) into v_age_counts
  from unnest(c_age_keys) with ordinality as t(k, o)
  left join (
    select x.age_band, count(*)::integer as n
    from private.about_you_population(p_community_id, v_year) x
    group by x.age_band
  ) c on c.age_band = t.k;

  select array_agg(coalesce(c.n, 0) order by t.o) into v_gender_counts
  from unnest(c_gender_keys) with ordinality as t(k, o)
  left join (
    select x.gender, count(*)::integer as n
    from private.about_you_population(p_community_id, v_year) x
    group by x.gender
  ) c on c.gender = t.k;

  v_ages := private.publish_demographic_cells(c_age_keys, v_age_counts, c_min, c_min_with_data, c_round);
  v_genders := private.publish_demographic_cells(c_gender_keys, v_gender_counts, c_min, c_min_with_data,
                                                 c_round);

  return jsonb_build_object(
    'community_id', p_community_id,
    'min_group_size', c_min,
    'min_members_with_data', c_min_with_data,
    'rounded_to', c_round,
    'member_count', v_total,
    'reference_year', v_year,
    'insufficient_data', jsonb_build_object(
      'age_bands', v_ages -> 'insufficient_data',
      'genders', v_genders -> 'insufficient_data'
    ),
    'age_bands', v_ages -> 'cells',
    'genders', v_genders -> 'cells'
  );
end;
$$;

-- Consent withdrawal deletes the data -----------------------------------------------------------------
-- Same as Q7-2 (20261125000100_gdpr_qa_fixes.sql) except: profile_demographics and
-- emergency_contact delete the About-you fields they cover (private.erase_about_you_purpose), in
-- both branches, exactly like push_notifications removes the push tokens: also when no grant is on
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
    if p_purpose in ('push_notifications', 'profile_demographics', 'emergency_contact') then
      perform 1 from auth.users u where u.id = v_uid for key share;
      if not found then
        -- Deleted while this call waited for the consent lock.
        raise exception using errcode = 'P0001', message = 'not_authenticated';
      end if;
      if p_purpose = 'push_notifications' then
        delete from public.device_push_tokens t where t.user_id = v_uid;
      else
        perform private.erase_about_you_purpose(v_uid, p_purpose);
      end if;
    end if;
    return private.consent_event_json(p_purpose, v_latest, false);
  end if;

  -- Ledger row first: its foreign key key-share-locks the auth user, so a concurrent account
  -- deletion is either waited for here (then not_authenticated) or waits for this call, before
  -- this call locks any token or About-you row.
  insert into public.consent_records (user_id, purpose, document_version, granted, created_at)
  values (v_uid, p_purpose, private.privacy_version(), false, private.next_consent_at(v_uid))
  returning * into v_row;

  if p_purpose = 'push_notifications' then
    delete from public.device_push_tokens t where t.user_id = v_uid;
  elsif p_purpose in ('profile_demographics', 'emergency_contact') then
    perform private.erase_about_you_purpose(v_uid, p_purpose);
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
-- Same as P4 (20261129000100_event_feed.sql) plus extensions.about_you (the caller's row, null when
-- there is none) and one README sentence about it.

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
      'data_export_requests', (select count(*) > c_limit from exports)
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
-- Same as P4 (20261129000100_event_feed.sql) plus the About-you row. The summary is unchanged.

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


-- Grants -------------------------------------------------------------------------------------------

revoke all on function private.about_you_year() from public, anon, authenticated, service_role;
revoke all on function private.erase_about_you_purpose(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.about_you_self_json(uuid) from public, anon, authenticated, service_role;
revoke all on function private.suppress_small_cells(text[], integer[], integer)
  from public, anon, authenticated, service_role;
revoke all on function private.publish_demographic_cells(text[], integer[], integer, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function private.about_you_population(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.member_emergency_json(uuid, text, public.membership_role, private.member_about_you)
  from public, anon, authenticated, service_role;
revoke all on function private.erase_user(uuid) from public, anon, authenticated, service_role;

revoke all on function public.get_my_about_you() from public, anon, authenticated, service_role;
revoke all on function public.save_my_about_you(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.clear_my_about_you() from public, anon, authenticated, service_role;
revoke all on function public.get_member_emergency_info(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_community_emergency_info(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_community_demographics(uuid) from public, anon, authenticated, service_role;
revoke all on function public.withdraw_consent(text) from public, anon, authenticated, service_role;
revoke all on function public.export_my_data() from public, anon, authenticated, service_role;

grant execute on function public.get_my_about_you() to authenticated;
grant execute on function public.save_my_about_you(jsonb) to authenticated;
grant execute on function public.clear_my_about_you() to authenticated;
grant execute on function public.get_member_emergency_info(uuid, uuid) to authenticated;
grant execute on function public.list_community_emergency_info(uuid) to authenticated;
grant execute on function public.get_community_demographics(uuid) to authenticated;
grant execute on function public.withdraw_consent(text) to authenticated;
grant execute on function public.export_my_data() to authenticated;
