-- TrainHive M1-B1: core schema, RLS and policy helpers.
-- Contract: docs/API_CONTRACT.md.
--
-- Security model:
--   * Hosted Supabase grants ALL on new public tables/functions to anon, authenticated and
--     service_role by default. Nothing here relies on a missing grant: every table gets an
--     explicit "revoke all" followed by the narrow grant it needs.
--   * Tables are select-only for `authenticated` and gated by RLS. `anon` gets nothing.
--   * Every write happens inside a security definer RPC (next migration).
--   * `private` holds internal helpers. API roles have no usage on it and PostgREST does not
--     expose it.

create schema if not exists private;
revoke all on schema private from public;

-- Enums -------------------------------------------------------------------------------------

create type public.membership_role as enum ('organizer', 'member');
create type public.membership_status as enum ('active', 'removed');

-- Tables ------------------------------------------------------------------------------------

create table public.communities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null,
  created_at timestamptz not null default now(),
  constraint communities_name_check
    check (name = btrim(name) and char_length(name) between 1 and 80)
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_check
    check (display_name = btrim(display_name) and char_length(display_name) between 2 and 40)
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.membership_role not null default 'member',
  status public.membership_status not null default 'active',
  joined_at timestamptz not null default now(),
  constraint memberships_community_user_key unique (community_id, user_id)
);

create index memberships_user_id_idx on public.memberships (user_id);

create table public.invitation_codes (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities (id) on delete cascade,
  code text not null,
  role public.membership_role not null default 'member',
  -- Null for the bootstrap invitation created by admin_create_community (no calling user).
  created_by uuid references public.profiles (id) on delete set null,
  expires_at timestamptz,
  max_redemptions integer,
  redemption_count integer not null default 0,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint invitation_codes_code_key unique (code),
  -- Stored normalized: 8 characters from 23456789ABCDEFGHJKMNPQRSTVWXYZ.
  constraint invitation_codes_code_format_check check (code ~ '^[2-9A-HJKMNP-TV-Z]{8}$'),
  constraint invitation_codes_max_redemptions_check
    check (max_redemptions is null or max_redemptions >= 1),
  constraint invitation_codes_redemption_count_check
    check (
      redemption_count >= 0
      and (max_redemptions is null or redemption_count <= max_redemptions)
    )
);

create index invitation_codes_community_id_idx on public.invitation_codes (community_id);

create table public.invitation_redemptions (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid not null references public.invitation_codes (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  constraint invitation_redemptions_invitation_user_key unique (invitation_id, user_id)
);

create index invitation_redemptions_user_id_idx on public.invitation_redemptions (user_id);

create table public.invitation_attempts (
  id uuid primary key default gen_random_uuid(),
  -- References auth.users, not profiles: attempts are logged before a profile exists.
  user_id uuid not null references auth.users (id) on delete cascade,
  attempted_at timestamptz not null default now(),
  success boolean not null
);

create index invitation_attempts_user_attempted_idx
  on public.invitation_attempts (user_id, attempted_at);

-- Policy helpers ----------------------------------------------------------------------------
-- Security definer so that policies on `memberships` (and everything keyed on membership)
-- can ask "is the caller a member?" without re-entering the memberships policy.
-- The parameter is named as in the contract; it is always referenced fully qualified because
-- a bare `community_id` would resolve to the column.

create function public.is_active_member(community_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.community_id = is_active_member.community_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  );
$$;

create function public.is_organizer(community_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.community_id = is_organizer.community_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and m.role = 'organizer'
  );
$$;

revoke all on function public.is_active_member(uuid) from public, anon, authenticated, service_role;
revoke all on function public.is_organizer(uuid) from public, anon, authenticated, service_role;
grant execute on function public.is_active_member(uuid) to authenticated;
grant execute on function public.is_organizer(uuid) to authenticated;

-- Privileges --------------------------------------------------------------------------------

revoke all on table
  public.communities,
  public.profiles,
  public.memberships,
  public.invitation_codes,
  public.invitation_redemptions,
  public.invitation_attempts
from public, anon, authenticated;

grant select on table
  public.communities,
  public.profiles,
  public.memberships,
  public.invitation_codes,
  public.invitation_redemptions
to authenticated;
-- invitation_attempts: no grant and no policy. Only security definer functions touch it.

-- Row level security ------------------------------------------------------------------------

alter table public.communities enable row level security;
alter table public.profiles enable row level security;
alter table public.memberships enable row level security;
alter table public.invitation_codes enable row level security;
alter table public.invitation_redemptions enable row level security;
alter table public.invitation_attempts enable row level security;

create policy communities_select_active_members on public.communities
  for select to authenticated
  using (public.is_active_member(id));

create policy memberships_select_active_members on public.memberships
  for select to authenticated
  using (public.is_active_member(community_id));

-- Self, or a user who is an active member of a community the caller is an active member of.
-- The subquery on memberships runs under the memberships policy above, which only calls the
-- security definer helper, so there is no policy recursion.
create policy profiles_select_self_or_shared_community on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1
      from public.memberships m
      where m.user_id = profiles.id
        and m.status = 'active'
        and public.is_active_member(m.community_id)
    )
  );

create policy invitation_codes_select_organizers on public.invitation_codes
  for select to authenticated
  using (public.is_organizer(community_id));

create policy invitation_redemptions_select_organizers on public.invitation_redemptions
  for select to authenticated
  using (
    exists (
      select 1
      from public.invitation_codes ic
      where ic.id = invitation_redemptions.invitation_id
        and public.is_organizer(ic.community_id)
    )
  );

-- Realtime ----------------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_catalog.pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'memberships'
     )
  then
    alter publication supabase_realtime add table public.memberships;
  end if;
end
$$;
