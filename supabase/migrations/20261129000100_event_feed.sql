-- TrainHive P4: event feed (docs/EVENTS_PLAN.md section 4). Contract: docs/API_CONTRACT.md
-- ("Event feed (P4)").
--
--   * event_posts: organizers write top-level posts on an event, any active member of the
--     community replies (one level). Body 1..1000 characters after the shared text hygiene
--     (private.clean_required_text: controls and bidi controls stripped, line breaks normalized,
--     invisible-only text rejected). Soft delete: deleted_at is set and the body is cleared;
--     deleting a top-level post deletes its replies the same way. Organizers delete any post; the
--     author of a reply may delete their own reply. A deleted post's in-app notifications (they
--     quote it) are removed.
--   * Posting window: posts and replies are accepted on an event of any status (cancelled
--     included) until 30 days after its end (ends_at, else starts_at + 2 hours); afterwards
--     event_closed. Reading, marking read and deleting are always allowed.
--   * Rate limit: an organizer writes at most 5 top-level posts per event per rolling hour
--     (deleted posts included), counted under the organizer's membership lock (FOR NO KEY UPDATE,
--     as create_announcement), so it is exact under concurrency. The 6th is refused with
--     rate_limited (nothing is written).
--   * event_feed_reads: one read cursor per (event, user). Unread = visible posts not written by
--     the caller and created after the cursor. Writers hold a shared per-event advisory lock and
--     stamp created_at with clock_timestamp() after taking it; mark_event_feed_read takes it
--     exclusively, so a post committed after a cursor was written always has a later created_at
--     (no post is ever skipped by the cursor).
--   * Notifications: new kinds event_post (to the active members whose RSVP is going, author
--     excluded) and event_reply (to the parent post's author, never to oneself). Deep link
--     /events/<id>/feed, added to notifications_deep_link_check (existing routes kept). Push
--     preferences and push consent are applied by claim_notification_jobs at send time, as for
--     every kind: the event kinds fall in its training_updates category (no new preference).
--   * No consent gate: posting is part of the service (contract basis), like RSVP and attendance;
--     no other in-community write checks consent (20261123000100_consents.sql header).
--   * Leaving / removal: posts and replies stay (as announcements and attendance history); a
--     removed member loses read access (RLS: active members only) and is no longer notified.
--   * GDPR: private.erase_user deletes the user's replies (and the notifications quoting them) and
--     keeps the user's top-level posts without author (as announcements); the read cursors go.
--     export_my_data lists the user's posts (authored.event_posts) and read cursors
--     (event_feed_reads).
--
-- Lock order (matches account erasure: profile -> memberships -> sessions -> posts ->
-- notifications): caller profile (key share) -> caller membership -> event row (key share) ->
-- per-event feed advisory lock -> parent / target post -> notifications.

-- Notification kinds ----------------------------------------------------------------------------
-- Added values cannot be used in the transaction that adds them; nothing below uses them at
-- creation time (plpgsql bodies are resolved when they run).

alter type public.notification_kind add value if not exists 'event_post';
alter type public.notification_kind add value if not exists 'event_reply';

-- Deep link allowlist: + /events/<uuid>/feed ------------------------------------------------------
-- Same pattern as Q4-6 (20261116000100_m3_qa_fixes.sql): NOT VALID, then validated.

alter table public.notifications drop constraint notifications_deep_link_check;
alter table public.notifications
  add constraint notifications_deep_link_check
  check (
    deep_link ~ '^/activity$'
    or deep_link ~ '^/trainings/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or deep_link ~ '^/announcements/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or deep_link ~ '^/events/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/feed$'
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

create table public.event_posts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  community_id uuid not null,
  -- Null once the author's account is deleted (top-level posts stay, as announcements do).
  author_id uuid references public.profiles (id) on delete set null,
  -- Null for a top-level post. Replies are one level deep (checked by reply_to_event_post).
  parent_id uuid,
  -- Null exactly when the post is deleted.
  body text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint event_posts_id_session_key unique (id, session_id),
  constraint event_posts_session_fkey foreign key (session_id, community_id)
    references public.training_sessions (id, community_id) on delete cascade,
  -- A reply belongs to the same event as its parent.
  constraint event_posts_parent_fkey foreign key (parent_id, session_id)
    references public.event_posts (id, session_id) on delete cascade,
  constraint event_posts_parent_check check (parent_id is null or parent_id <> id),
  constraint event_posts_body_check check (
    (deleted_at is null and body is not null and char_length(body) between 1 and 1000)
    or (deleted_at is not null and body is null)
  )
);

create index event_posts_session_created_idx on public.event_posts (session_id, created_at);
create index event_posts_community_id_idx on public.event_posts (community_id);
create index event_posts_author_id_idx on public.event_posts (author_id);
create index event_posts_parent_id_idx on public.event_posts (parent_id);

create table public.event_feed_reads (
  session_id uuid not null references public.training_sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  last_read_at timestamptz not null,
  primary key (session_id, user_id)
);

create index event_feed_reads_user_id_idx on public.event_feed_reads (user_id);

-- Privileges and row level security ---------------------------------------------------------------

revoke all on table public.event_posts, public.event_feed_reads from public, anon, authenticated;
grant select on table public.event_posts, public.event_feed_reads to authenticated;

alter table public.event_posts enable row level security;
alter table public.event_feed_reads enable row level security;

-- Every active member of the event's community (deleted posts are visible as tombstones without
-- a body, so Realtime delivers the deletion).
create policy event_posts_select_members on public.event_posts
  for select to authenticated
  using (public.is_active_member(community_id));

create policy event_feed_reads_select_own on public.event_feed_reads
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Realtime: posts are published (RLS filters per subscriber); read cursors are not.
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_catalog.pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'event_posts'
     ) then
    alter publication supabase_realtime add table public.event_posts;
  end if;
end
$$;

-- Private helpers ---------------------------------------------------------------------------------

-- The per-event feed lock: shared for writers of posts, exclusive for the read cursor.
create function private.lock_event_feed(p_session_id uuid, p_exclusive boolean) returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if p_exclusive then
    perform pg_advisory_xact_lock(hashtextextended('event_feed:' || p_session_id::text, 0));
  else
    perform pg_advisory_xact_lock_shared(hashtextextended('event_feed:' || p_session_id::text, 0));
  end if;
end;
$$;

-- Until when an event's feed accepts posts and replies: 30 days after its end (ends_at, else
-- starts_at + 2 hours, the default duration used for push expiry).
create function private.event_feed_closes_at(p_starts_at timestamptz, p_ends_at timestamptz)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_ends_at, p_starts_at + interval '2 hours') + interval '30 days';
$$;

-- A one-line preview of a post body for notifications (whitespace collapsed, at most 200).
create function private.event_post_preview(p_body text) returns text
language sql
immutable
set search_path = ''
as $$
  select left(btrim(regexp_replace(p_body, '\s+', ' ', 'g')), 200);
$$;

-- RPCs ---------------------------------------------------------------------------------------------

-- create_event_post: an active organizer of the event's community writes a top-level post.
-- Errors in order: not_authenticated, not_found (unknown event), forbidden (not an active
-- organizer of its community), event_closed, validation_failed:body, then after the locks
-- forbidden (removed / demoted meanwhile) and rate_limited (5 posts by this organizer on this
-- event in the last hour).
create function public.create_event_post(p_session_id uuid, p_body text)
returns public.event_posts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_per_hour constant integer := 5;
  v_uid uuid := auth.uid();
  v_session public.training_sessions;
  v_body text;
  v_recent integer;
  v_row public.event_posts;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;

  select s.* into v_session
  from public.training_sessions s
  where s.id = p_session_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if not public.is_organizer(v_session.community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  if clock_timestamp() >= private.event_feed_closes_at(v_session.starts_at, v_session.ends_at) then
    raise exception using errcode = 'P0001', message = 'event_closed';
  end if;

  v_body := private.clean_required_text(p_body, 'body', 1000, true);

  perform 1 from public.profiles p where p.id = v_uid for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  -- Serializes this organizer's posts (exact rate limit) and makes a concurrent removal or
  -- demotion wait; one that committed first is seen here.
  perform 1
  from public.memberships m
  where m.community_id = v_session.community_id
    and m.user_id = v_uid
    and m.status = 'active'
    and m.role = 'organizer'
  for no key update;
  if not found then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;

  perform 1 from public.training_sessions s where s.id = p_session_id for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  perform private.lock_event_feed(p_session_id, false);

  select count(*)::integer into v_recent
  from public.event_posts ep
  where ep.session_id = p_session_id
    and ep.author_id = v_uid
    and ep.parent_id is null
    and ep.created_at > clock_timestamp() - interval '1 hour';
  if v_recent >= c_per_hour then
    raise exception using errcode = 'P0001', message = 'rate_limited';
  end if;

  insert into public.event_posts (session_id, community_id, author_id, parent_id, body, created_at)
  values (p_session_id, v_session.community_id, v_uid, null, v_body, clock_timestamp())
  returning * into v_row;

  perform private.enqueue_notification(
    private.training_recipients(v_session.community_id, p_session_id, v_uid, true, null),
    v_session.community_id,
    'event_post',
    'New post: ' || v_session.title,
    private.event_post_preview(v_body),
    '/events/' || p_session_id || '/feed',
    p_session_id, null, 'event_post:' || v_row.id,
    private.push_expiry(now() + interval '1 day')
  );

  return v_row;
end;
$$;

-- reply_to_event_post: any active member of the community (organizers included) replies to a
-- top-level, not deleted post. Errors in order: not_authenticated, not_found (unknown post),
-- not_a_member, not_a_top_level_post, post_deleted, event_closed, validation_failed:body (and
-- not_a_member / post_deleted again after the locks). The parent post's author is notified
-- (event_reply) unless it is the caller or no longer an active member.
create function public.reply_to_event_post(p_post_id uuid, p_body text)
returns public.event_posts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_parent public.event_posts;
  v_session public.training_sessions;
  v_body text;
  v_row public.event_posts;
  v_name text;
  v_recipients uuid[];
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;

  select ep.* into v_parent
  from public.event_posts ep
  where ep.id = p_post_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if not public.is_active_member(v_parent.community_id) then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;
  if v_parent.parent_id is not null then
    raise exception using errcode = 'P0001', message = 'not_a_top_level_post';
  end if;
  if v_parent.deleted_at is not null then
    raise exception using errcode = 'P0001', message = 'post_deleted';
  end if;

  select s.* into v_session
  from public.training_sessions s
  where s.id = v_parent.session_id;
  if clock_timestamp() >= private.event_feed_closes_at(v_session.starts_at, v_session.ends_at) then
    raise exception using errcode = 'P0001', message = 'event_closed';
  end if;

  v_body := private.clean_required_text(p_body, 'body', 1000, true);

  select p.display_name into v_name
  from public.profiles p
  where p.id = v_uid
  for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;
  perform 1
  from public.memberships m
  where m.community_id = v_parent.community_id
    and m.user_id = v_uid
    and m.status = 'active'
  for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;

  perform 1 from public.training_sessions s where s.id = v_parent.session_id for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  perform private.lock_event_feed(v_parent.session_id, false);

  -- A concurrent delete holds the parent FOR UPDATE; once it commits, the parent is deleted.
  select ep.* into v_parent
  from public.event_posts ep
  where ep.id = p_post_id
  for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if v_parent.deleted_at is not null then
    raise exception using errcode = 'P0001', message = 'post_deleted';
  end if;

  insert into public.event_posts (session_id, community_id, author_id, parent_id, body, created_at)
  values (v_parent.session_id, v_parent.community_id, v_uid, v_parent.id, v_body, clock_timestamp())
  returning * into v_row;

  select coalesce(array_agg(m.user_id), '{}'::uuid[]) into v_recipients
  from public.memberships m
  where m.community_id = v_parent.community_id
    and m.user_id = v_parent.author_id
    and m.user_id <> v_uid
    and m.status = 'active';

  perform private.enqueue_notification(
    v_recipients, v_parent.community_id, 'event_reply',
    'New reply: ' || v_session.title,
    v_name || ': ' || private.event_post_preview(v_body),
    '/events/' || v_parent.session_id || '/feed',
    v_parent.session_id, null, 'event_reply:' || v_row.id,
    private.push_expiry(now() + interval '1 day')
  );

  return v_row;
end;
$$;

-- delete_event_post: soft delete (deleted_at set, body cleared). Allowed for an active organizer
-- of the post's community (any post) and for the author of a reply who is still an active member
-- (own replies only; a member cannot delete a top-level post or someone else's reply). A
-- top-level post takes its replies with it. The in-app notifications quoting the deleted posts
-- are removed (their push jobs cascade). Already deleted: the row is returned unchanged. Allowed
-- after the posting window closed. Errors: not_authenticated, not_found, forbidden (re-checked
-- under the membership lock).
create function public.delete_event_post(p_post_id uuid)
returns public.event_posts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_post public.event_posts;
  v_role public.membership_role;
  v_row public.event_posts;
  v_keys text[];
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;

  select ep.* into v_post
  from public.event_posts ep
  where ep.id = p_post_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if not (public.is_organizer(v_post.community_id)
          or (v_post.parent_id is not null
              and v_post.author_id = v_uid
              and public.is_active_member(v_post.community_id))) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;

  select m.role into v_role
  from public.memberships m
  where m.community_id = v_post.community_id
    and m.user_id = v_uid
    and m.status = 'active'
  for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;

  select ep.* into v_row
  from public.event_posts ep
  where ep.id = p_post_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if v_role <> 'organizer' and not (v_row.parent_id is not null and v_row.author_id = v_uid) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  if v_row.deleted_at is not null then
    return v_row;
  end if;

  select array_agg(
           case when ep.parent_id is null then 'event_post:' else 'event_reply:' end || ep.id
           order by ep.id)
    into v_keys
  from public.event_posts ep
  where ep.id = p_post_id
     or (ep.parent_id = p_post_id and ep.deleted_at is null);

  update public.event_posts ep
  set deleted_at = clock_timestamp(),
      body = null
  where ep.id = p_post_id
     or (ep.parent_id = p_post_id and ep.deleted_at is null);

  delete from public.notifications n
  where n.related_session_id = v_row.session_id
    and n.kind in ('event_post', 'event_reply')
    and n.dedupe_key = any (v_keys);

  select ep.* into v_row from public.event_posts ep where ep.id = p_post_id;
  return v_row;
end;
$$;

-- mark_event_feed_read: moves the caller's read cursor of an event to now (never backwards) and
-- marks the caller's event_post / event_reply notifications of that event read. Returns the
-- cursor row. Errors: not_authenticated, not_found (unknown event), not_a_member.
create function public.mark_event_feed_read(p_session_id uuid)
returns public.event_feed_reads
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_community_id uuid;
  v_now timestamptz;
  v_row public.event_feed_reads;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;

  select s.community_id into v_community_id
  from public.training_sessions s
  where s.id = p_session_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if not public.is_active_member(v_community_id) then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;

  perform 1 from public.profiles p where p.id = v_uid for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;
  perform 1 from public.training_sessions s where s.id = p_session_id for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  -- Waits for posts being written on this event; posts started later get a later created_at.
  perform private.lock_event_feed(p_session_id, true);
  v_now := clock_timestamp();

  insert into public.event_feed_reads as r (session_id, user_id, last_read_at)
  values (p_session_id, v_uid, v_now)
  on conflict (session_id, user_id)
  do update set last_read_at = greatest(r.last_read_at, excluded.last_read_at)
  returning * into v_row;

  update public.notifications n
  set read_at = v_now
  where n.user_id = v_uid
    and n.related_session_id = p_session_id
    and n.kind in ('event_post', 'event_reply')
    and n.read_at is null;

  return v_row;
end;
$$;

-- get_event_feed: the feed of one event for an active member of its community.
-- { session_id, community_id, is_organizer, closes_at, is_open, can_post, can_reply,
--   last_read_at, post_count, unread_count,
--   posts: [ { id, parent_id: null, author_id, author_name, author_role, body, created_at,
--              is_unread, can_delete, replies: [ { id, parent_id, ..., can_delete } ] } ] }
-- Top-level posts newest first, replies oldest first. Deleted posts (and replies of deleted
-- posts) are left out. author_id / author_name are null for a deleted account ("Former member");
-- author_role is the author's current active role in the community, else null. Counts cover
-- posts and replies; unread = not written by the caller and created after last_read_at (all of
-- them when the caller never opened the feed). Errors: not_authenticated, not_found, not_a_member.
create function public.get_event_feed(p_session_id uuid) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_session public.training_sessions;
  v_is_organizer boolean;
  v_closes_at timestamptz;
  v_open boolean;
  v_last timestamptz;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;

  select s.* into v_session
  from public.training_sessions s
  where s.id = p_session_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if not public.is_active_member(v_session.community_id) then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;

  v_is_organizer := public.is_organizer(v_session.community_id);
  v_closes_at := private.event_feed_closes_at(v_session.starts_at, v_session.ends_at);
  v_open := now() < v_closes_at;

  select r.last_read_at into v_last
  from public.event_feed_reads r
  where r.session_id = p_session_id
    and r.user_id = v_uid;

  with items as (
    select ep.id, ep.parent_id, ep.created_at,
           (ep.author_id is distinct from v_uid
            and ep.created_at > coalesce(v_last, '-infinity'::timestamptz)) as unread,
           jsonb_build_object(
             'id', ep.id,
             'parent_id', ep.parent_id,
             'author_id', ep.author_id,
             'author_name', pr.display_name,
             'author_role', m.role,
             'body', ep.body,
             'created_at', ep.created_at,
             'is_unread', ep.author_id is distinct from v_uid
                          and ep.created_at > coalesce(v_last, '-infinity'::timestamptz),
             'can_delete', v_is_organizer
                           or (ep.parent_id is not null and ep.author_id = v_uid)
           ) as j
    from public.event_posts ep
    left join public.profiles pr on pr.id = ep.author_id
    left join public.memberships m
      on m.community_id = ep.community_id
     and m.user_id = ep.author_id
     and m.status = 'active'
    where ep.session_id = p_session_id
      and ep.deleted_at is null
      and (ep.parent_id is null or exists (
        select 1 from public.event_posts t
        where t.id = ep.parent_id and t.deleted_at is null
      ))
  )
  select jsonb_build_object(
    'session_id', p_session_id,
    'community_id', v_session.community_id,
    'is_organizer', v_is_organizer,
    'closes_at', v_closes_at,
    'is_open', v_open,
    'can_post', v_is_organizer and v_open,
    'can_reply', v_open,
    'last_read_at', v_last,
    'post_count', (select count(*) from items),
    'unread_count', (select count(*) from items i where i.unread),
    'posts', coalesce((
      select jsonb_agg(
               t.j || jsonb_build_object('replies', coalesce((
                 select jsonb_agg(r.j order by r.created_at, r.id)
                 from items r
                 where r.parent_id = t.id), '[]'::jsonb))
               order by t.created_at desc, t.id desc)
      from items t
      where t.parent_id is null), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- get_event_feed_unread: per event of a community that has visible posts, for the caller:
-- [ { session_id, post_count, unread_count, last_post_at } ], latest activity first. Same
-- counting rules as get_event_feed. Errors: not_authenticated, not_a_member (also for unknown or
-- null communities).
create function public.get_event_feed_unread(p_community_id uuid) returns jsonb
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
  if p_community_id is null or not public.is_active_member(p_community_id) then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'session_id', x.session_id,
               'post_count', x.post_count,
               'unread_count', x.unread_count,
               'last_post_at', x.last_post_at
             )
             order by x.last_post_at desc, x.session_id),
           '[]'::jsonb)
    into v_result
  from (
    select ep.session_id,
           count(*)::integer as post_count,
           (count(*) filter (
              where ep.author_id is distinct from v_uid
                and ep.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
           ))::integer as unread_count,
           max(ep.created_at) as last_post_at
    from public.event_posts ep
    left join public.event_feed_reads r
      on r.session_id = ep.session_id
     and r.user_id = v_uid
    where ep.community_id = p_community_id
      and ep.deleted_at is null
      and (ep.parent_id is null or exists (
        select 1 from public.event_posts t
        where t.id = ep.parent_id and t.deleted_at is null
      ))
    group by ep.session_id
  ) x;

  return v_result;
end;
$$;

-- GDPR: export -------------------------------------------------------------------------------------
-- Same as Q7 (20261125000100_gdpr_qa_fixes.sql) plus authored.event_posts (the caller's posts and
-- replies, deleted ones with a null body), event_feed_reads (the caller's read cursors), their
-- truncated flags and one README sentence about them.

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
      || 'your replies are deleted. technical: rate-limit records kept for about a day. Other '
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
    'extensions', '{}'::jsonb,
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

-- GDPR: erasure ------------------------------------------------------------------------------------
-- Same as Q7 (20261125000100_gdpr_qa_fixes.sql) plus the event feed: the user's replies are
-- deleted together with the notifications that quote them (other members' rows); the user's
-- top-level posts stay without author (as announcements), so other members' replies survive;
-- the user's read cursors are deleted.

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

-- Grants ---------------------------------------------------------------------------------------------

revoke all on function private.lock_event_feed(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function private.event_feed_closes_at(timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.event_post_preview(text) from public, anon, authenticated, service_role;
revoke all on function private.erase_user(uuid) from public, anon, authenticated, service_role;

revoke all on function public.create_event_post(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.reply_to_event_post(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.delete_event_post(uuid) from public, anon, authenticated, service_role;
revoke all on function public.mark_event_feed_read(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_event_feed(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_event_feed_unread(uuid) from public, anon, authenticated, service_role;
revoke all on function public.export_my_data() from public, anon, authenticated, service_role;

grant execute on function public.create_event_post(uuid, text) to authenticated;
grant execute on function public.reply_to_event_post(uuid, text) to authenticated;
grant execute on function public.delete_event_post(uuid) to authenticated;
grant execute on function public.mark_event_feed_read(uuid) to authenticated;
grant execute on function public.get_event_feed(uuid) to authenticated;
grant execute on function public.get_event_feed_unread(uuid) to authenticated;
grant execute on function public.export_my_data() to authenticated;
