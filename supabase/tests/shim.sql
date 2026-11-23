-- Minimal stand-in for the parts of a hosted Supabase project that the migrations rely on.
-- Applied once to a fresh embedded Postgres cluster, before supabase/migrations/*.sql.
-- It deliberately mimics Supabase's PERMISSIVE default grants so that the tests prove the
-- migrations are safe under them (explicit revokes + RLS), not merely safe by omission.

-- API roles ---------------------------------------------------------------------------------
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

-- auth schema -------------------------------------------------------------------------------
create schema auth;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  is_anonymous boolean not null default false,
  created_at timestamptz not null default now(),
  -- Hosted Supabase Auth has it (set on sign-in); G3 retention reads it as an activity signal.
  last_sign_in_at timestamptz
);

create function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;
grant all on all tables in schema auth to service_role;

-- extensions schema -------------------------------------------------------------------------
create schema extensions;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

-- Realtime publication ----------------------------------------------------------------------
create publication supabase_realtime;

-- Supabase default grants on schema public --------------------------------------------------
-- Everything the migration role creates in public is, by default, fully accessible to all
-- three API roles. Hosted Supabase relies on RLS and explicit revokes to restrict it.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
