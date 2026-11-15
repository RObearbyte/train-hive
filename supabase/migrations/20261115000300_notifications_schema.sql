-- TrainHive M3-B1: announcements, read state, in-app notifications, push tokens, notification
-- preferences and the push delivery outbox (schema, RLS, realtime).
-- Contract: docs/API_CONTRACT.md ("Milestone 3"). Same security model as the earlier
-- migrations: explicit revokes, select-only under RLS, every write inside a security definer
-- RPC or trigger (next migration).
--
-- Delivery model:
--   * An event (training created, announcement published, ...) is fanned out into one
--     `notifications` row per recipient. That row IS the in-app notification: it exists whether
--     or not the user allowed push, has a device token or has push turned off.
--   * `notifications (user_id, dedupe_key)` is unique: the same event can never produce two
--     user-visible notifications for one user, whatever re-runs or races happen.
--   * Each newly inserted notification gets exactly one `notification_delivery_jobs` row (the
--     push outbox), which the dispatcher (Edge Function, M3-B2) claims, sends and completes.
--
-- Why notifications.user_id and notification_delivery_jobs.user_id have NO foreign key to
-- profiles: notifications are written by triggers on training_sessions while the session row
-- is locked. A foreign key would key-share-lock every recipient's profile at that point, which
-- is the reverse of the lock order of an account deletion (profile -> memberships -> RSVPs ->
-- session row) and would deadlock with it. Instead a trigger on profiles deletes a deleted
-- user's notifications (next migration), RLS never shows a row without an active membership,
-- and purge_old_notification_data() removes any row that raced with the deletion.

-- Enums -------------------------------------------------------------------------------------

create type public.announcement_status as enum ('scheduled', 'published', 'cancelled');

create type public.notification_kind as enum (
  'training_created',
  'training_updated',
  'training_confirmed',
  'training_cancelled',
  'training_reminder',
  'announcement_published'
);

-- announcements -----------------------------------------------------------------------------

create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities (id) on delete cascade,
  -- Becomes null when the author's account is deleted; the announcement stays.
  author_id uuid references public.profiles (id) on delete set null,
  title text not null,
  body text not null,
  status public.announcement_status not null,
  -- Set for announcements created as scheduled (kept after publication, for history).
  scheduled_for timestamptz,
  published_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint announcements_title_check
    check (title = btrim(title) and char_length(title) between 1 and 100),
  constraint announcements_body_check
    check (body = btrim(body, E' \t\n\r') and char_length(body) between 1 and 2000),
  -- "scheduled_for is in the future at creation" needs the clock and is checked by the RPCs.
  constraint announcements_scheduled_check
    check (status <> 'scheduled' or (scheduled_for is not null and published_at is null)),
  constraint announcements_published_check
    check ((status = 'published') = (published_at is not null)),
  constraint announcements_cancelled_check
    check ((status = 'cancelled') = (cancelled_at is not null))
);

-- The member feed: published announcements of a community, newest first.
create index announcements_community_published_idx
  on public.announcements (community_id, published_at desc)
  where status = 'published';
-- The publisher's work list.
create index announcements_due_idx
  on public.announcements (scheduled_for)
  where status = 'scheduled';
create index announcements_author_id_idx on public.announcements (author_id);

create table public.announcement_reads (
  announcement_id uuid not null references public.announcements (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (announcement_id, user_id)
);

create index announcement_reads_user_id_idx on public.announcement_reads (user_id);

-- notifications (in-app) ----------------------------------------------------------------------

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  -- No foreign key: see the header.
  user_id uuid not null,
  community_id uuid not null references public.communities (id) on delete cascade,
  kind public.notification_kind not null,
  title text not null,
  body text not null,
  -- A relative app route: /trainings/<id> or /announcements/<id>.
  deep_link text not null,
  related_session_id uuid references public.training_sessions (id) on delete cascade,
  related_announcement_id uuid references public.announcements (id) on delete cascade,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint notifications_user_dedupe_key unique (user_id, dedupe_key),
  constraint notifications_title_check check (char_length(title) between 1 and 200),
  constraint notifications_body_check check (char_length(body) between 1 and 500),
  constraint notifications_deep_link_check
    check (deep_link ~ '^/[A-Za-z0-9/_?=&.-]*$' and char_length(deep_link) <= 200),
  constraint notifications_dedupe_key_check check (char_length(dedupe_key) between 1 and 200),
  constraint notifications_related_check
    check (
      case
        when kind = 'announcement_published'
          then related_announcement_id is not null and related_session_id is null
        else related_session_id is not null and related_announcement_id is null
      end
    )
);

-- The feed: a user's notifications of a community, newest first (also "unread" filtering).
create index notifications_user_community_created_idx
  on public.notifications (user_id, community_id, created_at desc);
create index notifications_community_id_idx on public.notifications (community_id);
create index notifications_related_session_id_idx on public.notifications (related_session_id);
create index notifications_related_announcement_id_idx
  on public.notifications (related_announcement_id);

-- Push outbox ---------------------------------------------------------------------------------
-- Status machine (driven by claim_notification_jobs / complete_notification_job):
--   pending --claim--> sending --complete--> sent | skipped | dead
--                         \--complete(failed)--> failed --(retry due)--claim--> sending ...
--   sending for more than 5 minutes (a crashed worker) is claimable again.
--   attempts reaching max_attempts, or expires_at passing, ends in dead.

create table public.notification_delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications (id) on delete cascade,
  -- No foreign key: see the header. Always equal to the notification's user_id.
  user_id uuid not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz not null default now(),
  -- A push that could not be delivered by then is no longer worth sending.
  expires_at timestamptz not null,
  last_error text,
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  -- One job per notification: retries reuse the job, they never add a row.
  constraint notification_delivery_jobs_notification_key unique (notification_id),
  constraint notification_delivery_jobs_status_check
    check (status in ('pending', 'sending', 'sent', 'failed', 'dead', 'skipped')),
  constraint notification_delivery_jobs_attempts_check
    check (max_attempts between 1 and 20 and attempts between 0 and max_attempts),
  constraint notification_delivery_jobs_locked_check
    check ((status = 'sending') = (locked_at is not null)),
  constraint notification_delivery_jobs_sent_check
    check ((status = 'sent') = (sent_at is not null)),
  constraint notification_delivery_jobs_last_error_check
    check (last_error is null or char_length(last_error) <= 1000),
  constraint notification_delivery_jobs_locked_by_check
    check (locked_by is null or char_length(locked_by) between 1 and 100)
);

-- The dispatcher's work lists.
create index notification_delivery_jobs_due_idx
  on public.notification_delivery_jobs (next_attempt_at)
  where status in ('pending', 'failed');
create index notification_delivery_jobs_sending_idx
  on public.notification_delivery_jobs (locked_at)
  where status = 'sending';
create index notification_delivery_jobs_user_id_idx on public.notification_delivery_jobs (user_id);

-- Push tokens ---------------------------------------------------------------------------------

create table public.device_push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  token text not null,
  platform text not null,
  device_label text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Set when Expo answers DeviceNotRegistered; such a token is never used again until the
  -- device registers it again.
  invalidated_at timestamptz,
  last_error text,
  constraint device_push_tokens_token_key unique (token),
  constraint device_push_tokens_token_check
    check (
      char_length(token) <= 200
      and token ~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_:.-]+\]$'
    ),
  constraint device_push_tokens_platform_check check (platform in ('ios', 'android', 'web')),
  constraint device_push_tokens_device_label_check
    check (device_label is null or (device_label = btrim(device_label)
                                    and char_length(device_label) between 1 and 80)),
  constraint device_push_tokens_last_error_check
    check (last_error is null or char_length(last_error) <= 500)
);

create index device_push_tokens_user_id_idx on public.device_push_tokens (user_id);

-- Notification preferences --------------------------------------------------------------------
-- They govern PUSH only. In-app notifications are always stored. A missing row means all
-- defaults (everything on).

create table public.notification_preferences (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  push_enabled boolean not null default true,
  training_reminders boolean not null default true,
  announcements boolean not null default true,
  training_updates boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Privileges --------------------------------------------------------------------------------

revoke all on table
  public.announcements,
  public.announcement_reads,
  public.notifications,
  public.notification_delivery_jobs,
  public.device_push_tokens,
  public.notification_preferences
from public, anon, authenticated;

grant select on table
  public.announcements,
  public.announcement_reads,
  public.notifications,
  public.device_push_tokens,
  public.notification_preferences
to authenticated;
-- notification_delivery_jobs: no grant and no policy. Only security definer functions (the
-- service_role dispatcher RPCs) touch it.

-- Row level security ------------------------------------------------------------------------

alter table public.announcements enable row level security;
alter table public.announcement_reads enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_delivery_jobs enable row level security;
alter table public.device_push_tokens enable row level security;
alter table public.notification_preferences enable row level security;

-- Members see published announcements; organizers also see the scheduled and cancelled ones.
create policy announcements_select_members on public.announcements
  for select to authenticated
  using (
    (status = 'published' and public.is_active_member(community_id))
    or public.is_organizer(community_id)
  );

create policy announcement_reads_select_own on public.announcement_reads
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Only the recipient, and only while an active member of that community.
create policy notifications_select_own on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()) and public.is_active_member(community_id));

create policy device_push_tokens_select_own on public.device_push_tokens
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy notification_preferences_select_own on public.notification_preferences
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Realtime ----------------------------------------------------------------------------------
-- announcements and notifications: Realtime evaluates the select policy for every subscriber,
-- so a user only receives events for their own notifications and for announcements they may
-- read (scheduled ones reach organizers only). Default replica identity: a DELETE event is not
-- filtered by RLS and carries only the primary key (rows are deleted only by cascades, account
-- deletion and the purge, never by the app). Clients should still subscribe with a filter
-- (user_id=eq.<uid> / community_id=eq.<id>) to keep the stream small.

do $$
declare
  v_table text;
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    foreach v_table in array array['announcements', 'notifications'] loop
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
