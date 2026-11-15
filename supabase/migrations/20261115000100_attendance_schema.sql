-- TrainHive M2-B1: attendance records, attendance audit log, finalization columns (schema,
-- RLS, realtime). Contract: docs/API_CONTRACT.md ("Milestone 2"). Same security model as the
-- Milestone 1 migrations: explicit revokes, select-only under RLS, every write inside a
-- security definer RPC (next migration).
--
-- RSVP is intention, attendance is what happened. A member's attendance for a session is
-- `present`, `absent` or `unrecorded`; `unrecorded` means "nobody said", never "absent".
-- Every row comes from one of two origins, enforced by a check:
--   * had_rsvp_going: the member's RSVP was `going` when the row was created, or
--   * is_walk_in: the member took part without a `going` RSVP (add_walk_in_attendee).

-- Enum --------------------------------------------------------------------------------------

create type public.attendance_status as enum ('present', 'absent', 'unrecorded');

-- training_sessions: finalization -------------------------------------------------------------

alter table public.training_sessions
  add column attendance_finalized_at timestamptz,
  add column attendance_finalized_by uuid references public.profiles (id) on delete set null;

-- `completed` is reached only through finalize_attendance, which always stamps the time.
-- (attendance_finalized_by may become null later, when that organizer's account is deleted.)
alter table public.training_sessions
  add constraint training_sessions_attendance_finalized_check
    check ((status = 'completed') = (attendance_finalized_at is not null));

create index training_sessions_attendance_finalized_by_idx
  on public.training_sessions (attendance_finalized_by);

-- attendance_records ------------------------------------------------------------------------

create table public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  community_id uuid not null references public.communities (id) on delete cascade,
  -- Deleting a user's account deletes their attendance, as it deletes their RSVPs.
  user_id uuid not null references public.profiles (id) on delete cascade,
  status public.attendance_status not null default 'unrecorded',
  -- The organizer who created the row, and when. Later changes are in attendance_audit_log.
  recorded_by uuid references public.profiles (id) on delete set null,
  recorded_at timestamptz not null default now(),
  -- Time of the last status change.
  updated_at timestamptz not null default now(),
  had_rsvp_going boolean not null,
  is_walk_in boolean not null default false,
  -- One row per member and session: the database, not the RPC, rules out duplicates.
  constraint attendance_records_session_user_key unique (session_id, user_id),
  -- Keeps community_id (what the select policy keys on) equal to the session's community.
  constraint attendance_records_session_fkey
    foreign key (session_id, community_id)
    references public.training_sessions (id, community_id) on delete cascade,
  constraint attendance_records_origin_check check (had_rsvp_going <> is_walk_in)
);

create index attendance_records_user_id_idx on public.attendance_records (user_id);
create index attendance_records_community_id_idx on public.attendance_records (community_id);
create index attendance_records_recorded_by_idx on public.attendance_records (recorded_by);

-- attendance_audit_log ----------------------------------------------------------------------
-- One row per real status change, written only by the attendance RPCs, never updated.
-- old_status is `unrecorded` when the member had no record before.

create table public.attendance_audit_log (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  community_id uuid not null references public.communities (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  changed_by uuid references public.profiles (id) on delete set null,
  changed_at timestamptz not null default now(),
  old_status public.attendance_status not null,
  new_status public.attendance_status not null,
  reason text,
  action text not null,
  constraint attendance_audit_log_session_fkey
    foreign key (session_id, community_id)
    references public.training_sessions (id, community_id) on delete cascade,
  constraint attendance_audit_log_action_check
    check (action in ('record', 'correct', 'walk_in_add')),
  constraint attendance_audit_log_change_check check (old_status <> new_status),
  constraint attendance_audit_log_reason_check
    check (reason is null or (reason = btrim(reason) and char_length(reason) between 1 and 200))
);

create index attendance_audit_log_session_changed_idx
  on public.attendance_audit_log (session_id, changed_at);
create index attendance_audit_log_community_id_idx on public.attendance_audit_log (community_id);
create index attendance_audit_log_user_id_idx on public.attendance_audit_log (user_id);
create index attendance_audit_log_changed_by_idx on public.attendance_audit_log (changed_by);

-- Privileges --------------------------------------------------------------------------------

revoke all on table public.attendance_records, public.attendance_audit_log
from public, anon, authenticated;

grant select on table public.attendance_records, public.attendance_audit_log to authenticated;

-- Row level security ------------------------------------------------------------------------

alter table public.attendance_records enable row level security;
alter table public.attendance_audit_log enable row level security;

-- Members see only their own attendance; organizers see the whole community's.
-- Why not every active member, like training_rsvps: an RSVP is a public intention that the
-- participant list needs, whereas attendance (in particular `absent`) is a personal record
-- that only the member and the people managing it need. A member's history is this select.
-- A removed member sees nothing, as for every other table.
create policy attendance_records_select_own_or_organizer on public.attendance_records
  for select to authenticated
  using (
    (user_id = (select auth.uid()) and public.is_active_member(community_id))
    or public.is_organizer(community_id)
  );

create policy attendance_audit_log_select_organizers on public.attendance_audit_log
  for select to authenticated
  using (public.is_organizer(community_id));

-- Realtime ----------------------------------------------------------------------------------
-- attendance_records: lets two organizers marking the same session see each other's changes
-- (events pass RLS, so members only get events for their own rows). The session row already
-- carries the `completed` transition. The audit log is not published.

do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_catalog.pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'attendance_records'
     )
  then
    alter publication supabase_realtime add table public.attendance_records;
  end if;
end
$$;
