-- TrainHive M4-B1 (small fix): mark_announcement_read and mark_announcements_read now
-- key-share-lock the caller's profile first, like mark_notification_read and
-- mark_all_notifications_read (20261116000100).
--
-- Before: both inserted into announcement_reads (FK -> profiles) without that lock. An account
-- deletion that had already deleted the profile but not yet committed made the FK check wait,
-- then fail with a foreign key violation (23503) instead of a contract error. Now the call waits
-- on the profile lock up front; if the deletion commits, the profile is gone and the call raises
-- not_found (single) / not_a_member (all), the same answers as the notification siblings. The
-- lock order (profile, then announcement_reads, then notifications) is the order of an account
-- deletion, so this cannot deadlock with it.
-- Same signatures, behaviour and grants otherwise.

create or replace function public.mark_announcement_read(p_id uuid) returns public.announcement_reads
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
  perform 1 from public.profiles p where p.id = v_uid for key share;
  -- The caller's account was deleted concurrently (its profile is gone).
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
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

create or replace function public.mark_announcements_read(p_community_id uuid) returns integer
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
  perform 1 from public.profiles p where p.id = v_uid for key share;
  -- The caller's account was deleted concurrently (its profile is gone).
  if not found then
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

-- `create or replace` keeps the privileges; restated so this file is explicit.
revoke all on function public.mark_announcement_read(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.mark_announcements_read(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.mark_announcement_read(uuid) to authenticated;
grant execute on function public.mark_announcements_read(uuid) to authenticated;
