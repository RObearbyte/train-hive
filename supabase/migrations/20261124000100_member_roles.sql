-- TrainHive GDPR G2 (part 1): organizer tools that account deletion depends on.
-- Plan: docs/GDPR_PLAN.md section 3 (erasure: the last organizer cannot leave a community that
-- still has members). Contract: docs/API_CONTRACT.md ("GDPR G2 — export and deletion").
--
--   set_member_role(community, user, role)   organizer promotes / demotes another active member
--   remove_member(community, user)           organizer removes another member (status removed)
--   leave_community(community)               a member leaves (status removed)
--
-- Invariant: a community that has active members always keeps at least one active organizer.
-- Every path that can shrink the set of active organizers of a community (these three functions
-- and account deletion, next migration) takes private.lock_community_roles(community) and only
-- then counts the remaining organizers, so two concurrent demotions / removals / departures /
-- deletions are serialized and can never leave zero organizers behind.
--
-- Lock order (extends the Milestone 1 order profile -> membership -> session):
--   [invitation codes of the community (leave_community, deletion)] -> profile row(s)
--   -> community role lock (advisory, in community id order) -> membership rows -> session rows.
-- Removing a membership (status 'removed') fires the existing trigger that releases the member's
-- going RSVPs on open sessions (membership -> session, as before) and keeps every history row.

-- The per-community role lock -------------------------------------------------------------------

create function private.lock_community_roles(p_community_id uuid) returns void
language sql
volatile
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('community_roles:' || p_community_id::text, 0));
$$;

-- True when the community has an active organizer other than p_user_id.
create function private.has_other_organizer(p_community_id uuid, p_user_id uuid) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.community_id = p_community_id
      and m.user_id <> p_user_id
      and m.status = 'active'
      and m.role = 'organizer'
  );
$$;

-- True when the community has an active member (any role) other than p_user_id.
create function private.has_other_member(p_community_id uuid, p_user_id uuid) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.community_id = p_community_id
      and m.user_id <> p_user_id
      and m.status = 'active'
  );
$$;

-- Caller checks shared by set_member_role and remove_member, after the locks: the caller still
-- holds an active organizer membership (share-locked, so it holds until commit).
create function private.lock_caller_organizer(p_community_id uuid, p_caller_id uuid) returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  perform 1
  from public.memberships m
  where m.community_id = p_community_id
    and m.user_id = p_caller_id
    and m.status = 'active'
    and m.role = 'organizer'
  for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
end;
$$;

-- set_member_role ------------------------------------------------------------------------------
-- Organizer only. The target must be an ACTIVE member of the community (else not_found: unknown
-- user, removed member, member of another community). The caller cannot change their own role
-- (cannot_change_own_role; hand the role over by promoting someone, who then demotes you).
-- Same role again: the row is returned unchanged. Demoting the last active organizer is refused
-- (last_organizer); with the caller check above this cannot happen through this function, but
-- the rule is kept here so it holds whatever the caller rules become.

create function public.set_member_role(
  p_community_id uuid,
  p_user_id uuid,
  p_role public.membership_role
) returns public.memberships
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_target public.memberships;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  -- Also the answer for an unknown community, so ids cannot be probed.
  if p_community_id is null or not public.is_organizer(p_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  if p_user_id is null then
    raise exception using errcode = 'P0001', message = 'validation_failed:user_id';
  end if;
  if p_role is null then
    raise exception using errcode = 'P0001', message = 'validation_failed:role';
  end if;
  if p_user_id = v_uid then
    raise exception using errcode = 'P0001', message = 'cannot_change_own_role';
  end if;

  perform 1 from public.profiles p where p.id = v_uid for key share;
  perform private.lock_community_roles(p_community_id);
  -- Re-checked after the lock waits: the caller may have been demoted, removed or deleted.
  perform private.lock_caller_organizer(p_community_id, v_uid);

  select m.* into v_target
  from public.memberships m
  where m.community_id = p_community_id
    and m.user_id = p_user_id
  for update;
  if not found or v_target.status <> 'active' then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  if v_target.role = p_role then
    return v_target;
  end if;

  if v_target.role = 'organizer' and not private.has_other_organizer(p_community_id, p_user_id) then
    raise exception using errcode = 'P0001', message = 'last_organizer';
  end if;

  update public.memberships m
  set role = p_role
  where m.id = v_target.id
  returning * into v_target;

  return v_target;
end;
$$;

-- remove_member --------------------------------------------------------------------------------
-- Organizer only. Sets the target's membership to `removed`: the existing trigger releases their
-- going RSVPs on open sessions; RSVPs, attendance and audit history stay. A removed member cannot
-- rejoin by code. The caller cannot remove themselves (cannot_remove_self; use leave_community).
-- Already removed: the row is returned unchanged. Unknown user / no membership: not_found.
-- Removing the last active organizer is refused (last_organizer; unreachable while the caller
-- must be another active organizer, kept as a rule).

create function public.remove_member(p_community_id uuid, p_user_id uuid)
returns public.memberships
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_target public.memberships;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if p_community_id is null or not public.is_organizer(p_community_id) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  if p_user_id is null then
    raise exception using errcode = 'P0001', message = 'validation_failed:user_id';
  end if;
  if p_user_id = v_uid then
    raise exception using errcode = 'P0001', message = 'cannot_remove_self';
  end if;

  perform 1 from public.profiles p where p.id = v_uid for key share;
  perform private.lock_community_roles(p_community_id);
  perform private.lock_caller_organizer(p_community_id, v_uid);

  select m.* into v_target
  from public.memberships m
  where m.community_id = p_community_id
    and m.user_id = p_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  if v_target.status = 'removed' then
    return v_target;
  end if;

  if v_target.role = 'organizer' and not private.has_other_organizer(p_community_id, p_user_id) then
    raise exception using errcode = 'P0001', message = 'last_organizer';
  end if;

  update public.memberships m
  set status = 'removed'
  where m.id = v_target.id
  returning * into v_target;

  return v_target;
end;
$$;

-- leave_community ------------------------------------------------------------------------------
-- Any member leaves a community (status `removed`, history kept, RSVPs on open sessions released;
-- they cannot rejoin by code). The last active organizer cannot leave while other active members
-- remain (last_organizer): promote someone first. The last active member CAN leave; the community
-- then has nobody left, so its open invitation codes are revoked in the same transaction (nobody
-- can join a community without an organizer). Already removed: { changed: false }. No membership
-- at all (or no profile): not_a_member.
-- The community's invitation codes are locked first (a join locks its code row first), so a join
-- cannot slip in between the "anyone left?" check and the revocation.

create function public.leave_community(p_community_id uuid) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_membership public.memberships;
  v_revoked integer := 0;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if p_community_id is null then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;

  -- Only an active member gets as far as locking the community's codes.
  if public.is_active_member(p_community_id) then
    perform 1
    from public.invitation_codes ic
    where ic.community_id = p_community_id
    order by ic.id
    for update;
  end if;

  perform 1 from public.profiles p where p.id = v_uid for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;
  perform private.lock_community_roles(p_community_id);

  select m.* into v_membership
  from public.memberships m
  where m.community_id = p_community_id
    and m.user_id = v_uid
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;

  if v_membership.status = 'removed' then
    return jsonb_build_object(
      'community_id', v_membership.community_id,
      'membership_id', v_membership.id,
      'status', v_membership.status,
      'changed', false,
      'invitations_revoked', 0
    );
  end if;

  if v_membership.role = 'organizer'
     and not private.has_other_organizer(p_community_id, v_uid)
     and private.has_other_member(p_community_id, v_uid) then
    raise exception using errcode = 'P0001', message = 'last_organizer';
  end if;

  update public.memberships m
  set status = 'removed'
  where m.id = v_membership.id
  returning * into v_membership;

  if not private.has_other_member(p_community_id, v_uid) then
    update public.invitation_codes ic
    set revoked_at = clock_timestamp()
    where ic.community_id = p_community_id
      and ic.revoked_at is null;
    get diagnostics v_revoked = row_count;
  end if;

  return jsonb_build_object(
    'community_id', v_membership.community_id,
    'membership_id', v_membership.id,
    'status', v_membership.status,
    'changed', true,
    'invitations_revoked', v_revoked
  );
end;
$$;

-- Grants -----------------------------------------------------------------------------------------

revoke all on function private.lock_community_roles(uuid) from public, anon, authenticated, service_role;
revoke all on function private.has_other_organizer(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.has_other_member(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.lock_caller_organizer(uuid, uuid) from public, anon, authenticated, service_role;

revoke all on function public.set_member_role(uuid, uuid, public.membership_role)
  from public, anon, authenticated, service_role;
revoke all on function public.remove_member(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.leave_community(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.set_member_role(uuid, uuid, public.membership_role) to authenticated;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
grant execute on function public.leave_community(uuid) to authenticated;
