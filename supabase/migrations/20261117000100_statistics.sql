-- TrainHive M4-B1: statistics. Read-only RPCs over the Milestone 1-2 tables.
-- Definitions: docs/STATS_DEFINITIONS.md (authoritative). Contract: docs/API_CONTRACT.md
-- ("Milestone 4").
--
-- Shape of this file:
--   * private.stats_sessions   the session set S: finalized, non-cancelled, starts_at in window.
--   * private.stats_rows       THE eligibility rule (one row per person and session of S). Every
--                              member, community and summary number is an aggregate of it, so
--                              the functions cannot disagree.
--   * private.stats_*_payload  the jsonb payloads, taking the clock as a parameter (p_now) so
--                              tests can pin window edges and DST buckets exactly.
--   * public.get_* / list_*    authorization (auth.uid(), active membership / active organizer)
--                              and the call with now().
-- Everything is set based (no per-row loops), stable, and takes no locks: statistics are a
-- live read of the current rows, so a correction shows up on the next call.
--
-- Decisions where STATS_DEFINITIONS.md leaves room (also in the contract):
--   * The schema has no `left_at`, so "active when the session ended" is approximated: a
--     member's own numbers (E) only use joined_at <= starts_at (a removed member's history stays
--     readable to organizers), and the per-member community numbers (members_attended, the
--     summary list) only count currently active memberships.
--   * Session-level community numbers (total attendances, per-session present counts, average
--     attendees, RSVP conversion) count every real record of a session in S, as the definition
--     says ("no per-member eligibility"): a removed member's past attendance and a person who
--     joined at the training and was added as a walk-in still attended. stats_rows returns those
--     records with eligible = false, so: total_attendances = sum of `attended` over every
--     membership + present rows with eligible = false.
--   * Windows are N x 24 hours back from now() (not calendar days in some zone); starts_at in
--     [now - N*24h, now], both ends inclusive. 'all' has no lower bound (`from` is null).
--   * Weeks start on Monday (ISO), months are calendar months, both in the community's time
--     zone. Buckets run from the bucket that holds the window start (for 'all': the earliest
--     session of the set) to the bucket that holds now; empty buckets are included.
--   * Trend averages use the same "incomplete sessions excluded" rule as the overall average.
--   * Rates: round(100 * n / d, 1) on numeric, which rounds half away from zero (= half up for
--     these non-negative values). Null when d = 0.

-- Helpers ------------------------------------------------------------------------------------

-- The window start for p_window ('7d', '30d', '90d', 'all'), measured back from p_now.
-- Null for 'all'. Anything else (null included) raises validation_failed:window.
create function private.stats_window_start(p_window text, p_now timestamptz)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_window = '7d' then
    return p_now - interval '168 hours';
  elsif p_window = '30d' then
    return p_now - interval '720 hours';
  elsif p_window = '90d' then
    return p_now - interval '2160 hours';
  elsif p_window = 'all' then
    return null;
  end if;
  raise exception using errcode = 'P0001', message = 'validation_failed:window';
end;
$$;

-- A percentage with one decimal, null on a zero denominator.
create function private.stats_rate(p_numerator integer, p_denominator integer)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p_denominator > 0 then round(100.0 * p_numerator / p_denominator, 1)
  end;
$$;

-- An average with one decimal, null on a zero denominator.
create function private.stats_average(p_total integer, p_count integer)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p_count > 0 then round(p_total::numeric / p_count, 1)
  end;
$$;

-- Calendar buckets ('week': Monday-based, 'month') in p_timezone, from the bucket holding
-- p_first to the bucket holding p_last. `period` is the local start date ('YYYY-MM-DD') for
-- weeks and 'YYYY-MM' for months; period_from / period_to are the bucket's instants (DST-aware:
-- the series runs on local wall-clock time and is converted back per bucket). No rows when
-- p_first is null.
create function private.stats_buckets(
  p_timezone text,
  p_unit text,
  p_first timestamptz,
  p_last timestamptz
) returns table (period text, period_from timestamptz, period_to timestamptz)
language sql
stable
set search_path = ''
as $$
  select
    case when p_unit = 'month' then to_char(g.local_start, 'YYYY-MM')
         else to_char(g.local_start, 'YYYY-MM-DD') end,
    g.local_start at time zone p_timezone,
    (g.local_start + case when p_unit = 'month' then interval '1 month' else interval '7 days' end)
      at time zone p_timezone
  from generate_series(
    date_trunc(p_unit, p_first at time zone p_timezone),
    date_trunc(p_unit, p_last at time zone p_timezone),
    case when p_unit = 'month' then interval '1 month' else interval '7 days' end
  ) as g(local_start)
  where p_first is not null
    and p_unit in ('week', 'month');
$$;

-- S: the community's finalized, non-cancelled sessions with starts_at in [p_from, p_to]
-- (p_from null = no lower bound). Uses the session's CURRENT starts_at.
create function private.stats_sessions(p_community_id uuid, p_from timestamptz, p_to timestamptz)
returns setof public.training_sessions
language sql
stable
set search_path = ''
as $$
  select s.*
  from public.training_sessions s
  where s.community_id = p_community_id
    and s.status = 'completed' and s.attendance_finalized_at is not null and s.cancel_reason is null
    and (p_from is null or s.starts_at >= p_from)
    and s.starts_at <= p_to;
$$;

-- The eligibility rule (STATS_DEFINITIONS rule 3), one row per (session of S, person):
--   * eligible = true: every membership of the community (any role, any status) that started
--     at or before the session's start, whether or not it has an RSVP or a record;
--   * eligible = false: every attendance record of a session of S whose person was not
--     eligible (joined after the start). Real attendance of the session, not of the person.
-- rsvp is no_response without an RSVP row; attendance is unrecorded without a record (never
-- absent). membership_status is the CURRENT status. p_user_id narrows it to one person.
create function private.stats_rows(
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
  pairs as (
    select s.id as session_id, s.starts_at, m.user_id, m.status as membership_status,
           true as eligible
    from s
    join public.memberships m
      on m.community_id = p_community_id
     and m.joined_at <= s.starts_at
    where p_user_id is null or m.user_id = p_user_id
    union all
    select s.id, s.starts_at, a.user_id, m.status, false
    from s
    join public.attendance_records a on a.session_id = s.id
    left join public.memberships m
      on m.community_id = p_community_id
     and m.user_id = a.user_id
    where (m.id is null or m.joined_at > s.starts_at)
      and (p_user_id is null or a.user_id = p_user_id)
  )
  select p.session_id, p.starts_at, p.user_id, p.membership_status, p.eligible,
         coalesce(r.response, 'no_response'::public.rsvp_response),
         coalesce(a.status, 'unrecorded'::public.attendance_status),
         a.id is not null,
         coalesce(a.is_walk_in, false)
  from pairs p
  left join public.training_rsvps r
    on r.session_id = p.session_id
   and r.user_id = p.user_id
  left join public.attendance_records a
    on a.session_id = p.session_id
   and a.user_id = p.user_id;
$$;

-- Payloads -----------------------------------------------------------------------------------

-- Member statistics of p_user_id in p_community_id (no authorization here).
create function private.stats_member_payload(
  p_community_id uuid,
  p_user_id uuid,
  p_window text,
  p_now timestamptz
) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_from timestamptz := private.stats_window_start(p_window, p_now);
  v_timezone text;
  v_membership public.memberships;
  v_result jsonb;
begin
  select c.timezone into v_timezone from public.communities c where c.id = p_community_id;
  select m.* into v_membership
  from public.memberships m
  where m.community_id = p_community_id
    and m.user_id = p_user_id;

  with e as (
    select r.*
    from private.stats_rows(p_community_id, v_from, p_now, p_user_id) r
    where r.eligible
  ),
  t as (
    select
      count(*)::integer as eligible,
      count(*) filter (where e.attendance = 'present')::integer as attended,
      count(*) filter (where e.attendance = 'absent')::integer as absent,
      count(*) filter (where e.attendance = 'unrecorded')::integer as not_recorded,
      count(*) filter (where e.rsvp = 'going')::integer as confirmed_rsvps,
      count(*) filter (where e.rsvp = 'going' and e.attendance = 'absent')::integer as missed,
      count(*) filter (where e.rsvp = 'going' and e.attendance = 'present')::integer as going_present,
      count(*) filter (where e.rsvp = 'going' and e.attendance in ('present', 'absent'))::integer
        as going_recorded,
      count(*) filter (where e.attendance = 'present' and e.is_walk_in)::integer as walk_ins,
      min(e.starts_at) as first_start
    from e
  ),
  months as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'period', b.period,
          'from', b.period_from,
          'to', b.period_to,
          'eligible', b.eligible,
          'attended', b.attended,
          'attendance_rate', private.stats_rate(b.attended, b.eligible)
        )
        order by b.period_from
      ),
      '[]'::jsonb
    ) as list
    from (
      select k.period, k.period_from, k.period_to,
             count(e.session_id)::integer as eligible,
             count(e.session_id) filter (where e.attendance = 'present')::integer as attended
      from t
      cross join lateral private.stats_buckets(
        v_timezone, 'month', coalesce(v_from, t.first_start), p_now
      ) k
      left join e
        on e.starts_at >= k.period_from
       and e.starts_at < k.period_to
      group by k.period, k.period_from, k.period_to
    ) b
  )
  select jsonb_build_object(
    'window', p_window,
    'from', v_from,
    'to', p_now,
    'generated_at', now(),
    'timezone', v_timezone,
    'community_id', p_community_id,
    'user_id', p_user_id,
    'membership_status', v_membership.status,
    'role', v_membership.role,
    'joined_at', v_membership.joined_at,
    'eligible', t.eligible,
    'attended', t.attended,
    'absent', t.absent,
    'not_recorded', t.not_recorded,
    'recorded', t.attended + t.absent,
    'attendance_rate', private.stats_rate(t.attended, t.eligible),
    'confirmed_rsvps', t.confirmed_rsvps,
    'missed', t.missed,
    'rsvp_going_present', t.going_present,
    'rsvp_going_recorded', t.going_recorded,
    'rsvp_reliability', private.stats_rate(t.going_present, t.going_recorded),
    'walk_ins', t.walk_ins,
    'monthly', months.list
  ) into v_result
  from t, months;

  return v_result;
end;
$$;

-- The member's sessions of E, newest first, with keyset pagination on starts_at (p_before is
-- exclusive). A page never splits sessions that share one starts_at: it stops before such a
-- group, or (when the whole page would be one group) returns the whole group, so a client that
-- passes next_before back verbatim never skips or repeats a session.
create function private.stats_history_payload(
  p_community_id uuid,
  p_user_id uuid,
  p_window text,
  p_limit integer,
  p_before timestamptz,
  p_now timestamptz
) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_from timestamptz := private.stats_window_start(p_window, p_now);
  v_count integer;
  v_min timestamptz;
  v_max timestamptz;
  v_low timestamptz;
  v_low_inclusive boolean := false;
  v_items jsonb;
  v_next timestamptz;
  v_more boolean := false;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using errcode = 'P0001', message = 'validation_failed:limit';
  end if;

  select count(*)::integer, min(c.starts_at), max(c.starts_at)
  into v_count, v_min, v_max
  from (
    select r.starts_at
    from private.stats_rows(p_community_id, v_from, p_now, p_user_id) r
    where r.eligible
      and (p_before is null or r.starts_at < p_before)
    order by r.starts_at desc
    limit p_limit + 1
  ) c;

  if v_count > p_limit then
    v_low := v_min;
    -- Every candidate shares one start: return that whole group.
    v_low_inclusive := v_min = v_max;
  end if;

  with page as (
    select r.*
    from private.stats_rows(p_community_id, v_from, p_now, p_user_id) r
    where r.eligible
      and (p_before is null or r.starts_at < p_before)
      and (v_low is null or r.starts_at > v_low or (v_low_inclusive and r.starts_at = v_low))
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'session_id', s.id,
          'title', s.title,
          'activity_type', s.activity_type,
          'starts_at', s.starts_at,
          'ends_at', s.ends_at,
          'timezone', s.timezone,
          'location_name', s.location_name,
          'rsvp_response', page.rsvp,
          'outcome', page.attendance,
          'is_walk_in', page.is_walk_in
        )
        order by s.starts_at desc, s.id desc
      ),
      '[]'::jsonb
    ),
    min(s.starts_at)
  into v_items, v_next
  from page
  join public.training_sessions s on s.id = page.session_id;

  if v_count > p_limit then
    v_more := exists (
      select 1
      from private.stats_rows(p_community_id, v_from, p_now, p_user_id) r
      where r.eligible
        and r.starts_at < v_next
    );
  end if;

  return jsonb_build_object(
    'window', p_window,
    'from', v_from,
    'to', p_now,
    'generated_at', now(),
    'items', v_items,
    'has_more', v_more,
    'next_before', case when v_more then v_next end
  );
end;
$$;

-- Organizer overview of p_community_id (no authorization here).
create function private.stats_community_payload(
  p_community_id uuid,
  p_window text,
  p_now timestamptz
) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_from timestamptz := private.stats_window_start(p_window, p_now);
  v_unit text := case when p_window in ('7d', '30d') then 'week' else 'month' end;
  v_timezone text;
  v_active integer;
  v_cancelled_min integer;
  v_cancelled_org integer;
  v_result jsonb;
begin
  select c.timezone into v_timezone from public.communities c where c.id = p_community_id;

  select count(*)::integer into v_active
  from public.memberships m
  where m.community_id = p_community_id
    and m.status = 'active';

  -- The only numbers that look at cancelled sessions.
  select
    count(*) filter (where s.cancel_reason = 'insufficient_participation')::integer,
    count(*) filter (where s.cancel_reason = 'organizer')::integer
  into v_cancelled_min, v_cancelled_org
  from public.training_sessions s
  where s.community_id = p_community_id
    and s.status = 'cancelled'
    and (v_from is null or s.starts_at >= v_from)
    and s.starts_at <= p_now;

  with r as (
    select x.* from private.stats_rows(p_community_id, v_from, p_now, null) x
  ),
  per_session as (
    select s.id, s.title, s.starts_at, s.timezone, s.min_participants, s.going_count,
           coalesce(a.present, 0) as present,
           coalesce(a.marked, 0) as marked
    from private.stats_sessions(p_community_id, v_from, p_now) s
    left join (
      select r.session_id,
             count(*) filter (where r.attendance = 'present')::integer as present,
             count(*) filter (where r.attendance in ('present', 'absent'))::integer as marked
      from r
      group by r.session_id
    ) a on a.session_id = s.id
  ),
  t as (
    select
      count(*)::integer as completed,
      coalesce(sum(ps.present), 0)::integer as total_present,
      coalesce(sum(ps.present) filter (where ps.marked > 0), 0)::integer as counted_present,
      count(*) filter (where ps.marked > 0)::integer as counted,
      count(*) filter (where ps.marked = 0)::integer as incomplete,
      coalesce(sum(ps.going_count), 0)::integer as going_total,
      min(ps.starts_at) as first_start
    from per_session ps
  ),
  conv as (
    select
      count(*) filter (where r.rsvp = 'going' and r.attendance = 'present')::integer
        as going_present,
      count(*) filter (where r.rsvp = 'going' and r.attendance in ('present', 'absent'))::integer
        as going_recorded,
      count(distinct r.user_id) filter (
        where r.eligible and r.membership_status = 'active' and r.attendance = 'present'
      )::integer as members_attended
    from r
  ),
  trend as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'period', b.period,
          'from', b.period_from,
          'to', b.period_to,
          'sessions', b.sessions,
          'present', b.present,
          'incomplete_sessions', b.sessions - b.counted,
          'average_attendees', private.stats_average(b.counted_present, b.counted)
        )
        order by b.period_from
      ),
      '[]'::jsonb
    ) as list
    from (
      select k.period, k.period_from, k.period_to,
             count(ps.id)::integer as sessions,
             coalesce(sum(ps.present), 0)::integer as present,
             count(ps.id) filter (where ps.marked > 0)::integer as counted,
             coalesce(sum(ps.present) filter (where ps.marked > 0), 0)::integer as counted_present
      from t
      cross join lateral private.stats_buckets(
        v_timezone, v_unit, coalesce(v_from, t.first_start), p_now
      ) k
      left join per_session ps
        on ps.starts_at >= k.period_from
       and ps.starts_at < k.period_to
      group by k.period, k.period_from, k.period_to
    ) b
  ),
  top as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'session_id', x.id,
          'title', x.title,
          'starts_at', x.starts_at,
          'timezone', x.timezone,
          'present', x.present,
          'min_participants', x.min_participants,
          'going_count', x.going_count
        )
        order by x.present desc, x.starts_at desc, x.id desc
      ),
      '[]'::jsonb
    ) as list
    from (
      select ps.*
      from per_session ps
      order by ps.present desc, ps.starts_at desc, ps.id desc
      limit 5
    ) x
  )
  select jsonb_build_object(
    'window', p_window,
    'from', v_from,
    'to', p_now,
    'generated_at', now(),
    'timezone', v_timezone,
    'community_id', p_community_id,
    'completed_trainings', t.completed,
    'total_attendances', t.total_present,
    'average_attendees', private.stats_average(t.counted_present, t.counted),
    'average_attendees_sessions', t.counted,
    'incomplete_sessions', t.incomplete,
    'rsvp_going_total', t.going_total,
    'average_rsvp_participation', private.stats_average(t.going_total, t.completed),
    'rsvp_going_present', conv.going_present,
    'rsvp_going_recorded', conv.going_recorded,
    'rsvp_conversion', private.stats_rate(conv.going_present, conv.going_recorded),
    'active_members', v_active,
    'members_attended', conv.members_attended,
    'cancelled_insufficient_participation', v_cancelled_min,
    'cancelled_by_organizer', v_cancelled_org,
    'trend_unit', v_unit,
    'trend', trend.list,
    'top_sessions', top.list
  ) into v_result
  from t, conv, trend, top;

  return v_result;
end;
$$;

-- One line per ACTIVE member (any role), ordered by display name, at most 500.
create function private.stats_summary_payload(
  p_community_id uuid,
  p_window text,
  p_now timestamptz
) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_from timestamptz := private.stats_window_start(p_window, p_now);
  v_result jsonb;
begin
  with e as (
    select x.*
    from private.stats_rows(p_community_id, v_from, p_now, null) x
    where x.eligible
      and x.membership_status = 'active'
  ),
  agg as (
    select
      e.user_id,
      count(*)::integer as eligible,
      count(*) filter (where e.attendance = 'present')::integer as attended,
      count(*) filter (where e.attendance = 'absent')::integer as absent,
      count(*) filter (where e.attendance = 'unrecorded')::integer as not_recorded,
      count(*) filter (where e.rsvp = 'going')::integer as confirmed_rsvps,
      count(*) filter (where e.rsvp = 'going' and e.attendance = 'absent')::integer as missed,
      count(*) filter (where e.rsvp = 'going' and e.attendance = 'present')::integer as going_present,
      count(*) filter (where e.rsvp = 'going' and e.attendance in ('present', 'absent'))::integer
        as going_recorded,
      count(*) filter (where e.attendance = 'present' and e.is_walk_in)::integer as walk_ins
    from e
    group by e.user_id
  ),
  people as (
    select m.user_id, p.display_name, m.role, m.joined_at,
           coalesce(agg.eligible, 0) as eligible,
           coalesce(agg.attended, 0) as attended,
           coalesce(agg.absent, 0) as absent,
           coalesce(agg.not_recorded, 0) as not_recorded,
           coalesce(agg.confirmed_rsvps, 0) as confirmed_rsvps,
           coalesce(agg.missed, 0) as missed,
           coalesce(agg.going_present, 0) as going_present,
           coalesce(agg.going_recorded, 0) as going_recorded,
           coalesce(agg.walk_ins, 0) as walk_ins
    from public.memberships m
    join public.profiles p on p.id = m.user_id
    left join agg on agg.user_id = m.user_id
    where m.community_id = p_community_id
      and m.status = 'active'
  ),
  shown as (
    select x.*
    from people x
    order by x.display_name, x.user_id
    limit 500
  )
  select jsonb_build_object(
    'window', p_window,
    'from', v_from,
    'to', p_now,
    'generated_at', now(),
    'community_id', p_community_id,
    'total_members', (select count(*)::integer from people),
    'truncated', (select count(*) from people) > 500,
    'members', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'user_id', x.user_id,
            'display_name', x.display_name,
            'role', x.role,
            'joined_at', x.joined_at,
            'eligible', x.eligible,
            'attended', x.attended,
            'absent', x.absent,
            'not_recorded', x.not_recorded,
            'attendance_rate', private.stats_rate(x.attended, x.eligible),
            'confirmed_rsvps', x.confirmed_rsvps,
            'missed', x.missed,
            'rsvp_going_present', x.going_present,
            'rsvp_going_recorded', x.going_recorded,
            'rsvp_reliability', private.stats_rate(x.going_present, x.going_recorded),
            'walk_ins', x.walk_ins
          )
          order by x.display_name, x.user_id
        )
        from shown x
      ),
      '[]'::jsonb
    )
  ) into v_result;

  return v_result;
end;
$$;

-- Public RPCs --------------------------------------------------------------------------------
-- Order of checks: not_authenticated, then authorization, then input. Unknown communities get
-- the same answer as communities the caller is not in.

create function public.get_my_statistics(p_community_id uuid, p_window text)
returns jsonb
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
  return private.stats_member_payload(p_community_id, v_uid, p_window, now());
end;
$$;

create function public.get_my_attendance_history(
  p_community_id uuid,
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
  if p_community_id is null or not public.is_active_member(p_community_id) then
    raise exception using errcode = 'P0001', message = 'not_a_member';
  end if;
  return private.stats_history_payload(p_community_id, v_uid, p_window, p_limit, p_before, now());
end;
$$;

-- An organizer reads one member's statistics. The member may be removed (their history stays
-- readable); a user without any membership in this community is not_found.
create function public.get_member_statistics(p_community_id uuid, p_user_id uuid, p_window text)
returns jsonb
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
  return private.stats_member_payload(p_community_id, p_user_id, p_window, now());
end;
$$;

create function public.get_community_statistics(p_community_id uuid, p_window text)
returns jsonb
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
  return private.stats_community_payload(p_community_id, p_window, now());
end;
$$;

create function public.list_member_statistics_summary(p_community_id uuid, p_window text)
returns jsonb
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
  return private.stats_summary_payload(p_community_id, p_window, now());
end;
$$;

-- Grants -------------------------------------------------------------------------------------

revoke all on function private.stats_window_start(text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.stats_rate(integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function private.stats_average(integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function private.stats_buckets(text, text, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.stats_sessions(uuid, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.stats_rows(uuid, timestamptz, timestamptz, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.stats_member_payload(uuid, uuid, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.stats_history_payload(uuid, uuid, text, integer, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.stats_community_payload(uuid, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.stats_summary_payload(uuid, text, timestamptz)
  from public, anon, authenticated, service_role;

revoke all on function public.get_my_statistics(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.get_my_attendance_history(uuid, text, integer, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.get_member_statistics(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.get_community_statistics(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.list_member_statistics_summary(uuid, text)
  from public, anon, authenticated, service_role;

grant execute on function public.get_my_statistics(uuid, text) to authenticated;
grant execute on function public.get_my_attendance_history(uuid, text, integer, timestamptz)
  to authenticated;
grant execute on function public.get_member_statistics(uuid, uuid, text) to authenticated;
grant execute on function public.get_community_statistics(uuid, text) to authenticated;
grant execute on function public.list_member_statistics_summary(uuid, text) to authenticated;
