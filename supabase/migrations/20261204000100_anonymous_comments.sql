-- TrainHive: anonymous comments on events. Contract: docs/API_CONTRACT.md ("Anonymous comments").
-- Builds on the P4 event feed (20261129000100_event_feed.sql); every earlier migration is frozen,
-- the functions below replace theirs under the same names (one function per name).
--
-- Owner request: "Members should be able to comment anonymously on the events". Interpretation:
--   1. Every active member (organizers too) writes their OWN top-level comments on an event
--      (kind 'comment'), not only replies to organizer posts (kind 'post').
--   2. A member's comment or reply may be posted ANONYMOUSLY. Organizers never post anonymously
--      (anonymous_not_allowed): their posts, comments and replies always carry their name.
--
-- Anonymity:
--   * public.event_posts gains kind ('post' | 'comment' | 'reply') and is_anonymous. An anonymous
--     row is stored with author_id NULL, so nothing that reads the table (direct select under RLS,
--     Realtime postgres_changes payloads, service_role) can see who wrote it. The author is kept in
--     private.event_post_anonymous_authors (no API role has any privilege on the private schema),
--     needed for the author's own delete, unread counts, the rate limit, export and erasure.
--   * Nicknames: an anonymous author is shown as a funny per-event nickname ("Sleepy Capybara"),
--     private.event_aliases, assigned on their first anonymous item on that event: stable within
--     the event, unique among its anonymous authors, unrelated across events (salted hash start,
--     private.event_alias_salt). See the "Nicknames" section below.
--   * get_event_feed shows an anonymous item with author_name = the nickname, author_id and
--     author_role null and is_anonymous true to everyone, organizers included; the author sees
--     the same plus mine: true and may delete it. Organizers delete any item as before
--     (moderation by content, not identity).
--   * Notifications: a reply notifies the parent's author (the real one, also when the parent is
--     anonymous) with "<nickname>: <preview>" when the reply is anonymous. Top-level comments
--     notify nobody (decision: comments stay quiet; organizer posts keep notifying going members).
--   * Whoever has database access (the operator) can still see the author: the app hides it, the
--     database does not forget it (docs/RECORD_OF_PROCESSING.md, docs/CLAIMS_AUDIT.md).
--
-- Rules for comments: same posting window (30 days after the event's end, event_closed), same text
-- hygiene and 1..1000 characters (validation_failed:body), same locks and unread cursor rules as
-- P4. Rate limit: ANONYMOUS writes only (comments and replies together), at most 10 per member per
-- event per rolling hour (deleted ones included), refused with rate_limited; counted under the
-- member's membership lock (FOR NO KEY UPDATE), so exact under concurrency. Named comments and
-- replies are not limited (owner decision for replies; a named comment is treated like a reply).
-- Deleting a top-level comment deletes its replies, like a post.
--
-- GDPR: export_my_data lists the caller's anonymous items too (authored.event_posts, flagged
-- is_anonymous, with kind). private.erase_user deletes the user's comments and replies, anonymous
-- or not (replies of others under a deleted comment go with it) and the user's nicknames, and
-- keeps organizer posts without author as before. export_my_data also lists the caller's own
-- nicknames (authored.event_aliases, and alias on each anonymous item). Nicknames go with their
-- event (cascade). private.account_last_activity also counts anonymous items.
--
-- Lock order (unchanged): caller profile (key share) -> caller membership -> event row (key share)
-- -> per-event feed advisory lock -> parent / target post -> notifications.

-- Columns ------------------------------------------------------------------------------------------

alter table public.event_posts
  add column kind text not null default 'post',
  add column is_anonymous boolean not null default false;

update public.event_posts ep set kind = 'reply' where ep.parent_id is not null;

alter table public.event_posts
  add constraint event_posts_kind_check check (
    (parent_id is null and kind in ('post', 'comment'))
    or (parent_id is not null and kind = 'reply')
  ),
  -- An anonymous row never names its author in the table; organizer posts are never anonymous.
  add constraint event_posts_anonymous_check check (
    not is_anonymous or (author_id is null and kind in ('comment', 'reply'))
  );

-- The hidden authors ---------------------------------------------------------------------------------

create table private.event_post_anonymous_authors (
  post_id uuid primary key references public.event_posts (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade
);

create index event_post_anonymous_authors_author_idx
  on private.event_post_anonymous_authors (author_id);

revoke all on table private.event_post_anonymous_authors from public, anon, authenticated, service_role;

-- Nicknames ("Sleepy Capybara") ------------------------------------------------------------------
-- An anonymous author gets one nickname per event, assigned on their first anonymous item there:
-- stable within the event (readers can follow who is who), unique among the event's anonymous
-- authors, and unrelated across events. The start point is a hash of a per-database random salt,
-- the event and the person, so it cannot be derived from ids outside the database; on a collision
-- the next free combination is taken. 40 adjectives x 40 animals = 1600 nicknames per event; when
-- all are taken, alias_pool_exhausted is raised (nothing is written).

create table private.event_alias_salt (
  id boolean primary key default true,
  salt text not null,
  constraint event_alias_salt_single_row check (id)
);
insert into private.event_alias_salt (id, salt)
values (true, md5(gen_random_uuid()::text || clock_timestamp()::text) || md5(gen_random_uuid()::text));
revoke all on table private.event_alias_salt from public, anon, authenticated, service_role;

create table private.event_aliases (
  session_id uuid not null references public.training_sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  alias text not null,
  created_at timestamptz not null default now(),
  constraint event_aliases_pkey primary key (session_id, user_id),
  constraint event_aliases_alias_key unique (session_id, alias)
);
create index event_aliases_user_id_idx on private.event_aliases (user_id);
revoke all on table private.event_aliases from public, anon, authenticated, service_role;

-- Family friendly, plain ASCII, no real people. Changing the lists later only affects new aliases.
create function private.alias_adjectives() returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'Sleepy', 'Speedy', 'Grumpy', 'Happy', 'Brave', 'Clever', 'Curious', 'Dizzy', 'Fluffy', 'Gentle',
    'Giggly', 'Jolly', 'Lucky', 'Mighty', 'Nimble', 'Plucky', 'Quiet', 'Bouncy', 'Cheerful', 'Chilly',
    'Cozy', 'Dapper', 'Eager', 'Fancy', 'Fearless', 'Friendly', 'Fuzzy', 'Hasty', 'Humble', 'Jazzy',
    'Lively', 'Merry', 'Peppy', 'Polite', 'Proud', 'Rusty', 'Sneaky', 'Sunny', 'Witty', 'Zesty'
  ]::text[]
$$;

create function private.alias_animals() returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'Capybara', 'Otter', 'Llama', 'Panda', 'Koala', 'Penguin', 'Hedgehog', 'Badger', 'Beaver', 'Bison',
    'Camel', 'Cheetah', 'Dolphin', 'Falcon', 'Ferret', 'Flamingo', 'Gazelle', 'Gecko', 'Giraffe', 'Hamster',
    'Heron', 'Ibex', 'Jaguar', 'Kangaroo', 'Lemur', 'Lynx', 'Meerkat', 'Moose', 'Narwhal', 'Ocelot',
    'Owl', 'Pelican', 'Puffin', 'Quokka', 'Raccoon', 'Seal', 'Sloth', 'Tapir', 'Walrus', 'Zebra'
  ]::text[]
$$;

-- The caller's nickname on an event: the existing one, else a new one. Called by the posting RPCs
-- after their locks and checks (the caller's anonymous writes are serialized by the membership
-- lock; two different people racing for the same nickname are resolved by the unique key: the
-- loser skips to the next free one). Raises alias_pool_exhausted when no nickname is left.
create function private.assign_event_alias(p_session_id uuid, p_user_id uuid) returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_adjectives text[] := private.alias_adjectives();
  v_animals text[] := private.alias_animals();
  v_size integer;
  v_start integer;
  v_idx integer;
  v_alias text;
begin
  select e.alias into v_alias
  from private.event_aliases e
  where e.session_id = p_session_id
    and e.user_id = p_user_id;
  if found then
    return v_alias;
  end if;

  v_size := cardinality(v_adjectives) * cardinality(v_animals);
  select ((hashtextextended(s.salt || ':' || p_session_id::text || ':' || p_user_id::text, 0) % v_size)
          + v_size) % v_size
    into v_start
  from private.event_alias_salt s;

  -- Bounded: each round either inserts, or loses a race for one nickname to a concurrent writer.
  for v_round in 1..50 loop
    if v_round > 1 then
      select e.alias into v_alias
      from private.event_aliases e
      where e.session_id = p_session_id
        and e.user_id = p_user_id;
      if found then
        return v_alias;
      end if;
    end if;

    select x.idx into v_idx
    from generate_series(0, v_size - 1) g(i)
    cross join lateral (select (v_start + g.i) % v_size as idx) x
    where not exists (
      select 1
      from private.event_aliases e
      where e.session_id = p_session_id
        and e.alias = v_adjectives[x.idx / cardinality(v_animals) + 1]
                      || ' ' || v_animals[x.idx % cardinality(v_animals) + 1]
    )
    order by g.i
    limit 1;
    if not found then
      raise exception using errcode = 'P0001', message = 'alias_pool_exhausted';
    end if;

    v_alias := v_adjectives[v_idx / cardinality(v_animals) + 1]
               || ' ' || v_animals[v_idx % cardinality(v_animals) + 1];
    insert into private.event_aliases (session_id, user_id, alias)
    values (p_session_id, p_user_id, v_alias)
    on conflict do nothing;
    if found then
      return v_alias;
    end if;
  end loop;

  raise exception using errcode = 'P0001', message = 'alias_pool_exhausted';
end;
$$;

-- RPCs ---------------------------------------------------------------------------------------------

-- create_event_comment: an active member (organizers too) writes a top-level comment on an event,
-- optionally anonymous (members only). Errors in order: not_authenticated, not_found (unknown /
-- null event), not_a_member, anonymous_not_allowed (an organizer asked for anonymity),
-- event_closed, validation_failed:body, then after the locks not_a_member (removed meanwhile),
-- anonymous_not_allowed (promoted meanwhile) and rate_limited (anonymous only: 10 anonymous
-- comments and replies by this member on this event in the last hour) and alias_pool_exhausted
-- (no nickname left on this event). Notifies nobody.
create function public.create_event_comment(
  p_session_id uuid,
  p_body text,
  p_anonymous boolean default false
)
returns public.event_posts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_anonymous_per_hour constant integer := 10;
  v_uid uuid := auth.uid();
  v_anonymous boolean := coalesce(p_anonymous, false);
  v_session public.training_sessions;
  v_body text;
  v_role public.membership_role;
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
  if not public.is_active_member(v_session.community_id) then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;
  if v_anonymous and public.is_organizer(v_session.community_id) then
    raise exception using errcode = 'P0001', message = 'anonymous_not_allowed';
  end if;
  if clock_timestamp() >= private.event_feed_closes_at(v_session.starts_at, v_session.ends_at) then
    raise exception using errcode = 'P0001', message = 'event_closed';
  end if;

  v_body := private.clean_required_text(p_body, 'body', 1000, true);

  perform 1 from public.profiles p where p.id = v_uid for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;
  -- Anonymous: FOR NO KEY UPDATE serializes this member's anonymous writes (exact rate limit).
  -- Named: FOR SHARE, as a reply. Either way a concurrent removal or role change waits.
  if v_anonymous then
    select m.role into v_role
    from public.memberships m
    where m.community_id = v_session.community_id
      and m.user_id = v_uid
      and m.status = 'active'
    for no key update;
  else
    select m.role into v_role
    from public.memberships m
    where m.community_id = v_session.community_id
      and m.user_id = v_uid
      and m.status = 'active'
    for share;
  end if;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;
  if v_anonymous and v_role = 'organizer' then
    raise exception using errcode = 'P0001', message = 'anonymous_not_allowed';
  end if;

  perform 1 from public.training_sessions s where s.id = p_session_id for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  perform private.lock_event_feed(p_session_id, false);

  if v_anonymous then
    select count(*)::integer into v_recent
    from private.event_post_anonymous_authors a
    join public.event_posts ep on ep.id = a.post_id
    where a.author_id = v_uid
      and ep.session_id = p_session_id
      and ep.created_at > clock_timestamp() - interval '1 hour';
    if v_recent >= c_anonymous_per_hour then
      raise exception using errcode = 'P0001', message = 'rate_limited';
    end if;
    perform private.assign_event_alias(p_session_id, v_uid);
  end if;

  insert into public.event_posts
    (session_id, community_id, author_id, parent_id, body, created_at, kind, is_anonymous)
  values
    (p_session_id, v_session.community_id, case when v_anonymous then null else v_uid end, null,
     v_body, clock_timestamp(), 'comment', v_anonymous)
  returning * into v_row;

  if v_anonymous then
    insert into private.event_post_anonymous_authors (post_id, author_id) values (v_row.id, v_uid);
  end if;

  return v_row;
end;
$$;

-- reply_to_event_post: any active member of the community (organizers included) replies to a
-- top-level, not deleted post or comment, optionally anonymous (members only). Errors in order:
-- not_authenticated, not_found (unknown post), not_a_member, anonymous_not_allowed,
-- not_a_top_level_post, post_deleted, event_closed, validation_failed:body, then after the locks
-- not_a_member, anonymous_not_allowed, post_deleted (a concurrent delete wins) and rate_limited
-- (anonymous only, shared with anonymous comments). The parent's author (the real one, also for
-- an anonymous parent) is notified (event_reply) unless it is the caller or no longer an active
-- member; an anonymous reply is quoted as "<nickname>: <preview>" (alias_pool_exhausted when the
-- event has no nickname left).
drop function public.reply_to_event_post(uuid, text);

create function public.reply_to_event_post(
  p_post_id uuid,
  p_body text,
  p_anonymous boolean default false
)
returns public.event_posts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_anonymous_per_hour constant integer := 10;
  v_uid uuid := auth.uid();
  v_anonymous boolean := coalesce(p_anonymous, false);
  v_parent public.event_posts;
  v_parent_author uuid;
  v_session public.training_sessions;
  v_body text;
  v_row public.event_posts;
  v_name text;
  v_role public.membership_role;
  v_recent integer;
  v_alias text;
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
  if v_anonymous and public.is_organizer(v_parent.community_id) then
    raise exception using errcode = 'P0001', message = 'anonymous_not_allowed';
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
  if v_anonymous then
    select m.role into v_role
    from public.memberships m
    where m.community_id = v_parent.community_id
      and m.user_id = v_uid
      and m.status = 'active'
    for no key update;
  else
    select m.role into v_role
    from public.memberships m
    where m.community_id = v_parent.community_id
      and m.user_id = v_uid
      and m.status = 'active'
    for share;
  end if;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;
  if v_anonymous and v_role = 'organizer' then
    raise exception using errcode = 'P0001', message = 'anonymous_not_allowed';
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

  if v_anonymous then
    select count(*)::integer into v_recent
    from private.event_post_anonymous_authors a
    join public.event_posts ep on ep.id = a.post_id
    where a.author_id = v_uid
      and ep.session_id = v_parent.session_id
      and ep.created_at > clock_timestamp() - interval '1 hour';
    if v_recent >= c_anonymous_per_hour then
      raise exception using errcode = 'P0001', message = 'rate_limited';
    end if;
    v_alias := private.assign_event_alias(v_parent.session_id, v_uid);
  end if;

  insert into public.event_posts
    (session_id, community_id, author_id, parent_id, body, created_at, kind, is_anonymous)
  values
    (v_parent.session_id, v_parent.community_id, case when v_anonymous then null else v_uid end,
     v_parent.id, v_body, clock_timestamp(), 'reply', v_anonymous)
  returning * into v_row;

  if v_anonymous then
    insert into private.event_post_anonymous_authors (post_id, author_id) values (v_row.id, v_uid);
  end if;

  v_parent_author := coalesce(
    v_parent.author_id,
    (select a.author_id from private.event_post_anonymous_authors a where a.post_id = v_parent.id)
  );

  select coalesce(array_agg(m.user_id), '{}'::uuid[]) into v_recipients
  from public.memberships m
  where m.community_id = v_parent.community_id
    and m.user_id = v_parent_author
    and m.user_id <> v_uid
    and m.status = 'active';

  perform private.enqueue_notification(
    v_recipients, v_parent.community_id, 'event_reply',
    'New reply: ' || v_session.title,
    case when v_anonymous then v_alias else v_name end
      || ': ' || private.event_post_preview(v_body),
    '/events/' || v_parent.session_id || '/feed',
    v_parent.session_id, null, 'event_reply:' || v_row.id,
    private.push_expiry(now() + interval '1 day')
  );

  return v_row;
end;
$$;

-- delete_event_post: soft delete (deleted_at set, body cleared). Allowed for an active organizer
-- of the post's community (any item) and for the author of a comment or reply who is still an
-- active member (own items only, anonymous ones included; a member cannot delete an organizer
-- post or someone else's item). A top-level post or comment takes its replies with it. The in-app
-- notifications quoting the deleted items are removed (their push jobs cascade). Already deleted:
-- the row is returned unchanged. Allowed after the posting window closed. Errors:
-- not_authenticated, not_found, forbidden (re-checked under the membership lock).
create or replace function public.delete_event_post(p_post_id uuid)
returns public.event_posts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_post public.event_posts;
  v_author uuid;
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
  v_author := coalesce(
    v_post.author_id,
    (select a.author_id from private.event_post_anonymous_authors a where a.post_id = v_post.id)
  );
  if not (public.is_organizer(v_post.community_id)
          or (v_post.kind <> 'post'
              and v_author = v_uid
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
  if v_role <> 'organizer' and not (v_row.kind <> 'post' and v_author = v_uid) then
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

-- get_event_feed: the feed of one event for an active member of its community.
-- { session_id, community_id, is_organizer, closes_at, is_open, can_post, can_reply, can_comment,
--   can_comment_anonymously, last_read_at, post_count, unread_count,
--   posts: [ { id, parent_id: null, kind ('post' | 'comment'), author_id, author_name,
--              author_role, is_anonymous, mine, body, created_at, is_unread, can_delete,
--              replies: [ { id, parent_id, kind: 'reply', ..., can_delete } ] } ] }
-- Top-level items (organizer posts and comments) newest first, replies oldest first. Deleted
-- items (and replies of deleted ones) are left out. author_id / author_role are null for an
-- anonymous item (to everyone; author_name is then the author's nickname on this event) and
-- author_id / author_name / author_role null for a deleted account (is_anonymous false);
-- author_role is otherwise the author's current active role, else null. mine: the caller wrote
-- it (anonymous ones included). can_delete: the caller is an organizer, or it is the caller's own
-- comment or reply. Counts cover every visible item; unread = not written by the caller and
-- created after last_read_at. Errors: not_authenticated, not_found, not_a_member.
create or replace function public.get_event_feed(p_session_id uuid) returns jsonb
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
           (coalesce(ep.author_id, a.author_id) is distinct from v_uid
            and ep.created_at > coalesce(v_last, '-infinity'::timestamptz)) as unread,
           jsonb_build_object(
             'id', ep.id,
             'parent_id', ep.parent_id,
             'kind', ep.kind,
             -- author_id is stored null for an anonymous item; the hidden author is used only
             -- for the caller's own flags below.
             'author_id', ep.author_id,
             -- The per-event nickname for an anonymous item, else the display name.
             'author_name', case when ep.is_anonymous then al.alias else pr.display_name end,
             'author_role', m.role,
             'is_anonymous', ep.is_anonymous,
             'mine', coalesce(ep.author_id, a.author_id) is not distinct from v_uid,
             'body', ep.body,
             'created_at', ep.created_at,
             'is_unread', coalesce(ep.author_id, a.author_id) is distinct from v_uid
                          and ep.created_at > coalesce(v_last, '-infinity'::timestamptz),
             'can_delete', v_is_organizer
                           or (ep.kind <> 'post'
                               and coalesce(ep.author_id, a.author_id) is not distinct from v_uid)
           ) as j
    from public.event_posts ep
    left join private.event_post_anonymous_authors a on a.post_id = ep.id
    left join private.event_aliases al
      on al.session_id = ep.session_id
     and al.user_id = a.author_id
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
    'can_comment', v_open,
    'can_comment_anonymously', v_open and not v_is_organizer,
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

-- get_event_feed_unread: per event of a community that has visible items, for the caller:
-- [ { session_id, post_count, unread_count, last_post_at } ], latest activity first. Same
-- counting rules as get_event_feed (the caller's own anonymous items are never unread). Errors:
-- not_authenticated, not_a_member (also for unknown or null communities).
create or replace function public.get_event_feed_unread(p_community_id uuid) returns jsonb
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
              where coalesce(ep.author_id, a.author_id) is distinct from v_uid
                and ep.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
           ))::integer as unread_count,
           max(ep.created_at) as last_post_at
    from public.event_posts ep
    left join private.event_post_anonymous_authors a on a.post_id = ep.id
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

-- GDPR: export ------------------------------------------------------------------------------------
-- Same as G3 (20261202000100_retention.sql) except authored.event_posts: it now also lists the
-- caller's anonymous items (found through the hidden author) and every item gains kind and
-- is_anonymous; one README sentence says so. Nothing of other members (an anonymous item of
-- someone else is never in the caller's export).

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

-- GDPR: erasure ------------------------------------------------------------------------------------
-- Body identical to 20261203000100_invitation_duration.sql except the event feed block: the
-- user's comments and replies (anonymous or not) are deleted, with the event_reply notifications
-- that quote the replies; organizer posts stay without author.

create or replace function private.erase_user(p_user_id uuid, p_delete_auth_user boolean default true)
returns jsonb
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

  -- P4 + anonymous comments: the user's replies and comments (named or anonymous) are deleted,
  -- with the notifications that quote the replies (sent to the parent's author); replies of
  -- others under a deleted comment go with it (cascade). Organizer posts stay without author.
  delete from public.notifications n
  where n.kind = 'event_reply'
    and n.dedupe_key in (
      select 'event_reply:' || ep.id
      from public.event_posts ep
      where ep.parent_id is not null
        and (ep.author_id = p_user_id
             or ep.id in (select a.post_id
                          from private.event_post_anonymous_authors a
                          where a.author_id = p_user_id))
    );
  delete from public.event_posts ep
  where ep.id in (select a.post_id
                  from private.event_post_anonymous_authors a
                  where a.author_id = p_user_id);
  delete from public.event_posts ep where ep.author_id = p_user_id and ep.parent_id is not null;
  delete from public.event_posts ep where ep.author_id = p_user_id and ep.kind = 'comment';
  update public.event_posts ep set author_id = null where ep.author_id = p_user_id;
  -- The user's per-event nicknames (the foreign key to profiles would cascade too; explicit here).
  delete from private.event_aliases al where al.user_id = p_user_id;

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
  -- the only way the ledger's append-only guard lets rows go. With p_delete_auth_user = false
  -- (admin_erase_user_data, the Edge Function fallback) the auth user and the ledger stay until
  -- the caller deletes the auth user through the Auth admin API.
  delete from public.profiles p where p.id = p_user_id;
  if p_delete_auth_user then
    delete from auth.users u where u.id = p_user_id;
  end if;

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

-- Retention activity --------------------------------------------------------------------------------
-- Same as 20261202000100_retention.sql plus the user's anonymous items (their author_id is null in
-- public.event_posts).

create or replace function private.account_last_activity(p_user_id uuid) returns timestamptz
language sql
stable
set search_path = ''
as $$
  select max(x.at)
  from (
    select u.created_at as at from auth.users u where u.id = p_user_id
    union all select u.last_sign_in_at from auth.users u where u.id = p_user_id
    union all select a.last_app_open_at from private.account_activity a where a.user_id = p_user_id
    union all select p.updated_at from public.profiles p where p.id = p_user_id
    union all select max(m.joined_at) from public.memberships m where m.user_id = p_user_id
    union all select max(c.created_at) from public.consent_records c where c.user_id = p_user_id
    union all select max(t.last_seen_at) from public.device_push_tokens t where t.user_id = p_user_id
    union all select max(r.updated_at) from public.training_rsvps r where r.user_id = p_user_id
    union all
      select max(ar.updated_at)
      from public.attendance_records ar
      where ar.user_id = p_user_id
        and ar.status = 'present'
    union all select max(ar.updated_at) from public.attendance_records ar where ar.recorded_by = p_user_id
    union all select max(n.read_at) from public.notifications n where n.user_id = p_user_id
    union all select max(rd.read_at) from public.announcement_reads rd where rd.user_id = p_user_id
    union all select max(fr.last_read_at) from public.event_feed_reads fr where fr.user_id = p_user_id
    union all select max(ep.created_at) from public.event_posts ep where ep.author_id = p_user_id
    union all
      select max(ep.created_at)
      from private.event_post_anonymous_authors pa
      join public.event_posts ep on ep.id = pa.post_id
      where pa.author_id = p_user_id
    union all select max(an.updated_at) from public.announcements an where an.author_id = p_user_id
    union all select max(s.updated_at) from public.training_sessions s where s.organizer_id = p_user_id
    union all select max(wl.updated_at) from private.workout_logs wl where wl.user_id = p_user_id
    union all select ay.updated_at from private.member_about_you ay where ay.user_id = p_user_id
    union all select max(el.requested_at) from private.data_export_log el where el.user_id = p_user_id
    union all select max(ia.attempted_at) from public.invitation_attempts ia where ia.user_id = p_user_id
  ) x
$$;

-- Grants -------------------------------------------------------------------------------------------

revoke all on function private.erase_user(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function private.account_last_activity(uuid) from public, anon, authenticated, service_role;
revoke all on function private.alias_adjectives() from public, anon, authenticated, service_role;
revoke all on function private.alias_animals() from public, anon, authenticated, service_role;
revoke all on function private.assign_event_alias(uuid, uuid) from public, anon, authenticated, service_role;

revoke all on function public.create_event_comment(uuid, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.reply_to_event_post(uuid, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.delete_event_post(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_event_feed(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_event_feed_unread(uuid) from public, anon, authenticated, service_role;
revoke all on function public.export_my_data() from public, anon, authenticated, service_role;

grant execute on function public.create_event_comment(uuid, text, boolean) to authenticated;
grant execute on function public.reply_to_event_post(uuid, text, boolean) to authenticated;
grant execute on function public.delete_event_post(uuid) to authenticated;
grant execute on function public.get_event_feed(uuid) to authenticated;
grant execute on function public.get_event_feed_unread(uuid) to authenticated;
grant execute on function public.export_my_data() to authenticated;
