-- TrainHive GDPR G1: legal document versions and the consent ledger.
-- Plan: docs/GDPR_PLAN.md (sections 1-3, phase G1). Contract: docs/API_CONTRACT.md ("GDPR G1 — consents").
--
--   legal_documents          current version of the Terms of use and of the Privacy notice
--   consent_records          append-only ledger: one row per grant or withdrawal event
--   admin_set_legal_version  service_role / SQL editor: bump a version (everyone must accept again)
--   record_consent, withdraw_consent, my_consents   (authenticated)
--   private.has_consent      the check every consent-dependent write function calls
--   Join gate: redeem_invitation and create_community_with_code refuse with consent_required
--              unless the caller has current terms_privacy AND age_16 consent.
--   register_push_token requires push_notifications consent; withdrawing it removes the caller's
--              push tokens.
--
-- Existing users: NO consent is backfilled. Consent (and the 16+ confirmation) cannot be assumed
-- from the fact that someone already uses the app, and the ledger must only ever contain events a
-- person actually performed. Users who joined before this migration therefore have no records:
-- my_consents() reports needs_terms_acceptance = true for them, so the app asks on next launch.
-- They are NOT blocked from using the app (RSVP, attendance, reads, ... never check consent);
-- only new joins (invitation or creator code) and push-token registration are gated. Blocking
-- every existing member until they tap "accept" would be a product decision with no data-
-- protection benefit beyond what the app prompt already gives, and it would silently break the
-- club's running events.

-- Legal document versions ------------------------------------------------------------------------

create table public.legal_documents (
  document text primary key check (document in ('terms', 'privacy')),
  -- Restricted alphabet so the combined terms_privacy version string ('terms:1|privacy:1') is
  -- unambiguous.
  version text not null check (version ~ '^[A-Za-z0-9._-]{1,20}$'),
  effective_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.legal_documents (document, version) values ('terms', '1'), ('privacy', '1');

revoke all on table public.legal_documents from public, anon, authenticated, service_role;
grant select on table public.legal_documents to authenticated;
alter table public.legal_documents enable row level security;
create policy legal_documents_select_authenticated on public.legal_documents
  for select to authenticated
  using (true);

-- Consent ledger ---------------------------------------------------------------------------------

-- Purposes. Extending the list = a migration that replaces this function and the check below.
create function private.consent_purposes() returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['terms_privacy', 'age_16', 'profile_demographics', 'emergency_contact',
               'workout_logs', 'push_notifications']::text[];
$$;

-- user_id references auth.users, not profiles: the acknowledgement is recorded at first launch,
-- before the user has a profile (a profile is created when joining a community).
-- Event order: created_at, which the RPCs make strictly increasing per user (they write under a
-- per-user lock, at greatest(clock_timestamp(), previous event + 1 microsecond)). id (uuid) only
-- breaks ties for rows inserted by other means (fixtures). No identity column: public holds no
-- sequences.
create table public.consent_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  purpose text not null check (purpose in ('terms_privacy', 'age_16', 'profile_demographics',
                                           'emergency_contact', 'workout_logs', 'push_notifications')),
  -- terms_privacy: the combined version accepted ('terms:<v>|privacy:<v>'); every other purpose:
  -- the privacy-notice version in force at the time of the event.
  document_version text,
  granted boolean not null,
  created_at timestamptz not null default clock_timestamp()
);

-- Latest event per (user, purpose); the second index serves the rate-limit count and the
-- per-user "previous event" lookup.
create index consent_records_user_purpose_idx on public.consent_records (user_id, purpose, created_at desc, id desc);
create index consent_records_user_created_idx on public.consent_records (user_id, created_at);

-- Append-only, at two levels:
-- 1. Privileges: no API role (service_role included) holds anything but authenticated's SELECT.
-- 2. A row trigger blocks UPDATE always, and DELETE unless the row's auth user no longer exists,
--    which is exactly the ON DELETE CASCADE from auth.users (account deletion). It applies to
--    the table owner and superusers too. Not covered (owner/superuser only, documented):
--    TRUNCATE and session_replication_role = replica, which skip row triggers.
revoke all on table public.consent_records from public, anon, authenticated, service_role;
grant select on table public.consent_records to authenticated;
alter table public.consent_records enable row level security;
create policy consent_records_select_own on public.consent_records
  for select to authenticated
  using (user_id = (select auth.uid()));

create function private.guard_consent_ledger() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and not exists (select 1 from auth.users u where u.id = old.user_id) then
    -- The user was deleted in this transaction: the foreign key cascade.
    return old;
  end if;
  raise exception using errcode = 'P0001', message = 'consent_ledger_append_only';
end;
$$;

create trigger consent_records_append_only
  before update or delete on public.consent_records
  for each row execute function private.guard_consent_ledger();

-- Helpers ----------------------------------------------------------------------------------------

create function private.privacy_version() returns text
language sql
stable
set search_path = ''
as $$
  select d.version from public.legal_documents d where d.document = 'privacy';
$$;

-- The version string a terms_privacy grant must carry: 'terms:<v>|privacy:<v>'.
create function private.terms_privacy_version() returns text
language sql
stable
set search_path = ''
as $$
  select 'terms:' || t.version || '|privacy:' || p.version
  from public.legal_documents t, public.legal_documents p
  where t.document = 'terms' and p.document = 'privacy';
$$;

-- The latest event of a user for a purpose (null fields when there is none).
create function private.latest_consent(p_user_id uuid, p_purpose text)
returns public.consent_records
language sql
stable
set search_path = ''
as $$
  select r.*
  from public.consent_records r
  where r.user_id = p_user_id and r.purpose = p_purpose
  order by r.created_at desc, r.id desc
  limit 1;
$$;

-- The time for a new event of the user: now, but strictly after the user's previous event, so
-- "latest" is unambiguous. Call under private.lock_consents.
create function private.next_consent_at(p_user_id uuid) returns timestamptz
language sql
volatile
set search_path = ''
as $$
  select greatest(
    clock_timestamp(),
    coalesce((select max(r.created_at) from public.consent_records r where r.user_id = p_user_id),
             '-infinity'::timestamptz) + interval '1 microsecond'
  );
$$;

-- True only when the latest event for the purpose is a grant (and, for terms_privacy, of the
-- current Terms + Privacy versions). Future consent-dependent write functions (demographics,
-- emergency contact, workout logs) call this inside their own transaction, after taking
-- private.lock_consents(user) so a concurrent withdrawal cannot interleave.
create function private.has_consent(p_user_id uuid, p_purpose text) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select l.granted
       and (p_purpose <> 'terms_privacy' or l.document_version = private.terms_privacy_version())
    from private.latest_consent(p_user_id, p_purpose) l
    where l.id is not null
  ), false);
$$;

-- Serializes every consent event of one user (record, withdraw, push-token registration).
create function private.lock_consents(p_user_id uuid) returns void
language sql
volatile
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('consents:' || p_user_id::text, 0));
$$;

-- Join gate: current terms_privacy and age_16. Share-locks the legal versions so a concurrent
-- admin_set_legal_version waits for the join (or the join sees the new version).
create function private.has_join_consent(p_user_id uuid) returns boolean
language plpgsql
volatile
set search_path = ''
as $$
begin
  perform 1 from public.legal_documents d for share;
  return private.has_consent(p_user_id, 'terms_privacy')
     and private.has_consent(p_user_id, 'age_16');
end;
$$;

create function private.consent_event_json(p_purpose text, p_row public.consent_records, p_changed boolean)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'purpose', p_purpose,
    'granted', coalesce(p_row.granted, false),
    'document_version', p_row.document_version,
    'at', p_row.created_at,
    'changed', p_changed
  );
$$;

-- Admin ------------------------------------------------------------------------------------------

-- Sets the current version of 'terms' or 'privacy'. A new version makes every user's
-- terms_privacy consent stale (has_consent false, needs_terms_acceptance true) until they accept
-- again. Same version again: nothing changes (changed = false).
-- Owner, in the SQL editor: select public.admin_set_legal_version('privacy', '2');
create function public.admin_set_legal_version(p_document text, p_version text) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.legal_documents;
  v_version text := btrim(coalesce(p_version, ''));
  v_now timestamptz;
begin
  if p_document is null or p_document not in ('terms', 'privacy') then
    raise exception using errcode = 'P0001', message = 'validation_failed:document';
  end if;
  if v_version !~ '^[A-Za-z0-9._-]{1,20}$' then
    raise exception using errcode = 'P0001', message = 'validation_failed:version';
  end if;

  select d.* into v_row from public.legal_documents d where d.document = p_document for update;
  if v_row.version = v_version then
    return jsonb_build_object('document', v_row.document, 'version', v_row.version,
                              'effective_at', v_row.effective_at, 'changed', false);
  end if;

  v_now := clock_timestamp();
  update public.legal_documents d
  set version = v_version, effective_at = v_now, updated_at = v_now
  where d.document = p_document
  returning * into v_row;
  return jsonb_build_object('document', v_row.document, 'version', v_row.version,
                            'effective_at', v_row.effective_at, 'changed', true);
end;
$$;

-- User RPCs --------------------------------------------------------------------------------------

-- Appends a grant. terms_privacy: p_document_version must equal the current combined version
-- ('terms:<v>|privacy:<v>', from my_consents().terms_privacy_version). Other purposes: optional;
-- when given it must equal the current privacy version; the server always stores the current
-- privacy version. Idempotent: latest event already a grant of the same version -> nothing is
-- written (changed = false). Grants are capped at 30 ledger events per user per rolling hour
-- (rate_limited); withdrawals are never limited.
create function public.record_consent(p_purpose text, p_document_version text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_max_events_per_hour constant integer := 30;
  v_uid uuid := auth.uid();
  v_version text;
  v_latest public.consent_records;
  v_row public.consent_records;
  v_now timestamptz;
  v_recent integer;
begin
  if v_uid is null or not private.auth_user_exists(v_uid) then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if p_purpose is null or not (p_purpose = any (private.consent_purposes())) then
    raise exception using errcode = 'P0001', message = 'validation_failed:purpose';
  end if;

  perform private.lock_consents(v_uid);
  -- A concurrent version bump waits for this call (or this call sees the new version).
  perform 1 from public.legal_documents d for share;

  if p_purpose = 'terms_privacy' then
    v_version := private.terms_privacy_version();
    if p_document_version is distinct from v_version then
      raise exception using errcode = 'P0001', message = 'validation_failed:document_version';
    end if;
  else
    v_version := private.privacy_version();
    if p_document_version is not null and p_document_version <> v_version then
      raise exception using errcode = 'P0001', message = 'validation_failed:document_version';
    end if;
  end if;

  v_latest := private.latest_consent(v_uid, p_purpose);
  if v_latest.granted and v_latest.document_version = v_version then
    return private.consent_event_json(p_purpose, v_latest, false);
  end if;

  v_now := private.next_consent_at(v_uid);
  select count(*)::integer into v_recent
  from public.consent_records r
  where r.user_id = v_uid and r.created_at > v_now - interval '1 hour';
  if v_recent >= c_max_events_per_hour then
    raise exception using errcode = 'P0001', message = 'rate_limited';
  end if;

  insert into public.consent_records (user_id, purpose, document_version, granted, created_at)
  values (v_uid, p_purpose, v_version, true, v_now)
  returning * into v_row;
  return private.consent_event_json(p_purpose, v_row, true);
exception
  when foreign_key_violation then
    -- The user was deleted while this call ran.
    if private.auth_user_exists(v_uid) then
      raise;
    end if;
    raise exception using errcode = 'P0001', message = 'not_authenticated';
end;
$$;

-- Appends a withdrawal (granted = false, document_version = the privacy version in force).
-- terms_privacy and age_16: not_withdrawable (leaving means deleting the account, G2).
-- Not currently granted (never recorded, or already withdrawn): nothing written, changed = false.
-- Effects on data, in the same transaction: push_notifications removes all the caller's push
-- tokens. (P3 / P5 extend this for demographics, emergency contact and workout logs.)
create function public.withdraw_consent(p_purpose text) returns jsonb
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

-- The caller's current state per purpose plus the current legal versions.
create function public.my_consents() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_terms public.legal_documents;
  v_privacy public.legal_documents;
  v_consents jsonb := '{}'::jsonb;
  v_purpose text;
  v_latest public.consent_records;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;

  select d.* into v_terms from public.legal_documents d where d.document = 'terms';
  select d.* into v_privacy from public.legal_documents d where d.document = 'privacy';

  foreach v_purpose in array private.consent_purposes() loop
    v_latest := private.latest_consent(v_uid, v_purpose);
    v_consents := v_consents || jsonb_build_object(v_purpose, jsonb_build_object(
      'granted', coalesce(v_latest.granted, false),
      'current', private.has_consent(v_uid, v_purpose),
      'document_version', v_latest.document_version,
      'at', v_latest.created_at
    ));
  end loop;

  return jsonb_build_object(
    'terms_version', v_terms.version,
    'terms_effective_at', v_terms.effective_at,
    'privacy_version', v_privacy.version,
    'privacy_effective_at', v_privacy.effective_at,
    'terms_privacy_version', 'terms:' || v_terms.version || '|privacy:' || v_privacy.version,
    'needs_terms_acceptance', not (private.has_consent(v_uid, 'terms_privacy')
                                   and private.has_consent(v_uid, 'age_16')),
    'consents', v_consents
  );
end;
$$;

-- Join gate: redeem_invitation ---------------------------------------------------------------------
-- As 20261120000100_c_qa_fixes.sql, plus consent_required right after the caller check: before
-- the attempt lock, the rate limit and the code lookup, so it costs nothing and reveals nothing.
create or replace function public.redeem_invitation(p_code text, p_display_name text) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_invitation public.invitation_codes;
  v_result text;
  v_membership public.memberships;
begin
  if v_uid is null or not private.auth_user_exists(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if not private.has_join_consent(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'consent_required');
  end if;

  perform private.lock_invitation_attempts(v_uid);

  if private.invitation_rate_limited(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  -- Checked before the code is looked up: a bad name is not a code guess, so it is not
  -- counted as a failed attempt and reveals nothing about the code.
  v_name := private.clean_display_name(p_display_name);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_display_name');
  end if;

  -- Row lock: concurrent redemptions of the same code queue here, and each one re-reads the
  -- committed redemption_count / revoked_at / expires_at after the previous one finishes.
  select ic.* into v_invitation
  from public.invitation_codes ic
  where ic.code = private.normalize_invitation_code(p_code)
  for update;

  v_result := private.check_invitation(v_invitation, v_uid);

  if v_result is not null and v_result <> 'already_member' then
    perform private.record_invitation_attempt(v_uid, false);
    return jsonb_build_object('ok', false, 'error', v_result);
  end if;

  insert into public.profiles (id, display_name)
  values (v_uid, v_name)
  on conflict (id) do update
    set display_name = excluded.display_name,
        updated_at = now();

  if v_result = 'already_member' then
    -- Keeps the existing role: an invitation never changes the role of an existing member.
    select m.* into v_membership
    from public.memberships m
    where m.community_id = v_invitation.community_id
      and m.user_id = v_uid;
  else
    insert into public.memberships (community_id, user_id, role)
    values (v_invitation.community_id, v_uid, v_invitation.role)
    returning * into v_membership;

    insert into public.invitation_redemptions (invitation_id, user_id)
    values (v_invitation.id, v_uid);

    update public.invitation_codes
    set redemption_count = redemption_count + 1
    where id = v_invitation.id;
  end if;

  perform private.record_invitation_attempt(v_uid, true);

  return jsonb_build_object(
    'ok', true,
    'community_id', v_membership.community_id,
    'membership_id', v_membership.id,
    'role', v_membership.role,
    'already_member', v_result is not distinct from 'already_member'
  );
exception
  when foreign_key_violation then
    -- The user was deleted while this call ran; everything this call wrote is rolled back.
    if private.auth_user_exists(v_uid) then
      raise;
    end if;
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
end;
$$;

-- Join gate: create_community_with_code ------------------------------------------------------------
-- As 20261120000100_c_qa_fixes.sql, plus consent_required right after the caller check (before
-- the request id, the replay lookup, the rate limit and the code).
create or replace function public.create_community_with_code(
  p_code text,
  p_name text,
  p_timezone text,
  p_display_name text,
  p_request_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_max_communities constant integer := 5;
  v_uid uuid := auth.uid();
  v_name text;
  v_display_name text;
  v_code public.community_creator_codes;
  v_previous public.community_creator_redemptions;
  v_result text;
  v_owned integer;
  v_community_id uuid;
  v_membership_id uuid;
begin
  if v_uid is null or not private.auth_user_exists(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not private.has_join_consent(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'consent_required');
  end if;
  if p_request_id is null then
    return jsonb_build_object('ok', false, 'error', 'validation_failed:request_id');
  end if;

  -- Serializes every code attempt of this user (invitations included): the replay lookup, the
  -- rate limit and the community count below are exact under concurrency.
  perform private.lock_invitation_attempts(v_uid);

  select r.* into v_previous
  from public.community_creator_redemptions r
  where r.user_id = v_uid
    and r.request_id = p_request_id;
  if found then
    return jsonb_build_object(
      'ok', true,
      'community_id', v_previous.community_id,
      'membership_id', v_previous.membership_id,
      'already_created', true
    );
  end if;

  if private.invitation_rate_limited(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  begin
    v_name := private.clean_required_text(p_name, 'name', 80, false);
  exception
    when sqlstate 'P0001' then
      return jsonb_build_object('ok', false, 'error', 'validation_failed:name');
  end;
  if not private.is_valid_timezone(p_timezone) then
    return jsonb_build_object('ok', false, 'error', 'validation_failed:timezone');
  end if;
  v_display_name := private.clean_display_name(p_display_name);
  if v_display_name is null then
    return jsonb_build_object('ok', false, 'error', 'validation_failed:display_name');
  end if;

  select count(*)::integer into v_owned
  from public.community_creator_redemptions r
  where r.user_id = v_uid;
  if v_owned >= c_max_communities then
    return jsonb_build_object('ok', false, 'error', 'community_limit_reached');
  end if;

  -- Row lock: concurrent uses of one code queue here and each re-reads the committed
  -- use_count / revoked_at after the previous one finishes.
  select cc.* into v_code
  from public.community_creator_codes cc
  where cc.code = private.normalize_invitation_code(p_code) for update;

  v_result := private.check_creator_code(v_code);
  if v_result is not null then
    perform private.record_invitation_attempt(v_uid, false);
    return jsonb_build_object('ok', false, 'error', v_result);
  end if;

  insert into public.communities (name, timezone)
  values (v_name, p_timezone)
  returning id into v_community_id;

  insert into public.profiles (id, display_name)
  values (v_uid, v_display_name)
  on conflict (id) do update
    set display_name = excluded.display_name,
        updated_at = now();

  insert into public.memberships (community_id, user_id, role)
  values (v_community_id, v_uid, 'organizer')
  returning id into v_membership_id;

  insert into public.community_creator_redemptions
    (code_id, user_id, community_id, membership_id, request_id)
  values
    (v_code.id, v_uid, v_community_id, v_membership_id, p_request_id);

  update public.community_creator_codes cc
  set use_count = cc.use_count + 1
  where cc.id = v_code.id;

  perform private.record_invitation_attempt(v_uid, true);

  return jsonb_build_object(
    'ok', true,
    'community_id', v_community_id,
    'membership_id', v_membership_id,
    'already_created', false
  );
exception
  when foreign_key_violation then
    -- The user was deleted while this call ran: the community, membership, redemption and the
    -- use are rolled back with the rest of this call.
    if private.auth_user_exists(v_uid) then
      raise;
    end if;
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
end;
$$;

-- Push consent: register_push_token ----------------------------------------------------------------
-- As 20261115000400_notifications_rpcs.sql, plus: requires push_notifications consent
-- (consent_required). Lock order: consent lock, then the profile (not_a_member), then the check;
-- withdraw_consent takes the consent lock before removing tokens, so a registration can never
-- slip in between a withdrawal's check and its token removal.
create or replace function public.register_push_token(
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

  perform private.lock_consents(v_uid);

  -- Serializes the caller's registrations (the 10-token cap). Profile first, then token rows:
  -- the order of an account deletion.
  perform 1 from public.profiles p where p.id = v_uid for no key update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;
  if not private.has_consent(v_uid, 'push_notifications') then
    raise exception using errcode = 'P0001', message = 'consent_required';
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

-- Grants -----------------------------------------------------------------------------------------

revoke all on function private.consent_purposes() from public, anon, authenticated, service_role;
revoke all on function private.guard_consent_ledger() from public, anon, authenticated, service_role;
revoke all on function private.privacy_version() from public, anon, authenticated, service_role;
revoke all on function private.terms_privacy_version() from public, anon, authenticated, service_role;
revoke all on function private.latest_consent(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.has_consent(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.lock_consents(uuid) from public, anon, authenticated, service_role;
revoke all on function private.next_consent_at(uuid) from public, anon, authenticated, service_role;
revoke all on function private.has_join_consent(uuid) from public, anon, authenticated, service_role;
revoke all on function private.consent_event_json(text, public.consent_records, boolean)
  from public, anon, authenticated, service_role;

revoke all on function public.admin_set_legal_version(text, text) from public, anon, authenticated, service_role;
revoke all on function public.record_consent(text, text) from public, anon, authenticated, service_role;
revoke all on function public.withdraw_consent(text) from public, anon, authenticated, service_role;
revoke all on function public.my_consents() from public, anon, authenticated, service_role;
revoke all on function public.redeem_invitation(text, text) from public, anon, authenticated, service_role;
revoke all on function public.create_community_with_code(text, text, text, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.register_push_token(text, text, text) from public, anon, authenticated, service_role;

grant execute on function public.admin_set_legal_version(text, text) to service_role;
grant execute on function public.record_consent(text, text) to authenticated;
grant execute on function public.withdraw_consent(text) to authenticated;
grant execute on function public.my_consents() to authenticated;
grant execute on function public.redeem_invitation(text, text) to authenticated;
grant execute on function public.create_community_with_code(text, text, text, text, uuid) to authenticated;
grant execute on function public.register_push_token(text, text, text) to authenticated;
