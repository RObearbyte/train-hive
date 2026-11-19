-- TrainHive GDPR G2 (part 2): "Download my data" and "Delete my account".
-- Plan: docs/GDPR_PLAN.md sections 1 and 3, phase G2. Contract: docs/API_CONTRACT.md
-- ("GDPR G2 — export and deletion").
--
--   export_my_data()         everything personal about the caller, nothing about anyone else
--   my_deletion_blockers()   what stands in the way of a deletion, and what it would take along
--   delete_my_account()      one transaction: checks, then private.erase_user(auth.uid())
--   private.erase_user(id)   the erasure itself; G3 (inactive accounts) will reuse it
--
-- Deleted vs anonymized (owner default in GDPR_PLAN: delete personal data, keep ANONYMOUS
-- attendance counts so past club statistics stay correct):
--   * attendance_records / attendance_audit_log rows ABOUT the user stay, with user_id = null
--     (no name, no id). Rows the user AUTHORED (recorded_by / changed_by) keep their subject and
--     lose the author. The user columns become nullable and `on delete set null`; the unique
--     (session_id, user_id) still rules out duplicates for real users (nulls are distinct, so
--     several deleted people can each keep their anonymous row for one session).
--   * Content the user authored for a community stays without an author: announcements
--     (author_id null; the app shows "Former member"), sessions they organized / cancelled /
--     finalized (organizer_id / cancelled_by / attendance_finalized_by null), invitation codes
--     they created (created_by null; redemption_count is kept, so a code's limit still counts the
--     deleted person's use).
--   * Everything else that refers to the user is deleted: profile, memberships, RSVPs (going_count
--     follows through the existing triggers), push tokens, notification preferences, notifications
--     and their push jobs, announcement read receipts, invitation and creator-code redemptions
--     (the creator code's use_count is kept, so the code stays used), invitation attempts, the
--     data-export log, the consent ledger (through the cascade from auth.users, the only DELETE the
--     ledger's guard allows) and finally the auth.users row.
--   * A community in which the user is the last active member is deleted with everything in it.
--   * The last active organizer of a community that still has other active members cannot be
--     deleted (last_organizer) until another member is promoted.
--
-- Lock order of an erasure (consistent with every writer; see the role-lock migration):
--   consent lock (advisory, per user) -> invitation codes of the user's active communities
--   -> profile row -> auth.users row -> community role locks (community id order)
--   -> the user's membership rows -> the other active organizers' membership rows (share)
--   -> scheduled / authored announcements -> sessions the erasure touches (id order).
-- Taking the open sessions and scheduled announcements of the user's communities up front also
-- means that a notification fan-out already running for one of them commits BEFORE the erasure
-- (whose deferred trigger on profiles then removes the new notification), and one that starts
-- later no longer sees the user as a member.

-- Attendance: anonymous rows ---------------------------------------------------------------------

alter table public.attendance_records alter column user_id drop not null;
alter table public.attendance_records drop constraint attendance_records_user_id_fkey;
alter table public.attendance_records
  add constraint attendance_records_user_id_fkey
  foreign key (user_id) references public.profiles (id) on delete set null;

alter table public.attendance_audit_log alter column user_id drop not null;
alter table public.attendance_audit_log drop constraint attendance_audit_log_user_id_fkey;
alter table public.attendance_audit_log
  add constraint attendance_audit_log_user_id_fkey
  foreign key (user_id) references public.profiles (id) on delete set null;

comment on column public.attendance_records.user_id is
  'The member; null once their account was deleted (anonymous record kept for session statistics).';
comment on column public.attendance_audit_log.user_id is
  'The member whose attendance changed; null once their account was deleted.';

-- Statistics: anonymous records ------------------------------------------------------------------
-- Same rule as 20261117000100_statistics.sql. Change: the non-eligible branch carries its own
-- attendance record (joined by row, not by user id), so an anonymous record (user_id null) is
-- returned as itself: eligible = false, user_id null, membership_status null, its real status,
-- and as RSVP `going` when the record was created from a going RSVP (had_rsvp_going; the RSVP row
-- itself was deleted with the account; attendance is only taken once RSVPs are closed, so the
-- RSVP at record creation is the final one) else `no_response`. Session-level community numbers
-- (total attendances, per-session present counts, averages, RSVP conversion, trend, top sessions)
-- therefore keep counting a deleted member's attendance; per-member numbers (summary list,
-- members_attended, get_member_statistics) never see it. For every row with a real user the
-- result is identical to the previous definition.
create or replace function private.stats_rows(
  p_community_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_user_id uuid default null
) returns table (
  session_id uuid,
  starts_at timestamptz,
  user_id uuid,
  membership_status public.membership_status,
  eligible boolean,
  rsvp public.rsvp_response,
  attendance public.attendance_status,
  has_record boolean,
  is_walk_in boolean
)
language sql
stable
set search_path = ''
as $$
  with s as (
    select x.id, x.starts_at
    from private.stats_sessions(p_community_id, p_from, p_to) x
  ),
  members as (
    select s.id as session_id, s.starts_at, m.user_id, m.status as membership_status
    from s
    join public.memberships m
      on m.community_id = p_community_id
     and m.joined_at <= s.starts_at
    where p_user_id is null or m.user_id = p_user_id
  )
  select x.session_id, x.starts_at, x.user_id, x.membership_status, true,
         coalesce(r.response, 'no_response'::public.rsvp_response),
         coalesce(a.status, 'unrecorded'::public.attendance_status),
         a.id is not null,
         coalesce(a.is_walk_in, false)
  from members x
  left join public.training_rsvps r
    on r.session_id = x.session_id
   and r.user_id = x.user_id
  left join public.attendance_records a
    on a.session_id = x.session_id
   and a.user_id = x.user_id
  union all
  select s.id, s.starts_at, a.user_id, m.status, false,
         case
           when a.user_id is null then
             case when a.had_rsvp_going then 'going' else 'no_response' end::public.rsvp_response
           else coalesce(r.response, 'no_response'::public.rsvp_response)
         end,
         a.status,
         true,
         a.is_walk_in
  from s
  join public.attendance_records a on a.session_id = s.id
  left join public.memberships m
    on m.community_id = p_community_id
   and m.user_id = a.user_id
  left join public.training_rsvps r
    on r.session_id = s.id
   and r.user_id = a.user_id
  where (m.id is null or m.joined_at > s.starts_at)
    and (p_user_id is null or a.user_id = p_user_id);
$$;

-- Attendance sheet: anonymous records ------------------------------------------------------------
-- As 20261115000200_attendance_rpcs.sql. Anonymous records (deleted accounts) are never listed as
-- an entry; they are summarized in `former_members` ({ present, absent, unrecorded }) so the
-- sheet's totals still match the session's statistics.
create or replace function public.get_attendance_sheet(p_session_id uuid) returns jsonb
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
  v_former jsonb;
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
      and a.user_id is not null
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

  select jsonb_build_object(
    'present', count(*) filter (where a.status = 'present'),
    'absent', count(*) filter (where a.status = 'absent'),
    'unrecorded', count(*) filter (where a.status = 'unrecorded')
  ) into v_former
  from public.attendance_records a
  where a.session_id = p_session_id
    and a.user_id is null;

  return jsonb_build_object(
    'session_id', v_session.id,
    'status', v_session.status,
    -- Same rule and clock as the writers.
    'ended', private.session_ended(v_session.starts_at, v_session.ends_at, clock_timestamp()),
    'attendance_finalized_at', v_session.attendance_finalized_at,
    'attendance_finalized_by', v_session.attendance_finalized_by,
    'entries', v_entries,
    'former_members', v_former
  );
end;
$$;

-- create_training: organizer membership lock ------------------------------------------------------
-- As 20261114000400_trainings_rpcs.sql, plus: the caller's profile (key share) and active organizer
-- membership (FOR NO KEY UPDATE, the lock create_announcement takes) are locked before the insert,
-- and the organizer role is re-checked under that lock. The training_created fan-out runs inside
-- this transaction; an account erasure share-locks the active organizers' memberships of the
-- user's communities, so a creation in flight commits before the erasure (whose deferred trigger
-- then removes the new notification) and a later one no longer sees the erased member. Without
-- this lock a creation that started before an erasure and committed after it could leave a
-- notification for the deleted user behind. Same signature, grants and errors.
create or replace function public.create_training(p_community_id uuid, p_input jsonb)
returns public.training_sessions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_timezone text;
  v_in public.training_sessions;
  v_session public.training_sessions;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  -- Also the answer for a community that does not exist, so ids cannot be probed.
  if p_community_id is null or not public.is_organizer(p_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;

  select c.timezone into v_timezone from public.communities c where c.id = p_community_id;

  v_in := private.parse_training_input(p_input, v_timezone, array[v_timezone]);
  v_in.rsvp_deadline := coalesce(v_in.rsvp_deadline, v_in.starts_at - interval '2 hours');

  -- Lock order profile -> membership (the session row is new).
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

  if v_in.starts_at <= clock_timestamp() then
    perform private.fail_validation('starts_at');
  end if;
  -- The deadline must be in the future and strictly before the start.
  if v_in.rsvp_deadline <= clock_timestamp() or v_in.rsvp_deadline >= v_in.starts_at then
    perform private.fail_validation('rsvp_deadline');
  end if;

  insert into public.training_sessions (
    community_id, organizer_id, title, description, activity_type, starts_at, ends_at,
    rsvp_deadline, timezone, location_name, address, latitude, longitude, map_url,
    meeting_instructions, min_participants, max_participants
  ) values (
    p_community_id, v_uid, v_in.title, v_in.description, v_in.activity_type, v_in.starts_at,
    v_in.ends_at, v_in.rsvp_deadline, v_in.timezone, v_in.location_name, v_in.address,
    v_in.latitude, v_in.longitude, v_in.map_url, v_in.meeting_instructions,
    v_in.min_participants, v_in.max_participants
  )
  returning * into v_session;

  return v_session;
end;
$$;

-- Export rate limit log --------------------------------------------------------------------------
-- One row per successful export_my_data call (at most 10 per user per rolling hour). Private:
-- no API role has usage on the schema; rows older than an hour are pruned by the next export of
-- the same user and deleted with the account (cascade from auth.users, and explicitly).

create table private.data_export_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  requested_at timestamptz not null default clock_timestamp()
);

create index data_export_log_user_requested_idx on private.data_export_log (user_id, requested_at);

revoke all on table private.data_export_log from public, anon, authenticated, service_role;

-- export_my_data ---------------------------------------------------------------------------------
-- The caller's own data, as one JSON document (format_version 1). Lists are capped at 5000 items
-- each (oldest first; `truncated.<section>` is true when more exist). Other people appear only as
-- what the caller already shares with them: community names and event titles, never other members'
-- names or ids; an organizer who changed the caller's attendance is "an organizer". Push tokens
-- are described (platform, label, dates) but their values are not exported. One statement builds
-- the document, so it is a consistent snapshot. Rate limit: 10 exports per user per rolling hour
-- (rate_limited), counted under a per-user advisory lock so the cap is exact.
-- extensions: P3 (About you: demographics, emergency contact) and P5 (workout logs) add their own
-- keys here; the object is always present (empty until then).

create function public.export_my_data() returns jsonb
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
      || 'sent you and how (push token values are not included). authored: content you created for '
      || 'your communities (it stays in the community without your name if you delete your '
      || 'account). technical: rate-limit records kept for at most a day. Other members'' data is '
      || 'not included. Lists hold at most 5000 items; "truncated" says where more exist. '
      || 'Deleting your account (Profile > Privacy) erases this data; attendance stays only as '
      || 'anonymous counts.',
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
    'push_devices', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from devices x),
    'authored', jsonb_build_object(
      'announcements', (select coalesce(jsonb_agg(x.j order by x.n) filter (where x.n <= c_limit), '[]'::jsonb) from authored_announcements x),
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
      'push_devices', (select count(*) > c_limit from devices),
      'authored_announcements', (select count(*) > c_limit from authored_announcements),
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

-- Deletion helpers -------------------------------------------------------------------------------

-- Communities where p_user_id is the last active organizer while other active members remain:
-- [{ community_id, name, active_members }] ordered by name. Empty array when none.
create function private.deletion_blockers(p_user_id uuid) returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'community_id', c.id,
        'name', c.name,
        'active_members', (
          select count(*)
          from public.memberships o
          where o.community_id = c.id
            and o.status = 'active'
        )
      )
      order by c.name, c.id
    ),
    '[]'::jsonb
  )
  from public.memberships m
  join public.communities c on c.id = m.community_id
  where m.user_id = p_user_id
    and m.status = 'active'
    and m.role = 'organizer'
    and not private.has_other_organizer(m.community_id, p_user_id)
    and private.has_other_member(m.community_id, p_user_id);
$$;

-- Communities in which p_user_id is the only active member (deleted with the account).
create function private.sole_member_communities(p_user_id uuid) returns uuid[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(m.community_id order by m.community_id), '{}'::uuid[])
  from public.memberships m
  where m.user_id = p_user_id
    and m.status = 'active'
    and not private.has_other_member(m.community_id, p_user_id);
$$;

-- Takes every lock an erasure needs, in the documented order. Returns false when the auth user
-- does not exist (already deleted). Calling it twice in one transaction is harmless.
create function private.lock_user_for_erasure(p_user_id uuid) returns boolean
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_communities uuid[];
  v_active uuid[];
  v_community uuid;
begin
  perform private.lock_consents(p_user_id);

  -- Joins into the user's communities wait (redeem_invitation locks the code row first), so the
  -- "last member" decision below cannot be overtaken by a new member.
  perform 1
  from public.invitation_codes ic
  where ic.community_id in (
    select m.community_id
    from public.memberships m
    where m.user_id = p_user_id
      and m.status = 'active'
  )
  order by ic.id
  for update;

  perform 1 from public.profiles p where p.id = p_user_id for update;
  perform 1 from auth.users u where u.id = p_user_id for update;
  if not found then
    return false;
  end if;
  -- Again: a join that created the profile while this call waited for the auth user has
  -- committed by now.
  perform 1 from public.profiles p where p.id = p_user_id for update;

  select coalesce(array_agg(distinct m.community_id), '{}'::uuid[]) into v_communities
  from public.memberships m
  where m.user_id = p_user_id;

  foreach v_community in array (select coalesce(array_agg(c order by c), '{}'::uuid[]) from unnest(v_communities) c) loop
    perform private.lock_community_roles(v_community);
  end loop;

  perform 1
  from public.memberships m
  where m.user_id = p_user_id
  order by m.id
  for update;

  select coalesce(array_agg(m.community_id), '{}'::uuid[]) into v_active
  from public.memberships m
  where m.user_id = p_user_id
    and m.status = 'active';

  -- The last-member communities (deleted with the account): their codes are locked (normally
  -- already done above), so nobody can join them before the deletion commits.
  perform 1
  from public.invitation_codes ic
  where ic.community_id = any (private.sole_member_communities(p_user_id))
  order by ic.id
  for update;

  -- In-flight announcement fan-outs of these communities finish first (create_announcement holds
  -- its organizer membership; publish / update hold the scheduled row).
  perform 1
  from public.memberships m
  where m.community_id = any (v_active)
    and m.user_id <> p_user_id
    and m.status = 'active'
    and m.role = 'organizer'
  order by m.id
  for share;

  perform 1
  from public.announcements a
  where (a.community_id = any (v_active) and a.status = 'scheduled')
     or a.author_id = p_user_id
  order by a.id
  for update;

  -- Every session the erasure writes (RSVP release and uncount, author columns) plus the open
  -- ones of the user's communities (their notification fan-outs), in id order.
  perform 1
  from public.training_sessions s
  where (s.community_id = any (v_active) and s.status in ('scheduled', 'confirmed'))
     or s.organizer_id = p_user_id
     or s.cancelled_by = p_user_id
     or s.attendance_finalized_by = p_user_id
     or s.id in (
       select r.session_id
       from public.training_rsvps r
       where r.user_id = p_user_id
     )
  order by s.id
  for update;

  return true;
end;
$$;

-- private.erase_user ------------------------------------------------------------------------------
-- Erases one user (see the header for what is deleted and what is anonymized). Takes the locks
-- itself and refuses with last_organizer (P0001, DETAIL = {"communities": [...]} as JSON) while the
-- user is the last active organizer of a community with other active members, whoever calls it.
-- Returns null when the auth user no longer exists, else a summary:
-- { user_id, communities_deleted: [ids], memberships_deleted, rsvps_deleted,
--   attendance_records_anonymized, attendance_changes_anonymized, notifications_deleted }.
-- No caller identity: delete_my_account passes auth.uid(); the G3 inactive-account job will pass
-- the account it selected.

create function private.erase_user(p_user_id uuid) returns jsonb
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
  update public.attendance_records a set user_id = null where a.user_id = p_user_id;
  get diagnostics v_records = row_count;
  update public.attendance_records a set recorded_by = null where a.recorded_by = p_user_id;
  update public.attendance_audit_log l set user_id = null where l.user_id = p_user_id;
  get diagnostics v_changes = row_count;
  update public.attendance_audit_log l set changed_by = null where l.changed_by = p_user_id;

  -- 5. Community content the user authored stays, without an author.
  update public.training_sessions s set organizer_id = null where s.organizer_id = p_user_id;
  update public.training_sessions s set cancelled_by = null where s.cancelled_by = p_user_id;
  update public.training_sessions s
  set attendance_finalized_by = null
  where s.attendance_finalized_by = p_user_id;
  update public.announcements a set author_id = null where a.author_id = p_user_id;
  update public.invitation_codes ic set created_by = null where ic.created_by = p_user_id;
  update public.community_creator_codes cc set created_by = null where cc.created_by = p_user_id;

  -- 6. Personal rows.
  delete from public.notifications n where n.user_id = p_user_id;
  get diagnostics v_notifications = row_count;
  delete from public.notification_delivery_jobs j where j.user_id = p_user_id;
  delete from public.device_push_tokens t where t.user_id = p_user_id;
  delete from public.notification_preferences np where np.user_id = p_user_id;
  delete from public.announcement_reads ar where ar.user_id = p_user_id;
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

-- my_deletion_blockers ---------------------------------------------------------------------------
-- For the "Delete my account" screen, before asking for confirmation:
-- { can_delete, last_organizer: [{ community_id, name, active_members }],
--   deleted_with_account: [{ community_id, name }] }  (communities where the caller is the last
-- active member, which the deletion removes with all their content). Read-only, no locks: the
-- deletion re-checks under its locks.

create function public.my_deletion_blockers() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_blockers jsonb;
  v_sole jsonb;
begin
  if v_uid is null or not private.auth_user_exists(v_uid) then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;

  v_blockers := private.deletion_blockers(v_uid);

  select coalesce(
    jsonb_agg(jsonb_build_object('community_id', c.id, 'name', c.name) order by c.name, c.id),
    '[]'::jsonb
  ) into v_sole
  from public.communities c
  where c.id = any (private.sole_member_communities(v_uid));

  return jsonb_build_object(
    'can_delete', jsonb_array_length(v_blockers) = 0,
    'last_organizer', v_blockers,
    'deleted_with_account', v_sole
  );
end;
$$;

-- delete_my_account ------------------------------------------------------------------------------
-- Deletes the caller's account in one transaction (private.erase_user). Errors (P0001):
-- not_authenticated (no user, or the JWT's user is already deleted: a repeated call),
-- last_organizer (DETAIL: {"communities": [{community_id, name, active_members}]}).

create function public.delete_my_account() returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
begin
  if v_uid is null or not private.auth_user_exists(v_uid) then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;

  v_result := private.erase_user(v_uid);
  if v_result is null then
    -- Deleted by a concurrent call while this one waited for the locks.
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  return v_result;
end;
$$;

-- Grants -----------------------------------------------------------------------------------------

revoke all on function private.stats_rows(uuid, timestamptz, timestamptz, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.deletion_blockers(uuid) from public, anon, authenticated, service_role;
revoke all on function private.sole_member_communities(uuid) from public, anon, authenticated, service_role;
revoke all on function private.lock_user_for_erasure(uuid) from public, anon, authenticated, service_role;
revoke all on function private.erase_user(uuid) from public, anon, authenticated, service_role;

revoke all on function public.create_training(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.get_attendance_sheet(uuid) from public, anon, authenticated, service_role;
revoke all on function public.export_my_data() from public, anon, authenticated, service_role;
revoke all on function public.my_deletion_blockers() from public, anon, authenticated, service_role;
revoke all on function public.delete_my_account() from public, anon, authenticated, service_role;

grant execute on function public.create_training(uuid, jsonb) to authenticated;
grant execute on function public.get_attendance_sheet(uuid) to authenticated;
grant execute on function public.export_my_data() to authenticated;
grant execute on function public.my_deletion_blockers() to authenticated;
grant execute on function public.delete_my_account() to authenticated;
