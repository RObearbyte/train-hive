-- TrainHive M3-B3: fixes for the Milestone 3 QA review (docs/QA_REPORT.md, "Milestone 3").
-- Contract: docs/API_CONTRACT.md ("Milestone 3, B3 amendments").
--
--   Q4-4  mark_all_notifications_read also marks read the announcements referenced by the
--         notifications it marks; mark_notification_read does the same for its announcement.
--   Q4-5  private.clean_required_text strips control and bidi-control characters and rejects
--         text that is blank once invisible characters are ignored.
--   Q4-6  notifications.deep_link accepts exactly /activity, /trainings/<uuid>,
--         /announcements/<uuid>.
--   O-1   create_announcement: at most 10 announcements per organizer and community per hour
--         (announcement_rate_limited).
--   O-2   purge_old_notification_data also deletes old in-app notifications.
--   O-3   claim_notification_jobs: the badge counts only notifications of communities where
--         the user is still an active member.
--
-- Functions are replaced in place (same signatures), so existing grants stay; they are
-- nevertheless revoked and granted again explicitly at the end. The privilege matrix is
-- unchanged.

-- Q4-5: text cleaning ---------------------------------------------------------------------------
-- Decision: STRIP characters that are never wanted in a title or body (C0/C1 controls except
-- tab/newline/carriage return, which are whitespace and handled as before, and the bidi
-- embedding/override/isolate controls U+202A-U+202E, U+2066-U+2069), and REJECT
-- (validation_failed:<field>) text that is empty once invisible characters are ignored
-- (Unicode space separators, zero-width characters, word joiner, BOM, soft hyphen, LRM/RLM,
-- braille blank, Hangul fillers, variation selectors, tag characters, ...). Invisible
-- characters next to visible text are kept: the zero-width joiner is part of emoji sequences.
--   Single line (titles): every whitespace run, Unicode space separators and line/paragraph
--     separators included, becomes one ASCII space; the result is trimmed.
--   Multi-line (bodies): CR LF / CR / U+2028 / U+2029 become LF, vertical tab and form feed
--     are removed, the result is trimmed of spaces, tabs and newlines.
create or replace function private.clean_required_text(
  p_text text,
  p_field text,
  p_max_length integer,
  p_multiline boolean
) returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text text;
begin
  v_text := regexp_replace(
    coalesce(p_text, ''),
    '[\x01-\x08\x0E-\x1F\x7F-\x9F‪-‮⁦-⁩]', '', 'g');
  if p_multiline then
    v_text := regexp_replace(v_text, '\r\n?|[  ]', E'\n', 'g');
    v_text := regexp_replace(v_text, '[\x0B\x0C]', '', 'g');
    v_text := btrim(v_text, E' \t\n');
  else
    v_text := btrim(regexp_replace(
      v_text, '[\s   -     　]+', ' ', 'g'));
  end if;
  if regexp_replace(
       v_text,
       '[\s ­͏ᅟᅠ ឴឵᠎ -‏  '
       '  -⁤⁪-⁯⠀　ㅤ︀-️﻿ﾠ'
       '\U000E0000-\U000E007F]',
       '', 'g') = ''
     or char_length(v_text) > p_max_length then
    raise exception using errcode = 'P0001', message = 'validation_failed:' || p_field;
  end if;
  return v_text;
end;
$$;

-- Q4-6: deep link allowlist ------------------------------------------------------------------------
-- Existing rows are tolerated: the constraint is added NOT VALID (enforced for every new or
-- updated row at once) and then validated; should an old row not match, validation is skipped
-- with a warning instead of failing the migration (every writer is a definer function that builds
-- these exact routes, so none is expected).
alter table public.notifications drop constraint notifications_deep_link_check;
alter table public.notifications
  add constraint notifications_deep_link_check
  check (
    deep_link ~ '^/activity$'
    or deep_link ~ '^/trainings/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or deep_link ~ '^/announcements/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) not valid;

do $$
begin
  alter table public.notifications validate constraint notifications_deep_link_check;
exception
  when check_violation then
    raise warning
      'TrainHive: notifications rows with a deep_link outside the allowlist exist; the new '
      'check applies to new rows only. Inspect them with: select id, deep_link from '
      'public.notifications where deep_link !~ ''^/(activity|trainings/[0-9a-f-]{36}|announcements/[0-9a-f-]{36})$'';';
end
$$;

-- O-1: announcement rate limit ------------------------------------------------------------------------

create index announcements_author_community_created_idx
  on public.announcements (author_id, community_id, created_at);

-- Same as M3-B1, plus: at most 10 announcements (any status) created by the caller in this
-- community within the last hour, else announcement_rate_limited. The organizer's membership is
-- now locked FOR NO KEY UPDATE (was FOR SHARE): it still makes a concurrent removal or demotion
-- wait, and it also serializes the caller's concurrent creations so the count is exact.
-- Service paths (publish_due_announcements) are not limited.
create or replace function public.create_announcement(
  p_community_id uuid,
  p_title text,
  p_body text,
  p_scheduled_for timestamptz default null
) returns public.announcements
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_title text;
  v_body text;
  v_now timestamptz;
  v_recent integer;
  v_row public.announcements;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  -- Also the answer for a community that does not exist, so ids cannot be probed.
  if p_community_id is null or not public.is_organizer(p_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  v_title := private.clean_required_text(p_title, 'title', 100, false);
  v_body := private.clean_required_text(p_body, 'body', 2000, true);

  -- Lock order profile -> membership (as before).
  perform 1 from public.profiles p where p.id = v_uid for key share;
  perform 1
  from public.memberships m
  where m.community_id = p_community_id
    and m.user_id = v_uid
    and m.status = 'active'
    and m.role = 'organizer'
  for no key update;
  if not found then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;

  v_now := clock_timestamp();
  -- Counted after the lock: a concurrent creation by the same organizer has committed.
  select count(*)::integer into v_recent
  from public.announcements a
  where a.author_id = v_uid
    and a.community_id = p_community_id
    and a.created_at > v_now - interval '1 hour';
  if v_recent >= 10 then
    raise exception using errcode = 'P0001', message = 'announcement_rate_limited';
  end if;

  if p_scheduled_for is not null
     and (p_scheduled_for <= v_now or p_scheduled_for > v_now + interval '365 days') then
    raise exception using errcode = 'P0001', message = 'validation_failed:scheduled_for';
  end if;

  insert into public.announcements (
    community_id, author_id, title, body, status, scheduled_for, published_at, created_at,
    updated_at
  ) values (
    p_community_id, v_uid, v_title, v_body,
    case when p_scheduled_for is null then 'published' else 'scheduled' end::public.announcement_status,
    p_scheduled_for,
    case when p_scheduled_for is null then v_now end,
    v_now, v_now
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- Q4-4: read state ------------------------------------------------------------------------------------

-- Same as M3-B1, plus: when the notification is an announcement_published one, the announcement
-- is marked read for the caller too (idempotent; the first read_at stands). Done on every call,
-- also when the notification was already read.
create or replace function public.mark_notification_read(p_id uuid) returns public.notifications
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.notifications;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  -- Lock order profile -> notifications, as in mark_announcement_read and an account deletion
  -- (profile, then its notifications at commit): the announcement_reads insert below key-shares
  -- the profile, and taking that lock only after the notification row locks would deadlock
  -- with a concurrent deletion of the account.
  perform 1 from public.profiles p where p.id = v_uid for key share;
  -- The caller's account was deleted concurrently (its profile is gone).
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  select n.* into v_row
  from public.notifications n
  where n.id = p_id
    and n.user_id = v_uid;
  -- Someone else's notification is indistinguishable from a missing one.
  if not found or not public.is_active_member(v_row.community_id) then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if v_row.read_at is null then
    update public.notifications n
    set read_at = now()
    where n.id = p_id
      and n.read_at is null
    returning * into v_row;
    if not found then
      -- A concurrent call marked it first.
      select n.* into v_row from public.notifications n where n.id = p_id;
    end if;
  end if;

  if v_row.related_announcement_id is not null then
    insert into public.announcement_reads (announcement_id, user_id)
    select a.id, v_uid
    from public.announcements a
    where a.id = v_row.related_announcement_id
      and a.community_id = v_row.community_id
      and a.status = 'published'
    on conflict (announcement_id, user_id) do nothing;
  end if;
  return v_row;
end;
$$;

-- Marks all of the caller's unread notifications of the community as read, and marks read (for
-- the caller) every published announcement of that community referenced by one of the
-- notifications THIS call marked (related_announcement_id). Announcements without such a
-- notification, other users' rows and other communities are untouched. Idempotent: a repeat
-- marks nothing and returns 0. Returns how many notifications changed.
create or replace function public.mark_all_notifications_read(p_community_id uuid) returns integer
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
  if p_community_id is null or not public.is_active_member(p_community_id) then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;
  -- Lock order profile -> notifications, as in mark_announcement_read and an account deletion
  -- (profile, then its notifications at commit): the announcement_reads insert below key-shares
  -- the profile, and taking that lock only after the notification row locks would deadlock
  -- with a concurrent deletion of the account.
  perform 1 from public.profiles p where p.id = v_uid for key share;
  -- The caller's account was deleted concurrently (its profile is gone).
  if not found then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;

  with marked as (
    update public.notifications n
    set read_at = now()
    where n.user_id = v_uid
      and n.community_id = p_community_id
      and n.read_at is null
    returning n.related_announcement_id
  ),
  reads as (
    insert into public.announcement_reads (announcement_id, user_id)
    select distinct a.id, v_uid
    from marked m
    join public.announcements a
      on a.id = m.related_announcement_id
     and a.community_id = p_community_id
     and a.status = 'published'
    order by a.id
    on conflict (announcement_id, user_id) do nothing
    returning 1
  )
  select count(*)::integer into v_count from marked;
  return v_count;
end;
$$;

-- O-3: badge source ----------------------------------------------------------------------------------
-- Same as M3-B1 except unread_count: only notifications of communities where the recipient is
-- still an active member (the ones the app can show).
create or replace function public.claim_notification_jobs(p_limit integer default 100, p_worker text default null)
returns setof jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_stale timestamptz := clock_timestamp() - interval '5 minutes';
  v_worker text := nullif(btrim(coalesce(p_worker, '')), '');
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception using errcode = 'P0001', message = 'validation_failed:limit';
  end if;
  if v_worker is null or char_length(v_worker) > 100 then
    raise exception using errcode = 'P0001', message = 'validation_failed:worker';
  end if;

  update public.notification_delivery_jobs j
  set status = 'dead',
      last_error = case when j.expires_at <= v_now then 'expired'
                        else coalesce(j.last_error, 'abandoned while sending') end,
      locked_at = null,
      locked_by = null
  where j.id in (
    select x.id
    from public.notification_delivery_jobs x
    where (x.status in ('pending', 'failed') and x.expires_at <= v_now)
       or (x.status = 'sending' and x.locked_at <= v_stale
           and (x.expires_at <= v_now or x.attempts >= x.max_attempts))
    for update skip locked
  );

  return query
  with picked as (
    select j.id
    from public.notification_delivery_jobs j
    where (
        (j.status in ('pending', 'failed') and j.next_attempt_at <= v_now)
        or (j.status = 'sending' and j.locked_at <= v_stale)
      )
      and j.attempts < j.max_attempts
      and j.expires_at > v_now
    order by j.next_attempt_at, j.id
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update public.notification_delivery_jobs j
    set status = 'sending',
        locked_at = v_now,
        locked_by = v_worker,
        attempts = j.attempts + 1
    from picked
    where j.id = picked.id
    returning j.*
  ),
  decided as (
    select c.*, n.kind, n.title, n.body, n.deep_link, n.community_id,
           n.related_session_id, n.related_announcement_id,
           case
             when not exists (
               select 1 from public.memberships m
               where m.community_id = n.community_id
                 and m.user_id = c.user_id
                 and m.status = 'active'
             ) then 'not_a_member'
             when not coalesce(pref.push_enabled, true) then 'push_disabled'
             when not case
                        when n.kind = 'training_reminder' then coalesce(pref.training_reminders, true)
                        when n.kind = 'announcement_published' then coalesce(pref.announcements, true)
                        else coalesce(pref.training_updates, true)
                      end then 'category_disabled'
             else null
           end as blocked_reason
    from claimed c
    join public.notifications n on n.id = c.notification_id
    left join public.notification_preferences pref on pref.user_id = c.user_id
  ),
  with_tokens as (
    select d.*,
           case
             when d.blocked_reason is null then coalesce(
               (select jsonb_agg(t.token order by t.last_seen_at desc, t.id)
                from public.device_push_tokens t
                where t.user_id = d.user_id
                  and t.invalidated_at is null),
               '[]'::jsonb)
             else '[]'::jsonb
           end as tokens
    from decided d
  )
  select jsonb_build_object(
    'job_id', w.id,
    'notification_id', w.notification_id,
    'user_id', w.user_id,
    'kind', w.kind,
    'title', w.title,
    'body', w.body,
    'deep_link', w.deep_link,
    'community_id', w.community_id,
    'related_session_id', w.related_session_id,
    'related_announcement_id', w.related_announcement_id,
    'attempts', w.attempts,
    'max_attempts', w.max_attempts,
    'unread_count', (
      select count(*)::integer
      from public.notifications u
      where u.user_id = w.user_id
        and u.read_at is null
        and exists (
          select 1 from public.memberships um
          where um.community_id = u.community_id
            and um.user_id = u.user_id
            and um.status = 'active'
        )
    ),
    'push_allowed', w.blocked_reason is null,
    'skip_reason', coalesce(w.blocked_reason, case when w.tokens = '[]'::jsonb then 'no_tokens' end),
    'tokens', w.tokens
  )
  from with_tokens w
  order by w.next_attempt_at, w.id;
end;
$$;

-- O-2: retention ----------------------------------------------------------------------------------------
-- Same as M3-B1, plus: in-app notifications that were read and are older than 90 days, or are
-- unread and older than 180 days (by created_at), are deleted; their push jobs go with them
-- (foreign key cascade). Idempotent. Returns the number of jobs and notifications deleted
-- (cascaded jobs not counted).
create or replace function public.purge_old_notification_data() returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_jobs integer;
  v_stale integer;
  v_orphans integer;
  v_old integer;
begin
  delete from public.notification_delivery_jobs j
  where j.status in ('sent', 'skipped', 'dead')
    and j.created_at < now() - interval '30 days';
  get diagnostics v_jobs = row_count;

  delete from public.notification_delivery_jobs j
  where j.status in ('pending', 'failed')
    and j.expires_at < now() - interval '3 days';
  get diagnostics v_stale = row_count;

  delete from public.notifications n
  where not exists (select 1 from public.profiles p where p.id = n.user_id);
  get diagnostics v_orphans = row_count;

  delete from public.notifications n
  where (n.read_at is not null and n.created_at < now() - interval '90 days')
     or (n.read_at is null and n.created_at < now() - interval '180 days');
  get diagnostics v_old = row_count;

  return v_jobs + v_stale + v_orphans + v_old;
end;
$$;

-- Grants (unchanged matrix, restated) -------------------------------------------------------------------

revoke all on function private.clean_required_text(text, text, integer, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.create_announcement(uuid, text, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.mark_notification_read(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.mark_all_notifications_read(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_notification_jobs(integer, text)
  from public, anon, authenticated, service_role;
revoke all on function public.purge_old_notification_data()
  from public, anon, authenticated, service_role;

grant execute on function public.create_announcement(uuid, text, text, timestamptz) to authenticated;
grant execute on function public.mark_notification_read(uuid) to authenticated;
grant execute on function public.mark_all_notifications_read(uuid) to authenticated;
grant execute on function public.claim_notification_jobs(integer, text) to service_role;
grant execute on function public.purge_old_notification_data() to service_role;
