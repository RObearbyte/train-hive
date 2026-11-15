-- TrainHive M1-B2: activity types, training sessions and RSVPs (schema, RLS, realtime).
-- Contract: docs/API_CONTRACT.md. Same security model as 20261114000100_core_schema.sql:
-- explicit revokes, select-only under RLS, every write inside a security definer RPC.

-- Enums -------------------------------------------------------------------------------------

create type public.session_status as enum ('scheduled', 'confirmed', 'cancelled', 'completed');
create type public.cancel_reason as enum ('insufficient_participation', 'organizer');
create type public.rsvp_response as enum ('going', 'not_going', 'no_response');

-- Tables ------------------------------------------------------------------------------------

create table public.activity_types (
  key text primary key,
  label text not null,
  sort_order integer not null default 0,
  constraint activity_types_key_check check (key ~ '^[a-z][a-z0-9_]{0,49}$')
);

insert into public.activity_types (key, label, sort_order) values
  ('running', 'Running', 10),
  ('trail_running', 'Trail running', 20),
  ('strength', 'Strength', 30),
  ('functional_fitness', 'Functional fitness', 40),
  ('ocr', 'OCR', 50),
  ('other', 'Other', 100);

create table public.training_sessions (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities (id) on delete cascade,
  -- Always set on creation. Becomes null when the organizer's account is deleted, so the
  -- sessions they created survive.
  organizer_id uuid references public.profiles (id) on delete set null,
  title text not null,
  description text,
  activity_type text not null default 'other' references public.activity_types (key),
  starts_at timestamptz not null,
  ends_at timestamptz,
  rsvp_deadline timestamptz not null,
  timezone text not null,
  location_name text not null,
  address text,
  latitude double precision,
  longitude double precision,
  map_url text,
  meeting_instructions text,
  min_participants integer not null,
  max_participants integer,
  going_count integer not null default 0,
  status public.session_status not null default 'scheduled',
  cancel_reason public.cancel_reason,
  decided_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Target of the composite foreign key that keeps training_rsvps.community_id honest.
  constraint training_sessions_id_community_key unique (id, community_id),
  constraint training_sessions_title_check
    check (title = btrim(title) and char_length(title) between 1 and 80),
  constraint training_sessions_location_name_check
    check (location_name = btrim(location_name) and char_length(location_name) between 1 and 120),
  constraint training_sessions_text_lengths_check
    check (
      (description is null or char_length(description) between 1 and 2000)
      and (address is null or char_length(address) between 1 and 200)
      and (map_url is null or char_length(map_url) between 1 and 2048)
      and (meeting_instructions is null or char_length(meeting_instructions) between 1 and 1000)
    ),
  constraint training_sessions_rsvp_deadline_check check (rsvp_deadline < starts_at),
  constraint training_sessions_ends_at_check check (ends_at is null or ends_at > starts_at),
  constraint training_sessions_min_participants_check check (min_participants >= 1),
  constraint training_sessions_max_participants_check
    check (max_participants is null or max_participants >= min_participants),
  constraint training_sessions_going_count_check
    check (going_count >= 0 and (max_participants is null or going_count <= max_participants)),
  constraint training_sessions_latitude_check
    check (latitude is null or latitude between -90 and 90),
  constraint training_sessions_longitude_check
    check (longitude is null or longitude between -180 and 180),
  constraint training_sessions_coordinates_pair_check
    check ((latitude is null) = (longitude is null)),
  constraint training_sessions_cancel_reason_check
    check ((status = 'cancelled') = (cancel_reason is not null))
);

create index training_sessions_community_starts_idx
  on public.training_sessions (community_id, starts_at);

-- The finalizer's work list.
create index training_sessions_scheduled_deadline_idx
  on public.training_sessions (rsvp_deadline)
  where status = 'scheduled';

create table public.training_rsvps (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  community_id uuid not null references public.communities (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  response public.rsvp_response not null,
  responded_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Also the "RSVPs of a session" index.
  constraint training_rsvps_session_user_key unique (session_id, user_id),
  constraint training_rsvps_session_fkey
    foreign key (session_id, community_id)
    references public.training_sessions (id, community_id) on delete cascade
);

create index training_rsvps_user_id_idx on public.training_rsvps (user_id);
create index training_rsvps_community_id_idx on public.training_rsvps (community_id);

-- Privileges --------------------------------------------------------------------------------

revoke all on table
  public.activity_types,
  public.training_sessions,
  public.training_rsvps
from public, anon, authenticated;

grant select on table
  public.activity_types,
  public.training_sessions,
  public.training_rsvps
to authenticated;

-- Row level security ------------------------------------------------------------------------

alter table public.activity_types enable row level security;
alter table public.training_sessions enable row level security;
alter table public.training_rsvps enable row level security;

create policy activity_types_select_authenticated on public.activity_types
  for select to authenticated
  using (true);

create policy training_sessions_select_active_members on public.training_sessions
  for select to authenticated
  using (public.is_active_member(community_id));

create policy training_rsvps_select_active_members on public.training_rsvps
  for select to authenticated
  using (public.is_active_member(community_id));

-- Realtime ----------------------------------------------------------------------------------
-- Default replica identity is kept: rows are never deleted by the app and clients only use
-- change events to invalidate queries, so old-row images are not needed.

do $$
declare
  v_table text;
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    foreach v_table in array array['training_sessions', 'training_rsvps'] loop
      if not exists (
        select 1
        from pg_catalog.pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = v_table
      ) then
        execute format('alter publication supabase_realtime add table public.%I', v_table);
      end if;
    end loop;
  end if;
end
$$;
