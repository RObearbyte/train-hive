-- Cancellation reason for events.
--   * training_sessions.cancellation_reason: free text (1..300 chars), only on a cancelled event.
--     An organizer may pass one to cancel_training; the deadline finalizer stores a pre-filled
--     'Not enough participants: N of M needed.' when it cancels for lack of attendance.
--     (The existing enum column cancel_reason says WHO/WHY in machine terms; this is the note.)
--   * cancel_training gains p_reason (the old one-argument function is dropped, so the
--     signature set stays one function per name).
--   * The cancellation notification includes the reason.

alter table public.training_sessions
  add column cancellation_reason text,
  add constraint training_sessions_cancellation_reason_check
    check (
      cancellation_reason is null
      or (status = 'cancelled' and char_length(cancellation_reason) between 1 and 300)
    );

-- cancel_training ----------------------------------------------------------------------------
-- As 20261115000200_attendance_rpcs.sql plus the optional reason. Blank = no reason; text is
-- cleaned like every other free-text field; invisible-only or over 300 characters fails with
-- validation_failed:cancellation_reason. An already cancelled event is returned unchanged (its
-- reason is not overwritten).

drop function public.cancel_training(uuid);

create function public.cancel_training(p_session_id uuid, p_reason text default null)
returns public.training_sessions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_community_id uuid;
  v_session public.training_sessions;
  v_reason text;
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
  if not public.is_organizer(v_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;

  if p_reason is not null and p_reason !~ '^\s*$' then
    v_reason := private.clean_required_text(p_reason, 'cancellation_reason', 300, true);
  end if;

  select s.* into v_session
  from public.training_sessions s
  where s.id = p_session_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  -- Re-checked after the lock wait: the caller may have been removed or demoted meanwhile.
  if not public.is_organizer(v_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;

  if v_session.status = 'cancelled' then
    return v_session;
  end if;
  if v_session.status = 'completed' then
    raise exception using errcode = 'P0001', message = 'session_not_cancellable';
  end if;
  -- Attendance writers hold the session lock, so this read is stable until commit.
  if exists (
    select 1
    from public.attendance_records a
    where a.session_id = p_session_id
      and a.status in ('present', 'absent')
  ) then
    raise exception using errcode = 'P0001', message = 'session_has_attendance';
  end if;

  update public.training_sessions
  set status = 'cancelled',
      cancel_reason = 'organizer',
      cancellation_reason = v_reason,
      cancelled_at = now(),
      cancelled_by = v_uid,
      updated_at = now()
  where id = p_session_id
  returning * into v_session;

  return v_session;
end;
$$;

-- finalize_due_sessions -------------------------------------------------------------------------
-- As 20261126000100_events.sql; the auto-cancel stores the pre-filled reason.

create or replace function public.finalize_due_sessions() returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with due as (
    select s.id
    from public.training_sessions s
    where s.status = 'scheduled'
      and s.event_kind = 'training'
      and s.min_participants is not null
      and s.rsvp_deadline <= now()
    order by s.rsvp_deadline, s.id
    for update skip locked
  )
  update public.training_sessions s
  set status = case
        when s.going_count >= s.min_participants then 'confirmed'::public.session_status
        else 'cancelled'::public.session_status
      end,
      cancel_reason = case
        when s.going_count >= s.min_participants then null
        else 'insufficient_participation'::public.cancel_reason
      end,
      cancellation_reason = case
        when s.going_count >= s.min_participants then null
        else 'Not enough participants: ' || s.going_count || ' of ' || s.min_participants || ' needed.'
      end,
      cancelled_at = case when s.going_count >= s.min_participants then null else now() end,
      decided_at = now(),
      updated_at = now()
  from due
  where s.id = due.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Notification trigger --------------------------------------------------------------------------
-- As 20261126000100_events.sql; the cancellation body carries the reason when there is one.
-- (enqueue_notification truncates the body to 500 characters; the reason is cut to 200 first so
-- the time and place always survive.)

create or replace function private.notify_training_changed() returns trigger
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
  v_kind text := private.event_kind_title(new.event_kind);
  v_time_changed boolean;
  v_place_changed boolean;
  v_title_changed boolean;
begin
  if new.status is distinct from old.status then
    if new.status = 'confirmed' and new.event_kind = 'training' then
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
        v_kind || ' cancelled: ' || new.title,
        v_when || ' · ' || new.location_name || ' - '
          || case
               when new.cancel_reason = 'insufficient_participation'
                 then coalesce(
                   left(regexp_replace(new.cancellation_reason, '\s+', ' ', 'g'), 200),
                   'Not enough participants.')
               when new.cancellation_reason is not null
                 then 'cancelled by the organizer. Reason: '
                   || left(regexp_replace(new.cancellation_reason, '\s+', ' ', 'g'), 200)
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

  -- Instants compared at millisecond precision, as update_training does.
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
      v_kind || ' updated: ' || new.title,
      concat_ws(' ',
        case when v_time_changed then 'New time.' end,
        case when v_place_changed then 'New location.' end,
        case when v_title_changed then 'New title.' end,
        v_when || ' · ' || new.location_name),
      v_link, new.id, null,
      'training_updated:' || new.id || ':' || (extract(epoch from now()) * 1000000)::bigint,
      v_expires
    );
  end if;
  return null;
end;
$$;

-- Grants --------------------------------------------------------------------------------------

revoke all on function public.cancel_training(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.cancel_training(uuid, text) to authenticated;
