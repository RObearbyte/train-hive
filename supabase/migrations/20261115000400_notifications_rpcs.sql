-- TrainHive M3-B1: announcements, read state, notification fan-out, reminders, push tokens,
-- preferences and the dispatcher RPCs used by the push Edge Function (M3-B2).
-- Contract: docs/API_CONTRACT.md ("Milestone 3").
--
-- Rules enforced here:
--   * Only active organizers create, edit and cancel announcements; edits and cancellation only
--     while `scheduled`. A scheduled announcement is published by publish_due_announcements()
--     (pg_cron, every minute) once scheduled_for has passed, exactly once (FOR UPDATE SKIP
--     LOCKED; an organizer's cancel and the publisher serialize on the announcement row).
--   * Every user-visible notification comes from private.enqueue_notification, which inserts
--     with ON CONFLICT (user_id, dedupe_key) DO NOTHING and creates the push job only for rows
--     it really inserted. Re-runs and races therefore never produce a second notification or a
--     second job for the same event.
--   * Training notifications are written by triggers on training_sessions, so they fire once
--     per real transition whichever path makes it (create_training, update_training,
--     cancel_training, finalize_due_sessions): a re-run that changes nothing fires nothing.
--     RSVP changes (going_count updates) never notify: the update trigger's WHEN clause ignores
--     them.
--   * Recipients are always active members of the session's / announcement's community at the
--     time of the event. The acting user (auth.uid(): the editing or cancelling organizer, the
--     author) is never notified of their own action.
--   * Lock order: the triggers run while the session (or announcement) row is locked and take
--     no lock on profiles or memberships (notifications have no foreign key to profiles, see
--     the schema migration), so they cannot deadlock with account deletion or member removal.
--   * Push preferences are applied by claim_notification_jobs at send time (the latest choice
--     wins); in-app notifications are always stored.

-- Internal helpers (schema private) -----------------------------------------------------------

-- Trims (multi-line) or trims and collapses whitespace (single line); raises
-- validation_failed:<field> when the result is blank or longer than p_max_length.
create function private.clean_required_text(
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
  if p_multiline then
    v_text := btrim(coalesce(p_text, ''), E' \t\n\r');
  else
    v_text := btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g'));
  end if;
  if v_text = '' or char_length(v_text) > p_max_length then
    raise exception using errcode = 'P0001', message = 'validation_failed:' || p_field;
  end if;
  return v_text;
end;
$$;

-- "Sat 21 Nov, 09:00" in the session's own time zone.
create function private.training_when(p_starts_at timestamptz, p_timezone text) returns text
language sql
stable
set search_path = ''
as $$
  select to_char(p_starts_at at time zone p_timezone, 'Dy DD Mon, HH24:MI');
$$;

-- When an undelivered push stops being worth sending: p_until (e.g. the training's end), but
-- never more than 3 days and never less than 15 minutes from now.
create function private.push_expiry(p_until timestamptz) returns timestamptz
language sql
stable
set search_path = ''
as $$
  select greatest(now() + interval '15 minutes', least(now() + interval '3 days', p_until));
$$;

-- The single writer of notifications and push jobs. Inserts one notification per distinct
-- recipient; a recipient who already has p_dedupe_key gets nothing new. A push job is created
-- only for notifications inserted by this call. Returns the number of notifications inserted.
create function private.enqueue_notification(
  p_user_ids uuid[],
  p_community_id uuid,
  p_kind public.notification_kind,
  p_title text,
  p_body text,
  p_deep_link text,
  p_session_id uuid,
  p_announcement_id uuid,
  p_dedupe_key text,
  p_expires_at timestamptz
) returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_count integer;
begin
  with inserted as (
    insert into public.notifications (
      user_id, community_id, kind, title, body, deep_link, related_session_id,
      related_announcement_id, dedupe_key
    )
    select u.user_id, p_community_id, p_kind, left(p_title, 200), left(p_body, 500), p_deep_link,
           p_session_id, p_announcement_id, p_dedupe_key
    from (select distinct x as user_id from unnest(p_user_ids) as x where x is not null) as u
    -- A stable insertion order: two writers of the same key always wait in the same order.
    order by u.user_id
    on conflict (user_id, dedupe_key) do nothing
    returning id, user_id
  )
  insert into public.notification_delivery_jobs (notification_id, user_id, expires_at)
  select i.id, i.user_id, p_expires_at
  from inserted i;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Active members of a community, minus p_exclude, optionally minus those whose RSVP for
-- p_session_id is `not_going`, optionally only those whose RSVP is `going` (plus p_include).
create function private.training_recipients(
  p_community_id uuid,
  p_session_id uuid,
  p_exclude uuid,
  p_going_only boolean,
  p_include uuid
) returns uuid[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(m.user_id order by m.user_id), '{}')
  from public.memberships m
  left join public.training_rsvps r
    on r.session_id = p_session_id
   and r.user_id = m.user_id
  where m.community_id = p_community_id
    and m.status = 'active'
    and m.user_id is distinct from p_exclude
    and (
      case
        when p_going_only then r.response = 'going' or m.user_id = p_include
        else r.response is distinct from 'not_going'
      end
    );
$$;

-- Training triggers -----------------------------------------------------------------------------

-- A new training: every active member except its organizer.
create function private.notify_training_created() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enqueue_notification(
    private.training_recipients(new.community_id, new.id, new.organizer_id, false, null),
    new.community_id,
    'training_created',
    'New training: ' || new.title,
    private.training_when(new.starts_at, new.timezone) || ' · ' || new.location_name,
    '/trainings/' || new.id,
    new.id,
    null,
    'training_created:' || new.id,
    private.push_expiry(coalesce(new.ends_at, new.starts_at + interval '2 hours'))
  );
  return null;
end;
$$;

-- Status transitions and material edits of a training.
--   confirmed: members with a going RSVP, plus the session's organizer.
--   cancelled (organizer or insufficient participation): every active member except those who
--     answered not_going, and except the cancelling user.
--   material edit (time, end, title, location, address, coordinates) of a scheduled or
--     confirmed session: every active member except not_going and except the editor.
--     Description, instructions, map link, activity type, limits: no notification.
create function private.notify_training_changed() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The acting user; null for the finalizer (pg_cron / service_role).
  v_actor uuid := auth.uid();
  v_link text := '/trainings/' || new.id;
  v_when text := private.training_when(new.starts_at, new.timezone);
  v_expires timestamptz :=
    private.push_expiry(coalesce(new.ends_at, new.starts_at + interval '2 hours'));
  v_time_changed boolean;
  v_place_changed boolean;
  v_title_changed boolean;
begin
  if new.status is distinct from old.status then
    if new.status = 'confirmed' then
      perform private.enqueue_notification(
        private.training_recipients(new.community_id, new.id, null, true, new.organizer_id),
        new.community_id,
        'training_confirmed',
        'Training confirmed: ' || new.title,
        v_when || ' · ' || new.location_name || '. See you there!',
        v_link, new.id, null,
        'training_confirmed:' || new.id,
        v_expires
      );
    elsif new.status = 'cancelled' then
      perform private.enqueue_notification(
        private.training_recipients(new.community_id, new.id, v_actor, false, null),
        new.community_id,
        'training_cancelled',
        'Training cancelled: ' || new.title,
        v_when || ' · ' || new.location_name || ' - '
          || case
               when new.cancel_reason = 'insufficient_participation'
                 then 'not enough participants.'
               else 'cancelled by the organizer.'
             end,
        v_link, new.id, null,
        'training_cancelled:' || new.id,
        v_expires
      );
    end if;
    return null;
  end if;

  if new.status not in ('scheduled', 'confirmed') then
    return null;
  end if;

  -- Instants compared at millisecond precision, as update_training does: a client re-sending
  -- the stored time cannot carry microseconds.
  v_time_changed :=
    date_trunc('milliseconds', new.starts_at) is distinct from date_trunc('milliseconds', old.starts_at)
    or date_trunc('milliseconds', new.ends_at) is distinct from date_trunc('milliseconds', old.ends_at);
  v_place_changed :=
    (new.location_name, new.address, new.latitude, new.longitude)
      is distinct from (old.location_name, old.address, old.latitude, old.longitude);
  v_title_changed := new.title is distinct from old.title;

  if v_time_changed or v_place_changed or v_title_changed then
    perform private.enqueue_notification(
      private.training_recipients(new.community_id, new.id, v_actor, false, null),
      new.community_id,
      'training_updated',
      'Training updated: ' || new.title,
      concat_ws(' ',
        case when v_time_changed then 'New time.' end,
        case when v_place_changed then 'New location.' end,
        case when v_title_changed then 'New title.' end,
        v_when || ' · ' || new.location_name),
      v_link, new.id, null,
      -- One key per edit: the transaction's start time in microseconds. Two different edits are
      -- two transactions (serialized on the session row), so both notify; repeating an edit
      -- changes nothing and fires nothing; several updates inside one transaction collapse.
      'training_updated:' || new.id || ':' || (extract(epoch from now()) * 1000000)::bigint,
      v_expires
    );
  end if;
  return null;
end;
$$;

create trigger training_sessions_notify_created
  after insert on public.training_sessions
  for each row
  execute function private.notify_training_created();

-- going_count updates (every RSVP) do not match this WHEN clause and never call the function.
create trigger training_sessions_notify_changed
  after update on public.training_sessions
  for each row
  when (
    old.status is distinct from new.status
    or old.starts_at is distinct from new.starts_at
    or old.ends_at is distinct from new.ends_at
    or old.title is distinct from new.title
    or old.location_name is distinct from new.location_name
    or old.address is distinct from new.address
    or old.latitude is distinct from new.latitude
    or old.longitude is distinct from new.longitude
  )
  execute function private.notify_training_changed();

-- Announcement trigger ----------------------------------------------------------------------------

-- Fires when an announcement becomes published (created as published, published by an
-- organizer's edit, or by publish_due_announcements). Recipients: every active member except
-- the author.
create function private.notify_announcement_published() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.status = 'published' then
    return null;
  end if;
  perform private.enqueue_notification(
    (select coalesce(array_agg(m.user_id order by m.user_id), '{}')
     from public.memberships m
     where m.community_id = new.community_id
       and m.status = 'active'
       and m.user_id is distinct from new.author_id),
    new.community_id,
    'announcement_published',
    new.title,
    left(regexp_replace(new.body, '\s+', ' ', 'g'), 200),
    '/announcements/' || new.id,
    null,
    new.id,
    'announcement:' || new.id,
    private.push_expiry(null)
  );
  return null;
end;
$$;

create trigger announcements_notify_published_insert
  after insert on public.announcements
  for each row
  when (new.status = 'published')
  execute function private.notify_announcement_published();

create trigger announcements_notify_published_update
  after update of status on public.announcements
  for each row
  when (new.status = 'published' and old.status <> 'published')
  execute function private.notify_announcement_published();

-- Account deletion --------------------------------------------------------------------------------
-- notifications has no foreign key to profiles (see the schema migration); this trigger gives the
-- same effect as ON DELETE CASCADE. Jobs follow through their foreign key to notifications.
-- A deferred constraint trigger: it runs when the deleting transaction commits, with a fresh
-- snapshot, so it also removes notifications that a concurrent fan-out (e.g. a cancel that was
-- holding the session row the deletion waited for) committed in the meantime. (An immediate
-- trigger fired from the auth.users cascade does not see them.) A fan-out still uncommitted at
-- that moment can leave a row behind; RLS never shows it, the dispatcher skips it (not_a_member)
-- and purge_old_notification_data() deletes it.

create function private.delete_notifications_of_profile() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.notifications n where n.user_id = old.id;
  return null;
end;
$$;

create constraint trigger profiles_delete_notifications
  after delete on public.profiles
  deferrable initially deferred
  for each row
  execute function private.delete_notifications_of_profile();

-- Announcements RPCs ------------------------------------------------------------------------------

-- p_scheduled_for null = publish now. Otherwise it must be in the future (at most one year).
create function public.create_announcement(
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

  -- Lock order profile -> membership: the author reference key-shares the profile anyway, and
  -- the share lock on the organizer's membership makes a concurrent removal or demotion wait,
  -- so the role checked here holds until commit.
  perform 1 from public.profiles p where p.id = v_uid for key share;
  perform 1
  from public.memberships m
  where m.community_id = p_community_id
    and m.user_id = v_uid
    and m.status = 'active'
    and m.role = 'organizer'
  for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;

  v_now := clock_timestamp();
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

-- Locks an announcement for an organizer's change. Raises not_found / forbidden.
create function private.lock_announcement_for_organizer(p_id uuid) returns public.announcements
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_community_id uuid;
  v_row public.announcements;
begin
  select a.community_id into v_community_id from public.announcements a where a.id = p_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  -- Authorize before taking the row lock, so only organizers can ever hold it.
  if not public.is_organizer(v_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  select a.* into v_row from public.announcements a where a.id = p_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  -- Re-checked after the lock wait: the caller may have been removed or demoted meanwhile.
  if not public.is_organizer(v_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  return v_row;
end;
$$;

-- Only while `scheduled`. Full replace of title, body and time; p_scheduled_for null publishes
-- the announcement now.
create function public.update_announcement(
  p_id uuid,
  p_title text,
  p_body text,
  p_scheduled_for timestamptz
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
  v_row public.announcements;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  v_row := private.lock_announcement_for_organizer(p_id);
  if v_row.status <> 'scheduled' then
    raise exception using errcode = 'P0001', message = 'announcement_not_editable';
  end if;
  v_title := private.clean_required_text(p_title, 'title', 100, false);
  v_body := private.clean_required_text(p_body, 'body', 2000, true);

  v_now := clock_timestamp();
  if p_scheduled_for is not null
     and (p_scheduled_for <= v_now or p_scheduled_for > v_now + interval '365 days') then
    raise exception using errcode = 'P0001', message = 'validation_failed:scheduled_for';
  end if;

  update public.announcements
  set title = v_title,
      body = v_body,
      status = case when p_scheduled_for is null then 'published' else 'scheduled' end::public.announcement_status,
      -- Publishing now keeps the last planned time for history.
      scheduled_for = coalesce(p_scheduled_for, scheduled_for),
      published_at = case when p_scheduled_for is null then v_now end,
      updated_at = v_now
  where id = p_id
  returning * into v_row;

  return v_row;
end;
$$;

-- Only while `scheduled`. Already cancelled: returned unchanged.
create function public.cancel_announcement(p_id uuid) returns public.announcements
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.announcements;
  v_now timestamptz;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  v_row := private.lock_announcement_for_organizer(p_id);
  if v_row.status = 'cancelled' then
    return v_row;
  end if;
  if v_row.status = 'published' then
    raise exception using errcode = 'P0001', message = 'announcement_not_cancellable';
  end if;
  v_now := clock_timestamp();
  update public.announcements
  set status = 'cancelled',
      cancelled_at = v_now,
      updated_at = v_now
  where id = p_id
  returning * into v_row;
  return v_row;
end;
$$;

-- service_role only; scheduled by pg_cron every minute. Publishes every scheduled announcement
-- whose time has come. SKIP LOCKED: a concurrent run, or an organizer editing or cancelling the
-- row right now, is skipped (the next run sees the outcome). The publication trigger fans out.
create function public.publish_due_announcements() returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with due as (
    select a.id
    from public.announcements a
    where a.status = 'scheduled'
      and a.scheduled_for <= clock_timestamp()
    order by a.scheduled_for, a.id
    for update skip locked
  )
  update public.announcements a
  set status = 'published',
      published_at = clock_timestamp(),
      updated_at = clock_timestamp()
  from due
  where a.id = due.id
    and a.status = 'scheduled';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Read state ----------------------------------------------------------------------------------------

-- Marks one published announcement as read for the caller (idempotent; the first read time
-- stands), and its in-app notification too.
create function public.mark_announcement_read(p_id uuid) returns public.announcement_reads
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_community_id uuid;
  v_row public.announcement_reads;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  select a.community_id into v_community_id
  from public.announcements a
  where a.id = p_id
    and a.status = 'published';
  -- Unknown, unpublished, or not the caller's community: indistinguishable.
  if not found or not public.is_active_member(v_community_id) then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  insert into public.announcement_reads (announcement_id, user_id)
  values (p_id, v_uid)
  on conflict (announcement_id, user_id) do nothing;

  update public.notifications n
  set read_at = now()
  where n.user_id = v_uid
    and n.dedupe_key = 'announcement:' || p_id
    and n.read_at is null;

  select r.* into v_row
  from public.announcement_reads r
  where r.announcement_id = p_id
    and r.user_id = v_uid;
  return v_row;
end;
$$;

-- Marks every published announcement of the community as read for the caller, and their in-app
-- notifications. Returns the number of announcements newly marked.
create function public.mark_announcements_read(p_community_id uuid) returns integer
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

  insert into public.announcement_reads (announcement_id, user_id)
  select a.id, v_uid
  from public.announcements a
  where a.community_id = p_community_id
    and a.status = 'published'
  order by a.id
  on conflict (announcement_id, user_id) do nothing;
  get diagnostics v_count = row_count;

  update public.notifications n
  set read_at = now()
  where n.user_id = v_uid
    and n.community_id = p_community_id
    and n.kind = 'announcement_published'
    and n.read_at is null;

  return v_count;
end;
$$;

-- Published announcements of the community the caller has not read and did not write.
create function public.unread_announcement_count(p_community_id uuid) returns integer
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
  if p_community_id is null or not public.is_active_member(p_community_id) then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;
  return (
    select count(*)::integer
    from public.announcements a
    where a.community_id = p_community_id
      and a.status = 'published'
      and a.author_id is distinct from v_uid
      and not exists (
        select 1
        from public.announcement_reads r
        where r.announcement_id = a.id
          and r.user_id = v_uid
      )
  );
end;
$$;

-- Marks one of the caller's notifications as read (idempotent; the first read time stands).
create function public.mark_notification_read(p_id uuid) returns public.notifications
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
  return v_row;
end;
$$;

-- Marks all of the caller's notifications of the community as read. Returns how many changed.
create function public.mark_all_notifications_read(p_community_id uuid) returns integer
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
  update public.notifications n
  set read_at = now()
  where n.user_id = v_uid
    and n.community_id = p_community_id
    and n.read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Reminders ---------------------------------------------------------------------------------------

-- service_role only; scheduled by pg_cron every minute. Two reminders per training, to active
-- members with a going RSVP:
--   24h: the session starts in (23h, 24h] and is scheduled or confirmed ("Tomorrow: ...").
--   2h:  the session starts in (1h, 2h] and is confirmed ("Starting soon: ..."). Skipped for a
--        member who received this session's confirmation within the last hour (with the default
--        deadline, start - 2h, the confirmation arrives at the start of this window).
-- Each window is an hour wide, so a missed cron run still sends the reminder once. The dedupe
-- key includes the start time (epoch seconds): a rescheduled session gets fresh reminders, a
-- re-run inside the same window gets nothing new. Sessions locked by an edit right now are
-- skipped and picked up by the next run (FOR NO KEY UPDATE SKIP LOCKED also keeps concurrent
-- runs off each other's sessions). Returns the number of notifications inserted.
create function public.enqueue_due_training_reminders() returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_session record;
  v_key text;
  v_total integer := 0;
begin
  for v_session in
    select s.id, s.community_id, s.title, s.starts_at, s.ends_at, s.timezone, s.location_name,
           w.label
    from public.training_sessions s
    cross join (values ('24h', interval '23 hours', interval '24 hours'),
                       ('2h', interval '1 hour', interval '2 hours')) as w (label, lo, hi)
    where s.starts_at > v_now + w.lo
      and s.starts_at <= v_now + w.hi
      and (s.status = 'confirmed' or (w.label = '24h' and s.status = 'scheduled'))
    order by s.id
    for no key update of s skip locked
  loop
    v_key := 'training_reminder_' || v_session.label || ':' || v_session.id || ':'
             || floor(extract(epoch from v_session.starts_at))::bigint;
    v_total := v_total + private.enqueue_notification(
      (select coalesce(array_agg(m.user_id order by m.user_id), '{}')
       from public.memberships m
       join public.training_rsvps r
         on r.session_id = v_session.id
        and r.user_id = m.user_id
        and r.response = 'going'
       where m.community_id = v_session.community_id
         and m.status = 'active'
         and not exists (
           select 1 from public.notifications n
           where n.user_id = m.user_id and n.dedupe_key = v_key
         )
         and (
           v_session.label = '24h'
           or not exists (
             select 1 from public.notifications n
             where n.user_id = m.user_id
               and n.dedupe_key = 'training_confirmed:' || v_session.id
               and n.created_at > v_now - interval '1 hour'
           )
         )),
      v_session.community_id,
      'training_reminder',
      case when v_session.label = '24h' then 'Tomorrow: ' else 'Starting soon: ' end
        || v_session.title,
      private.training_when(v_session.starts_at, v_session.timezone) || ' · '
        || v_session.location_name,
      '/trainings/' || v_session.id,
      v_session.id,
      null,
      v_key,
      private.push_expiry(v_session.starts_at)
    );
  end loop;
  return v_total;
end;
$$;

-- Push tokens -------------------------------------------------------------------------------------

-- Registers (or refreshes) the caller's Expo push token. Upsert by token. A token registered by
-- another user is re-assigned to the caller: an Expo token identifies one app installation, and
-- the account now signed in on that installation is the one that must receive its pushes (the
-- previous account signed out, or its anonymous session was replaced). Clears a previous
-- invalidation. A user keeps at most 10 tokens; the least recently seen ones beyond that are
-- removed.
create function public.register_push_token(
  p_token text,
  p_platform text,
  p_device_label text default null
) returns public.device_push_tokens
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_token text := btrim(coalesce(p_token, ''));
  v_platform text := lower(btrim(coalesce(p_platform, '')));
  v_label text := nullif(btrim(regexp_replace(coalesce(p_device_label, ''), '\s+', ' ', 'g')), '');
  v_now timestamptz;
  v_row public.device_push_tokens;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if char_length(v_token) > 200
     or v_token !~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_:.-]+\]$' then
    raise exception using errcode = 'P0001', message = 'validation_failed:token';
  end if;
  if v_platform not in ('ios', 'android', 'web') then
    raise exception using errcode = 'P0001', message = 'validation_failed:platform';
  end if;
  if char_length(v_label) > 80 then
    raise exception using errcode = 'P0001', message = 'validation_failed:device_label';
  end if;

  -- Serializes the caller's registrations (the 10-token cap). Profile first, then token rows:
  -- the order of an account deletion.
  perform 1 from public.profiles p where p.id = v_uid for no key update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;
  v_now := clock_timestamp();

  insert into public.device_push_tokens (user_id, token, platform, device_label, created_at, last_seen_at)
  values (v_uid, v_token, v_platform, v_label, v_now, v_now)
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        device_label = excluded.device_label,
        created_at = case
          when public.device_push_tokens.user_id = excluded.user_id
            then public.device_push_tokens.created_at
          else excluded.created_at
        end,
        last_seen_at = excluded.last_seen_at,
        invalidated_at = null,
        last_error = null
  returning * into v_row;

  delete from public.device_push_tokens t
  where t.user_id = v_uid
    and t.id not in (
      select k.id
      from public.device_push_tokens k
      where k.user_id = v_uid
      order by k.last_seen_at desc, k.id
      limit 10
    );

  return v_row;
end;
$$;

-- Removes the caller's token (sign-out, push turned off on the device). Idempotent; someone
-- else's token is left alone. Returns whether a row was removed.
create function public.unregister_push_token(p_token text) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  delete from public.device_push_tokens t
  where t.token = btrim(coalesce(p_token, ''))
    and t.user_id = v_uid;
  return found;
end;
$$;

-- Preferences -------------------------------------------------------------------------------------

-- The caller's push preferences; all defaults (everything on) when never set.
create function public.get_notification_preferences() returns public.notification_preferences
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.notification_preferences;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  select p.* into v_row from public.notification_preferences p where p.user_id = v_uid;
  if not found then
    v_row.user_id := v_uid;
    v_row.push_enabled := true;
    v_row.training_reminders := true;
    v_row.announcements := true;
    v_row.training_updates := true;
    v_row.updated_at := null;
  end if;
  return v_row;
end;
$$;

-- Sets the given preferences; a null argument keeps the current value.
create function public.set_notification_preferences(
  p_push_enabled boolean default null,
  p_training_reminders boolean default null,
  p_announcements boolean default null,
  p_training_updates boolean default null
) returns public.notification_preferences
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.notification_preferences;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  perform 1 from public.profiles p where p.id = v_uid for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;
  insert into public.notification_preferences (
    user_id, push_enabled, training_reminders, announcements, training_updates, updated_at
  ) values (
    v_uid,
    coalesce(p_push_enabled, true),
    coalesce(p_training_reminders, true),
    coalesce(p_announcements, true),
    coalesce(p_training_updates, true),
    now()
  )
  on conflict (user_id) do update
    set push_enabled = coalesce(p_push_enabled, public.notification_preferences.push_enabled),
        training_reminders = coalesce(p_training_reminders, public.notification_preferences.training_reminders),
        announcements = coalesce(p_announcements, public.notification_preferences.announcements),
        training_updates = coalesce(p_training_updates, public.notification_preferences.training_updates),
        updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;

-- Dispatcher RPCs (service_role only; used by the push Edge Function, M3-B2) --------------------

-- Claims up to p_limit jobs for p_worker and returns one jsonb per claimed job:
--   { job_id, notification_id, user_id, kind, title, body, deep_link, community_id,
--     related_session_id, related_announcement_id, attempts, max_attempts, unread_count,
--     push_allowed, skip_reason, tokens: [text] }
-- Claimable: pending, or failed with next_attempt_at due, or sending for more than 5 minutes
-- (a worker that died). Claiming sets sending / locked_at / locked_by and counts an attempt.
-- Before claiming, jobs past expires_at, and abandoned sending jobs that already used every
-- attempt, become dead. FOR UPDATE SKIP LOCKED: concurrent workers never claim the same job.
-- tokens holds the recipient's valid (never invalidated) tokens, most recently seen first, and
-- is empty when push is not allowed: skip_reason then says why (not_a_member, push_disabled,
-- category_disabled) or is no_tokens when push is allowed but no device is registered. The
-- worker completes such jobs as `skipped`.
create function public.claim_notification_jobs(p_limit integer default 100, p_worker text default null)
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
    ),
    'push_allowed', w.blocked_reason is null,
    'skip_reason', coalesce(w.blocked_reason, case when w.tokens = '[]'::jsonb then 'no_tokens' end),
    'tokens', w.tokens
  )
  from with_tokens w
  order by w.next_attempt_at, w.id;
end;
$$;

-- Records the outcome of a claimed job. p_status:
--   sent     delivered to at least one device (Expo accepted it)
--   skipped  nothing to send (skip_reason from the claim)
--   failed   transient failure: retried after p_retry_in_seconds, or by default after
--            30 s * 2^(attempts - 1), at most 1 hour; dead once attempts reach max_attempts
--   dead     permanent failure, never retried
-- Only a job in `sending` changes; any other state (already completed, or never claimed) is
-- returned unchanged with changed = false, so repeating a completion is harmless.
-- Returns { job_id, status, attempts, max_attempts, next_attempt_at, sent_at, changed }.
create function public.complete_notification_job(
  p_job_id uuid,
  p_status text,
  p_error text default null,
  p_retry_in_seconds integer default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job public.notification_delivery_jobs;
  v_now timestamptz;
  v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 1000);
  v_changed boolean := false;
begin
  if p_status is null or p_status not in ('sent', 'skipped', 'failed', 'dead') then
    raise exception using errcode = 'P0001', message = 'validation_failed:status';
  end if;
  if p_retry_in_seconds is not null and p_retry_in_seconds not between 0 and 86400 then
    raise exception using errcode = 'P0001', message = 'validation_failed:retry_in_seconds';
  end if;

  select j.* into v_job
  from public.notification_delivery_jobs j
  where j.id = p_job_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  if v_job.status = 'sending' then
    v_now := clock_timestamp();
    update public.notification_delivery_jobs j
    set status = case
          when p_status = 'failed' and j.attempts >= j.max_attempts then 'dead'
          else p_status
        end,
        sent_at = case when p_status = 'sent' then v_now end,
        next_attempt_at = case
          when p_status = 'failed' then v_now + make_interval(
            secs => coalesce(p_retry_in_seconds, least(3600, 30 * power(2, j.attempts - 1)))
          )
          else j.next_attempt_at
        end,
        last_error = v_error,
        locked_at = null,
        locked_by = null
    where j.id = p_job_id
    returning j.* into v_job;
    v_changed := true;
  end if;

  return jsonb_build_object(
    'job_id', v_job.id,
    'status', v_job.status,
    'attempts', v_job.attempts,
    'max_attempts', v_job.max_attempts,
    'next_attempt_at', v_job.next_attempt_at,
    'sent_at', v_job.sent_at,
    'changed', v_changed
  );
end;
$$;

-- Marks tokens as invalid (Expo DeviceNotRegistered). Invalid tokens are never returned by
-- claim_notification_jobs again, until the device registers the token again. Returns the number
-- of tokens newly invalidated.
create function public.invalidate_push_tokens(p_tokens text[], p_error text default null)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.device_push_tokens t
  set invalidated_at = clock_timestamp(),
      last_error = left(coalesce(nullif(btrim(coalesce(p_error, '')), ''), 'DeviceNotRegistered'), 500)
  where t.token = any (coalesce(p_tokens, '{}'))
    and t.invalidated_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- service_role only; scheduled daily. Deletes:
--   * sent / skipped / dead jobs created more than 30 days ago,
--   * pending / failed jobs that expired more than 3 days ago (never claimed: no dispatcher ran),
--   * notifications whose user no longer has a profile (a notification inserted while that
--     account was being deleted).
-- Notifications themselves (the in-app history) are kept. Returns the number of rows deleted.
create function public.purge_old_notification_data() returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_jobs integer;
  v_stale integer;
  v_orphans integer;
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

  return v_jobs + v_stale + v_orphans;
end;
$$;

-- Grants ------------------------------------------------------------------------------------------

revoke all on all functions in schema private from public;
revoke all on function private.clean_required_text(text, text, integer, boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.training_when(timestamptz, text)
  from public, anon, authenticated, service_role;
revoke all on function private.push_expiry(timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.enqueue_notification(
  uuid[], uuid, public.notification_kind, text, text, text, uuid, uuid, text, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function private.training_recipients(uuid, uuid, uuid, boolean, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.notify_training_created()
  from public, anon, authenticated, service_role;
revoke all on function private.notify_training_changed()
  from public, anon, authenticated, service_role;
revoke all on function private.notify_announcement_published()
  from public, anon, authenticated, service_role;
revoke all on function private.delete_notifications_of_profile()
  from public, anon, authenticated, service_role;
revoke all on function private.lock_announcement_for_organizer(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.create_announcement(uuid, text, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.update_announcement(uuid, text, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.cancel_announcement(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.publish_due_announcements()
  from public, anon, authenticated, service_role;
revoke all on function public.mark_announcement_read(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.mark_announcements_read(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.unread_announcement_count(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.mark_notification_read(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.mark_all_notifications_read(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.enqueue_due_training_reminders()
  from public, anon, authenticated, service_role;
revoke all on function public.register_push_token(text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.unregister_push_token(text)
  from public, anon, authenticated, service_role;
revoke all on function public.get_notification_preferences()
  from public, anon, authenticated, service_role;
revoke all on function public.set_notification_preferences(boolean, boolean, boolean, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_notification_jobs(integer, text)
  from public, anon, authenticated, service_role;
revoke all on function public.complete_notification_job(uuid, text, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.invalidate_push_tokens(text[], text)
  from public, anon, authenticated, service_role;
revoke all on function public.purge_old_notification_data()
  from public, anon, authenticated, service_role;

grant execute on function public.create_announcement(uuid, text, text, timestamptz) to authenticated;
grant execute on function public.update_announcement(uuid, text, text, timestamptz) to authenticated;
grant execute on function public.cancel_announcement(uuid) to authenticated;
grant execute on function public.mark_announcement_read(uuid) to authenticated;
grant execute on function public.mark_announcements_read(uuid) to authenticated;
grant execute on function public.unread_announcement_count(uuid) to authenticated;
grant execute on function public.mark_notification_read(uuid) to authenticated;
grant execute on function public.mark_all_notifications_read(uuid) to authenticated;
grant execute on function public.register_push_token(text, text, text) to authenticated;
grant execute on function public.unregister_push_token(text) to authenticated;
grant execute on function public.get_notification_preferences() to authenticated;
grant execute on function public.set_notification_preferences(boolean, boolean, boolean, boolean)
  to authenticated;

grant execute on function public.publish_due_announcements() to service_role;
grant execute on function public.enqueue_due_training_reminders() to service_role;
grant execute on function public.claim_notification_jobs(integer, text) to service_role;
grant execute on function public.complete_notification_job(uuid, text, text, integer) to service_role;
grant execute on function public.invalidate_push_tokens(text[], text) to service_role;
grant execute on function public.purge_old_notification_data() to service_role;
