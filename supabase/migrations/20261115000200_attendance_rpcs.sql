-- TrainHive M2-B1: attendance RPCs. Contract: docs/API_CONTRACT.md ("Milestone 2").
--
-- Rules enforced here:
--   * Only an active organizer of the session's community takes attendance.
--   * Attendance is taken on a `confirmed` session once it has ended (ends_at, or starts_at
--     when there is no end), by the real server time after any lock wait (clock_timestamp()).
--     A `completed` session (attendance finalized) still accepts corrections. `scheduled` and
--     `cancelled` sessions never take attendance.
--   * Nothing completes a session automatically: a confirmed session that has ended stays
--     `confirmed` until an organizer calls finalize_attendance.
--   * New records only for active members. A removed member's existing records and audit rows
--     stay (history) and can still be corrected.
--   * Every real status change writes exactly one audit row; repeating the current status
--     changes nothing and writes nothing. A missing record counts as `unrecorded`.
--   * All writers of a session's attendance serialize on the session row (FOR UPDATE). Lock
--     order is the Milestone 1 order: profile rows -> membership row -> session row, so user
--     deletion (profile, then memberships, then the session through the RSVP trigger) and
--     member removal cannot deadlock with these functions.

-- Internal helpers (schema private) -----------------------------------------------------------

-- Returns the session's community, or raises not_found / forbidden. Read without a lock:
-- community_id never changes, and only organizers get as far as locking anything.
create function private.authorize_attendance(p_session_id uuid) returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_community_id uuid;
begin
  select s.community_id into v_community_id
  from public.training_sessions s
  where s.id = p_session_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if not public.is_organizer(v_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  return v_community_id;
end;
$$;

-- Takes the profile and membership locks that precede the session lock, and returns the
-- attendee's membership status in the community (null when they have no membership).
-- Key-share on both profiles: the attendance row and the audit row reference them, and a
-- concurrent account deletion must wait for this transaction instead of deadlocking with it.
-- Share on the attendee's membership: a concurrent removal waits, so the status returned here
-- holds until commit.
create function private.lock_attendance_people(
  p_caller_id uuid,
  p_attendee_id uuid,
  p_community_id uuid
) returns public.membership_status
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_status public.membership_status;
begin
  perform 1
  from public.profiles p
  where p.id in (p_caller_id, p_attendee_id)
  order by p.id
  for key share;

  select m.status into v_status
  from public.memberships m
  where m.community_id = p_community_id
    and m.user_id = p_attendee_id
  for share;

  return v_status;
end;
$$;

-- Locks the session row and checks that it can take attendance (or a correction) now.
create function private.lock_session_for_attendance(p_session_id uuid)
returns public.training_sessions
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_session public.training_sessions;
begin
  select s.* into v_session
  from public.training_sessions s
  where s.id = p_session_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if v_session.status not in ('confirmed', 'completed') then
    raise exception using errcode = 'P0001', message = 'session_not_confirmed';
  end if;
  -- clock_timestamp(): the real time after the lock wait, not the transaction start.
  if coalesce(v_session.ends_at, v_session.starts_at) > clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'session_not_ended';
  end if;
  return v_session;
end;
$$;

-- Optional free-text reason of a change: trimmed, blank becomes null, at most 200 characters.
create function private.clean_attendance_reason(p_reason text) returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, ''), E' \t\n\r'), '');
begin
  if v_reason is not null and char_length(v_reason) > 200 then
    raise exception using errcode = 'P0001', message = 'validation_failed:reason';
  end if;
  return v_reason;
end;
$$;

-- record_attendance --------------------------------------------------------------------------

create function public.record_attendance(
  p_session_id uuid,
  p_user_id uuid,
  p_status public.attendance_status,
  p_reason text default null
) returns public.attendance_records
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_community_id uuid;
  v_member_status public.membership_status;
  v_session public.training_sessions;
  v_record public.attendance_records;
  v_old public.attendance_status;
  v_reason text;
  v_now timestamptz;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if p_user_id is null then
    raise exception using errcode = 'P0001', message = 'validation_failed:user_id';
  end if;
  if p_status is null then
    raise exception using errcode = 'P0001', message = 'validation_failed:status';
  end if;
  v_reason := private.clean_attendance_reason(p_reason);

  v_community_id := private.authorize_attendance(p_session_id);
  v_member_status := private.lock_attendance_people(v_uid, p_user_id, v_community_id);
  v_session := private.lock_session_for_attendance(p_session_id);
  v_now := clock_timestamp();

  -- No row lock needed: every writer of this session's attendance holds the session lock.
  select a.* into v_record
  from public.attendance_records a
  where a.session_id = p_session_id
    and a.user_id = p_user_id;

  if found then
    v_old := v_record.status;
    if v_old = p_status then
      return v_record;
    end if;
    update public.attendance_records
    set status = p_status,
        updated_at = v_now
    where id = v_record.id
    returning * into v_record;
  else
    -- A removed member keeps their history but gets no new record.
    if v_member_status is distinct from 'active' then
      raise exception using errcode = 'P0001', message = 'attendee_not_a_member';
    end if;
    -- Members without a going RSVP are added with add_walk_in_attendee.
    if not exists (
      select 1
      from public.training_rsvps r
      where r.session_id = p_session_id
        and r.user_id = p_user_id
        and r.response = 'going'
    ) then
      raise exception using errcode = 'P0001', message = 'no_going_rsvp';
    end if;

    insert into public.attendance_records (
      session_id, community_id, user_id, status, recorded_by, recorded_at, updated_at,
      had_rsvp_going, is_walk_in
    ) values (
      p_session_id, v_community_id, p_user_id, p_status, v_uid, v_now, v_now, true, false
    )
    returning * into v_record;
    v_old := 'unrecorded';
  end if;

  -- Creating an `unrecorded` row is not a change (a missing record already means unrecorded).
  if v_old <> p_status then
    insert into public.attendance_audit_log (
      session_id, community_id, user_id, changed_by, changed_at, old_status, new_status,
      reason, action
    ) values (
      p_session_id, v_community_id, p_user_id, v_uid, v_now, v_old, p_status, v_reason,
      case
        -- The first mark of a member before finalization is a `record`; anything after it,
        -- and anything once the session is completed, is a `correct`.
        when v_session.status = 'confirmed'
             and not exists (
               select 1
               from public.attendance_audit_log l
               where l.session_id = p_session_id
                 and l.user_id = p_user_id
             )
          then 'record'
        else 'correct'
      end
    );
  end if;

  return v_record;
end;
$$;

-- add_walk_in_attendee -----------------------------------------------------------------------

create function public.add_walk_in_attendee(p_session_id uuid, p_user_id uuid)
returns public.attendance_records
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_community_id uuid;
  v_member_status public.membership_status;
  v_record public.attendance_records;
  v_now timestamptz;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if p_user_id is null then
    raise exception using errcode = 'P0001', message = 'validation_failed:user_id';
  end if;

  v_community_id := private.authorize_attendance(p_session_id);
  v_member_status := private.lock_attendance_people(v_uid, p_user_id, v_community_id);
  perform private.lock_session_for_attendance(p_session_id);
  v_now := clock_timestamp();

  select a.* into v_record
  from public.attendance_records a
  where a.session_id = p_session_id
    and a.user_id = p_user_id;
  if found then
    -- Idempotent: an existing record (walk-in or not) is returned unchanged.
    return v_record;
  end if;

  if v_member_status is distinct from 'active' then
    raise exception using errcode = 'P0001', message = 'attendee_not_a_member';
  end if;
  -- A member who RSVP'd going is not a walk-in: they are marked with record_attendance.
  if exists (
    select 1
    from public.training_rsvps r
    where r.session_id = p_session_id
      and r.user_id = p_user_id
      and r.response = 'going'
  ) then
    raise exception using errcode = 'P0001', message = 'attendee_has_going_rsvp';
  end if;

  insert into public.attendance_records (
    session_id, community_id, user_id, status, recorded_by, recorded_at, updated_at,
    had_rsvp_going, is_walk_in
  ) values (
    p_session_id, v_community_id, p_user_id, 'present', v_uid, v_now, v_now, false, true
  )
  returning * into v_record;

  insert into public.attendance_audit_log (
    session_id, community_id, user_id, changed_by, changed_at, old_status, new_status, action
  ) values (
    p_session_id, v_community_id, p_user_id, v_uid, v_now, 'unrecorded', 'present', 'walk_in_add'
  );

  return v_record;
end;
$$;

-- finalize_attendance ------------------------------------------------------------------------

create function public.finalize_attendance(p_session_id uuid) returns public.training_sessions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_community_id uuid;
  v_session public.training_sessions;
  v_now timestamptz;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;

  v_community_id := private.authorize_attendance(p_session_id);

  -- Profiles first (lock order): the finalizing organizer, and everyone who may get an
  -- `unrecorded` row below. On a confirmed session the set of going RSVPs no longer grows.
  perform 1
  from public.profiles p
  where p.id = v_uid
     or p.id in (
       select r.user_id
       from public.training_rsvps r
       where r.session_id = p_session_id
         and r.response = 'going'
     )
  order by p.id
  for key share;

  select s.* into v_session
  from public.training_sessions s
  where s.id = p_session_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  if v_session.status = 'completed' then
    -- Idempotent: the first finalization stands.
    return v_session;
  end if;
  if v_session.status <> 'confirmed' then
    raise exception using errcode = 'P0001', message = 'session_not_confirmed';
  end if;
  v_now := clock_timestamp();
  if coalesce(v_session.ends_at, v_session.starts_at) > v_now then
    raise exception using errcode = 'P0001', message = 'session_not_ended';
  end if;

  -- Every active member who RSVP'd going appears in the attendance list. Their missing marks
  -- stay `unrecorded`: finalization never turns "not recorded" into "absent". No audit rows:
  -- an `unrecorded` row is not a change.
  insert into public.attendance_records (
    session_id, community_id, user_id, status, recorded_by, recorded_at, updated_at,
    had_rsvp_going, is_walk_in
  )
  select p_session_id, v_community_id, r.user_id, 'unrecorded', v_uid, v_now, v_now, true, false
  from public.training_rsvps r
  join public.memberships m
    on m.community_id = r.community_id
   and m.user_id = r.user_id
   and m.status = 'active'
  where r.session_id = p_session_id
    and r.response = 'going'
  on conflict (session_id, user_id) do nothing;

  update public.training_sessions
  set status = 'completed',
      attendance_finalized_at = v_now,
      attendance_finalized_by = v_uid,
      updated_at = now()
  where id = p_session_id
  returning * into v_session;

  return v_session;
end;
$$;

-- get_attendance_sheet -----------------------------------------------------------------------
-- The organizer screen in one round trip: every active member with a going RSVP, plus everyone
-- with an attendance record (including removed members, whose history stays correctable).

create function public.get_attendance_sheet(p_session_id uuid) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_community_id uuid;
  v_session public.training_sessions;
  v_entries jsonb;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;

  v_community_id := private.authorize_attendance(p_session_id);

  select s.* into v_session
  from public.training_sessions s
  where s.id = p_session_id;

  with people as (
    select r.user_id
    from public.training_rsvps r
    join public.memberships m
      on m.community_id = r.community_id
     and m.user_id = r.user_id
     and m.status = 'active'
    where r.session_id = p_session_id
      and r.response = 'going'
    union
    select a.user_id
    from public.attendance_records a
    where a.session_id = p_session_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'user_id', x.user_id,
        'display_name', p.display_name,
        'membership_status', m.status,
        'rsvp_response', coalesce(r.response, 'no_response'),
        'attendance_status', coalesce(a.status, 'unrecorded'),
        'has_record', a.id is not null,
        'is_walk_in', coalesce(a.is_walk_in, false),
        'had_rsvp_going', a.had_rsvp_going,
        'updated_at', a.updated_at
      )
      order by p.display_name, x.user_id
    ),
    '[]'::jsonb
  ) into v_entries
  from people x
  join public.profiles p on p.id = x.user_id
  left join public.memberships m
    on m.community_id = v_community_id
   and m.user_id = x.user_id
  left join public.training_rsvps r
    on r.session_id = p_session_id
   and r.user_id = x.user_id
  left join public.attendance_records a
    on a.session_id = p_session_id
   and a.user_id = x.user_id;

  return jsonb_build_object(
    'session_id', v_session.id,
    'status', v_session.status,
    'ended', coalesce(v_session.ends_at, v_session.starts_at) <= now(),
    'attendance_finalized_at', v_session.attendance_finalized_at,
    'attendance_finalized_by', v_session.attendance_finalized_by,
    'entries', v_entries
  );
end;
$$;

-- Grants -------------------------------------------------------------------------------------

revoke all on function private.authorize_attendance(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.lock_attendance_people(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.lock_session_for_attendance(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.clean_attendance_reason(text)
  from public, anon, authenticated, service_role;

revoke all on function public.record_attendance(uuid, uuid, public.attendance_status, text)
  from public, anon, authenticated, service_role;
revoke all on function public.add_walk_in_attendee(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.finalize_attendance(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_attendance_sheet(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.record_attendance(uuid, uuid, public.attendance_status, text)
  to authenticated;
grant execute on function public.add_walk_in_attendee(uuid, uuid) to authenticated;
grant execute on function public.finalize_attendance(uuid) to authenticated;
grant execute on function public.get_attendance_sheet(uuid) to authenticated;
