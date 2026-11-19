-- TrainHive: fixes for the GDPR QA review (docs/QA_REPORT.md, "GDPR (G1 + G2) (Q7)").
-- Contract: docs/API_CONTRACT.md ("GDPR Q7 fixes").
--
--   Q7-1  claim_notification_jobs hands out a user's push tokens only while the user holds a
--         current push_notifications consent (private.has_consent). Without it the job carries
--         tokens [] and skip_reason 'no_push_consent' (push_allowed false), so the dispatcher
--         completes it as skipped. In-app notifications are unaffected. Ladder, first match wins:
--         not_a_member, push_disabled, category_disabled, no_push_consent, then no_tokens.
--         Deployment order: the app update that asks existing members for push consent ships
--         first, then this migration (owner decision).
--   Q7-2  withdraw_consent('push_notifications') always deletes the caller's push tokens, also
--         when no grant event exists (a member whose token predates the ledger). No ledger event
--         is written when nothing was granted (changed = false, as before).
--   Q7-3  private.data_export_log rows older than one hour (the rate-limit window, the only thing
--         that reads them) are deleted by the daily purge (pg_cron trainhive_purge_notification_data,
--         03:17 UTC), so a row lives at most about 25 hours. The export README now says "kept for
--         about a day" (was "at most a day", which a daily job cannot guarantee).
--   Q7-4  The daily purge deletes push tokens invalidated (Expo DeviceNotRegistered) more than
--         30 days ago, and tokens the app has not registered again for more than 270 days (the
--         app re-registers on every start and return to the foreground, refreshing last_seen_at).
--   Q7-6  private.erase_user clears the free-text reason (set null) of every attendance audit row
--         about the erased user and of every row the user authored, so the anonymized trail
--         carries no names.
--
-- Functions are replaced in place (signatures unchanged). Grants are revoked and granted again
-- explicitly at the end; the privilege matrix is unchanged (two new private helpers, no API role).

-- Q7-1: push consent at send time ---------------------------------------------------------------
-- Same as M3-B3 (20261116000100_m3_qa_fixes.sql) plus the no_push_consent step. The consent is
-- read when the job is claimed; a withdrawal that commits after the claim cannot recall a push
-- already handed to the dispatcher (it does delete the tokens, so no later claim sends).

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
             when not private.has_consent(c.user_id, 'push_notifications') then 'no_push_consent'
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

-- Q7-2: switching push off always removes the tokens --------------------------------------------
-- Same as G1 (20261123000100_consents.sql) except: for push_notifications the caller's tokens are
-- deleted whether or not a grant is on record. With no current grant nothing is written to the
-- ledger (changed = false); the auth user is key-share locked first, as the ledger insert would,
-- so the lock order against a concurrent account deletion is unchanged (that deletion also takes
-- the consent lock first, so the two are serialized anyway).

create or replace function public.withdraw_consent(p_purpose text) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_latest public.consent_records;
  v_row public.consent_records;
begin
  if v_uid is null or not private.auth_user_exists(v_uid) then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if p_purpose is null or not (p_purpose = any (private.consent_purposes())) then
    raise exception using errcode = 'P0001', message = 'validation_failed:purpose';
  end if;
  if p_purpose in ('terms_privacy', 'age_16') then
    raise exception using errcode = 'P0001', message = 'not_withdrawable';
  end if;

  perform private.lock_consents(v_uid);

  v_latest := private.latest_consent(v_uid, p_purpose);
  if v_latest.id is null or not v_latest.granted then
    if p_purpose = 'push_notifications' then
      perform 1 from auth.users u where u.id = v_uid for key share;
      if not found then
        -- Deleted while this call waited for the consent lock.
        raise exception using errcode = 'P0001', message = 'not_authenticated';
      end if;
      delete from public.device_push_tokens t where t.user_id = v_uid;
    end if;
    return private.consent_event_json(p_purpose, v_latest, false);
  end if;

  -- Ledger row first: its foreign key key-share-locks the auth user, so a concurrent account
  -- deletion is either waited for here (then not_authenticated) or waits for this call, before
  -- this call locks any token row.
  insert into public.consent_records (user_id, purpose, document_version, granted, created_at)
  values (v_uid, p_purpose, private.privacy_version(), false, private.next_consent_at(v_uid))
  returning * into v_row;

  if p_purpose = 'push_notifications' then
    delete from public.device_push_tokens t where t.user_id = v_uid;
  end if;

  return private.consent_event_json(p_purpose, v_row, true);
exception
  when foreign_key_violation then
    if private.auth_user_exists(v_uid) then
      raise;
    end if;
    raise exception using errcode = 'P0001', message = 'not_authenticated';
end;
$$;

-- Q7-3: export rate-limit log retention ---------------------------------------------------------
-- Rows older than the one-hour rate-limit window are no longer read by anything. export_my_data
-- holds a per-user advisory lock and only reads rows newer than an hour, so deleting older rows
-- concurrently never changes its count. Idempotent. Returns the number of rows deleted.

create function private.purge_old_data_export_log() returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from private.data_export_log l
  where l.requested_at < clock_timestamp() - interval '1 hour';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Q7-4: push token retention --------------------------------------------------------------------
-- Deletes tokens invalidated more than 30 days ago and tokens not registered again for more than
-- 270 days. A device whose app is used again registers its token anew (when push consent is
-- current). Rows locked by a concurrent registration are skipped (next run). Idempotent. Returns
-- the number of tokens deleted.

create function private.purge_stale_push_tokens() returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.device_push_tokens t
  where t.id in (
    select x.id
    from public.device_push_tokens x
    where x.invalidated_at < now() - interval '30 days'
       or x.last_seen_at < now() - interval '270 days'
    for update skip locked
  );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Daily purge -------------------------------------------------------------------------------------
-- Same as C3 (20261120000100_c_qa_fixes.sql), plus private.purge_old_data_export_log() and
-- private.purge_stale_push_tokens() (still run by the daily job trainhive_purge_notification_data,
-- 03:17). The return value is unchanged: the number of jobs and notifications deleted (cascaded
-- jobs, invitation attempts, export-log rows and push tokens not counted).

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

  perform private.purge_old_invitation_attempts();
  perform private.purge_old_data_export_log();
  perform private.purge_stale_push_tokens();

  return v_jobs + v_stale + v_orphans + v_old;
end;
$$;

-- Q7-3: export README wording ---------------------------------------------------------------------
-- Same as G2 (20261124000200_data_rights.sql) except one README sentence: "rate-limit records kept
-- for about a day" (was "at most a day").

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
      || 'account). technical: rate-limit records kept for about a day. Other members'' data is '
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

-- Q7-6: erasure clears audit reasons ------------------------------------------------------------
-- Same as G2 (20261124000200_data_rights.sql) except step 4 also sets attendance_audit_log.reason
-- to null on the rows it anonymizes.

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

-- Grants (unchanged matrix, restated; the two new helpers are reachable by no API role) ----------

revoke all on function private.purge_old_data_export_log() from public, anon, authenticated, service_role;
revoke all on function private.purge_stale_push_tokens() from public, anon, authenticated, service_role;
revoke all on function private.erase_user(uuid) from public, anon, authenticated, service_role;
revoke all on function public.claim_notification_jobs(integer, text)
  from public, anon, authenticated, service_role;
revoke all on function public.purge_old_notification_data()
  from public, anon, authenticated, service_role;
revoke all on function public.withdraw_consent(text) from public, anon, authenticated, service_role;
revoke all on function public.export_my_data() from public, anon, authenticated, service_role;

grant execute on function public.claim_notification_jobs(integer, text) to service_role;
grant execute on function public.purge_old_notification_data() to service_role;
grant execute on function public.withdraw_consent(text) to authenticated;
grant execute on function public.export_my_data() to authenticated;
