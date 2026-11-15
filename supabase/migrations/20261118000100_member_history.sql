-- M4-B2: an organizer reads the attendance history of one member (QA defect Q5-4).
--
-- Same payload and keyset pagination as get_my_attendance_history: both call
-- private.stats_history_payload. Check order: authentication, authorization, input. The member
-- may be removed (their past stays readable); a user without any membership in this community
-- is not_found.

create function public.get_member_attendance_history(
  p_community_id uuid,
  p_user_id uuid,
  p_window text,
  p_limit integer default 50,
  p_before timestamptz default null
) returns jsonb
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
  if p_community_id is null or not public.is_organizer(p_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  if p_user_id is null or not exists (
    select 1
    from public.memberships m
    where m.community_id = p_community_id
      and m.user_id = p_user_id
  ) then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  return private.stats_history_payload(p_community_id, p_user_id, p_window, p_limit, p_before, now());
end;
$$;

revoke all on function public.get_member_attendance_history(uuid, uuid, text, integer, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.get_member_attendance_history(uuid, uuid, text, integer, timestamptz)
  to authenticated;
