import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { admin, closeDb, resetData } from './helpers';
import { communityStats, history, memberStats, myStats, SeasonBuilder, summary } from './stats-helpers';

/**
 * M4-Q1: the hand-computed scenario of the Android manual script (docs/QA_REPORT.md, Milestone 4),
 * run against the database. The SQL below is the exact script the owner pastes into the Supabase
 * SQL editor to put the scenario into a real community; this test proves that the script works
 * (including that it leaves no notifications behind) and that the numbers written in the report
 * are what the statistics functions return.
 */

beforeEach(resetData);
afterAll(closeDb);

/** Edit the four names, then run it as the project owner. Past sessions only; nobody is notified. */
const SCENARIO_SQL = `
do $$
declare
  v_community uuid := (select id from public.communities where name = 'Test Pack');
  v_tz text;
  v_ana uuid; v_bogdan uuid; v_cora uuid;
  v_ids uuid[] := '{}';
  v_id uuid;
  r record;
begin
  select timezone into v_tz from public.communities where id = v_community;
  select p.id into v_ana from public.profiles p join public.memberships m on m.user_id = p.id
    where m.community_id = v_community and p.display_name = 'Ana';
  select p.id into v_bogdan from public.profiles p join public.memberships m on m.user_id = p.id
    where m.community_id = v_community and p.display_name = 'Bogdan';
  select p.id into v_cora from public.profiles p join public.memberships m on m.user_id = p.id
    where m.community_id = v_community and p.display_name = 'Cora';
  if v_community is null or v_ana is null or v_bogdan is null or v_cora is null then
    raise exception 'community or member names not found';
  end if;

  -- Five sessions: Run 1..4 finalized, Run 5 cancelled for too few signed up.
  for r in select * from (values
      (1, 'Run 1', 20, 'completed'), (2, 'Run 2', 15, 'completed'), (3, 'Run 3', 10, 'completed'),
      (4, 'Run 4', 6, 'completed'), (5, 'Run 5', 3, 'cancelled')
    ) as t(n, title, days_ago, kind)
  loop
    insert into public.training_sessions (
      community_id, title, starts_at, ends_at, rsvp_deadline, timezone, location_name,
      min_participants, status, cancel_reason, decided_at, cancelled_at, attendance_finalized_at)
    values (
      v_community, r.title,
      now() - r.days_ago * interval '1 day',
      now() - r.days_ago * interval '1 day' + interval '1 hour',
      now() - r.days_ago * interval '1 day' - interval '2 hours',
      v_tz, 'Park',
      case when r.kind = 'cancelled' then 3 else 2 end,
      r.kind::public.session_status,
      case when r.kind = 'cancelled' then 'insufficient_participation'::public.cancel_reason end,
      now() - r.days_ago * interval '1 day' - interval '2 hours',
      case when r.kind = 'cancelled' then now() - r.days_ago * interval '1 day' - interval '1 hour' end,
      case when r.kind = 'completed' then now() - r.days_ago * interval '1 day' + interval '2 hours' end)
    returning id into v_id;
    v_ids[r.n] := v_id;
  end loop;

  -- (session, member, RSVP, attendance). A null RSVP with 'present' is a walk-in.
  for r in select * from (values
      (1, 'A', 'going', 'present'),     (1, 'B', 'going', 'present'),   (1, 'C', 'going', 'present'),
      (2, 'A', 'going', 'present'),     (2, 'B', 'going', 'absent'),    (2, 'C', 'going', 'unrecorded'),
      (3, 'A', 'going', 'present'),     (3, 'B', 'not_going', null),    (3, 'C', 'going', 'present'),
      (4, 'A', 'going', 'absent'),      (4, 'B', 'going', 'present'),   (4, 'C', null, 'present'),
      (5, 'A', 'going', null)
    ) as t(n, who, rsvp, att)
  loop
    if r.rsvp is not null then
      insert into public.training_rsvps (session_id, community_id, user_id, response)
      values (v_ids[r.n], v_community,
              case r.who when 'A' then v_ana when 'B' then v_bogdan else v_cora end,
              r.rsvp::public.rsvp_response);
    end if;
    if r.att is not null then
      insert into public.attendance_records (session_id, community_id, user_id, status, had_rsvp_going, is_walk_in)
      values (v_ids[r.n], v_community,
              case r.who when 'A' then v_ana when 'B' then v_bogdan else v_cora end,
              r.att::public.attendance_status, coalesce(r.rsvp = 'going', false), r.rsvp is null);
    end if;
  end loop;

  update public.training_sessions s
  set going_count = (select count(*) from public.training_rsvps x where x.session_id = s.id and x.response = 'going')
  where s.id = any(v_ids);

  -- The insert trigger announced the sessions as new trainings: remove those rows.
  delete from public.notifications where related_session_id = any(v_ids);
end $$;
`;

/** Manual script step: correct one mark (MARK = present or absent). */
const CORRECT_SQL = `
update public.attendance_records set status = 'MARK'
where session_id = (select id from public.training_sessions
                    where title = 'Run 2' and community_id = (select id from public.communities where name = 'Test Pack'))
  and user_id = (select id from public.profiles where display_name = 'Bogdan');
`;

/** Manual script step: move Run 4 thirty days further into the past. */
const MOVE_SQL = `
update public.training_sessions
set starts_at = starts_at - interval '30 days', ends_at = ends_at - interval '30 days',
    rsvp_deadline = rsvp_deadline - interval '30 days'
where title = 'Run 4' and community_id = (select id from public.communities where name = 'Test Pack');
`;

async function scenario() {
  const season = await SeasonBuilder.create('Europe/Bucharest', 'Test Pack');
  const olga = await season.person({ role: 'organizer', name: 'Olga' });
  const ana = await season.person({ name: 'Ana' });
  const bogdan = await season.person({ name: 'Bogdan' });
  const cora = await season.person({ name: 'Cora' });
  await admin.query(SCENARIO_SQL);
  return { c: season.communityId, olga, ana, bogdan, cora };
}

describe('the manual-test scenario: 4 people, 5 sessions, numbers computed by hand', () => {
  it('the script runs, creates five sessions and leaves no notification behind', async () => {
    const w = await scenario();
    const { rows } = await admin.query<{ status: string; n: number }>(
      'select status::text, count(*)::int as n from public.training_sessions where community_id = $1 group by status order by status',
      [w.c],
    );
    expect(rows).toEqual([{ status: 'cancelled', n: 1 }, { status: 'completed', n: 4 }]);
    expect((await admin.query('select count(*)::int as n from public.notifications')).rows[0].n).toBe(0);
    expect((await admin.query('select count(*)::int as n from public.notification_delivery_jobs')).rows[0].n).toBe(0);
  });

  it('Ana, Bogdan, Cora and Olga: the member numbers of the report', async () => {
    const w = await scenario();
    expect(await myStats(w.ana, w.c, '30d')).toMatchObject({
      eligible: 4, attended: 3, absent: 1, not_recorded: 0, attendance_rate: 75, confirmed_rsvps: 4, missed: 1,
      rsvp_going_present: 3, rsvp_going_recorded: 4, rsvp_reliability: 75, walk_ins: 0,
    });
    expect(await myStats(w.bogdan, w.c, '30d')).toMatchObject({
      eligible: 4, attended: 2, absent: 1, not_recorded: 1, attendance_rate: 50, confirmed_rsvps: 3, missed: 1,
      rsvp_going_present: 2, rsvp_going_recorded: 3, rsvp_reliability: 66.7, walk_ins: 0,
    });
    expect(await myStats(w.cora, w.c, '30d')).toMatchObject({
      eligible: 4, attended: 3, absent: 0, not_recorded: 1, attendance_rate: 75, confirmed_rsvps: 3, missed: 0,
      rsvp_going_present: 2, rsvp_going_recorded: 2, rsvp_reliability: 100, walk_ins: 1,
    });
    expect(await memberStats(w.olga, w.c, w.olga, '30d')).toMatchObject({
      eligible: 4, attended: 0, absent: 0, not_recorded: 4, attendance_rate: 0, confirmed_rsvps: 0, rsvp_reliability: null,
    });
  });

  it('7 days: only Run 4 (the cancelled Run 5 never counts)', async () => {
    const w = await scenario();
    expect(await myStats(w.ana, w.c, '7d')).toMatchObject({ eligible: 1, attended: 0, absent: 1, attendance_rate: 0, missed: 1, rsvp_reliability: 0 });
    expect(await myStats(w.bogdan, w.c, '7d')).toMatchObject({ eligible: 1, attended: 1, attendance_rate: 100 });
    expect(await myStats(w.cora, w.c, '7d')).toMatchObject({ eligible: 1, attended: 1, walk_ins: 1, attendance_rate: 100, confirmed_rsvps: 0, rsvp_reliability: null });
    expect(await communityStats(w.olga, w.c, '7d')).toMatchObject({
      completed_trainings: 1, total_attendances: 2, average_attendees: 2, average_rsvp_participation: 2,
      rsvp_going_present: 1, rsvp_going_recorded: 2, rsvp_conversion: 50, cancelled_insufficient_participation: 1,
    });
  });

  it('the community numbers of the report (30 days)', async () => {
    const w = await scenario();
    const c = await communityStats(w.olga, w.c, '30d');
    expect(c).toMatchObject({
      completed_trainings: 4, total_attendances: 8, average_attendees: 2, average_attendees_sessions: 4, incomplete_sessions: 0,
      rsvp_going_total: 10, average_rsvp_participation: 2.5, rsvp_going_present: 7, rsvp_going_recorded: 9, rsvp_conversion: 77.8,
      active_members: 4, members_attended: 3, cancelled_insufficient_participation: 1, cancelled_by_organizer: 0, trend_unit: 'week',
    });
    expect(c.trend.reduce((n, b) => n + b.present, 0)).toBe(8);
    expect(c.trend.reduce((n, b) => n + b.sessions, 0)).toBe(4);
    expect(c.top_sessions.map((t) => [t.title, t.present])).toEqual([['Run 1', 3], ['Run 4', 2], ['Run 3', 2], ['Run 2', 1]]);
    const list = await summary(w.olga, w.c, '30d');
    expect(list.members.map((m) => [m.display_name, m.attendance_rate])).toEqual([['Ana', 75], ['Bogdan', 50], ['Cora', 75], ['Olga', 0]]);
  });

  it("Bogdan's history, newest first, as the History list shows it", async () => {
    const w = await scenario();
    const page = await history(w.bogdan, w.c, '30d', 20);
    expect(page.items.map((i) => [i.title, i.rsvp_response, i.outcome])).toEqual([
      ['Run 4', 'going', 'present'],
      ['Run 3', 'not_going', 'unrecorded'],
      ['Run 2', 'going', 'absent'],
      ['Run 1', 'going', 'present'],
    ]);
    expect(page.has_more).toBe(false);
  });
  it('step: a correction of one mark and a moved session change the numbers on the next call (SQL of the manual script)', async () => {
    const w = await scenario();
    // Correction: Bogdan was absent at Run 2, now present.
    await admin.query(CORRECT_SQL.replace('MARK', 'present'));
    expect(await myStats(w.bogdan, w.c, '30d')).toMatchObject({
      eligible: 4, attended: 3, absent: 0, not_recorded: 1, attendance_rate: 75, confirmed_rsvps: 3, missed: 0, rsvp_reliability: 100,
    });
    expect(await communityStats(w.olga, w.c, '30d')).toMatchObject({
      total_attendances: 9, average_attendees: 2.3, rsvp_going_present: 8, rsvp_going_recorded: 9, rsvp_conversion: 88.9,
    });
    // Undo it, then move Run 4 from 6 to 36 days ago: out of the 30 day window, still inside 90 days.
    await admin.query(CORRECT_SQL.replace('MARK', 'absent'));
    await admin.query(MOVE_SQL);
    expect((await admin.query('select count(*)::int as n from public.notifications')).rows[0].n).toBe(0);
    expect(await myStats(w.ana, w.c, '30d')).toMatchObject({ eligible: 3, attended: 3, absent: 0, attendance_rate: 100, missed: 0, rsvp_reliability: 100 });
    expect(await communityStats(w.olga, w.c, '30d')).toMatchObject({
      completed_trainings: 3, total_attendances: 6, average_attendees: 2, rsvp_going_total: 8, average_rsvp_participation: 2.7, members_attended: 3,
    });
    expect(await communityStats(w.olga, w.c, '90d')).toMatchObject({ completed_trainings: 4, total_attendances: 8, trend_unit: 'month' });
  });
});
