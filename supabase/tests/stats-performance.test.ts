import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { admin, closeDb, resetData } from './helpers';
import { communityStats, history, memberStats, myStats, summary, type StatsWindow } from './stats-helpers';

/**
 * M4-B1: performance sanity on a generated community of 300 members x 150 finalized sessions
 * (about 45 000 member-session pairs, ~27 000 RSVPs and records). Bounds are generous (the
 * embedded Postgres on a busy Windows laptop); the measured times are printed for the report.
 * The data is generated set-based in SQL with deterministic pseudo-random choices.
 */

const MEMBERS = 300;
const SESSIONS = 150;
const BOUND_MS = 5_000;

let communityId: string;
let organizerId: string;
let memberId: string;

beforeAll(async () => {
  await resetData();
  const { rows } = await admin.query<{ id: string }>(
    "insert into public.communities (name, timezone) values ('Big Pack', 'Europe/Bucharest') returning id",
  );
  communityId = rows[0].id;
  // Sessions first: the training_created trigger then has no recipients to notify.
  await admin.query(
    `insert into public.training_sessions (
       community_id, title, starts_at, ends_at, rsvp_deadline, timezone, location_name,
       min_participants, status, decided_at, attendance_finalized_at)
     select $1, 'Run ' || i, now() - i * interval '12 hours', now() - i * interval '12 hours' + interval '1 hour',
            now() - i * interval '12 hours' - interval '2 hours', 'Europe/Bucharest', 'Park', 1,
            'completed', now() - i * interval '12 hours' - interval '2 hours',
            now() - i * interval '12 hours' + interval '2 hours'
     from generate_series(1, $2::int) as i`,
    [communityId, SESSIONS],
  );
  // Members: one organizer plus MEMBERS - 1 members; every 10th joined 30 days ago.
  await admin.query(
    `with u as (
       insert into auth.users (is_anonymous) select true from generate_series(1, $2::int) returning id
     ), numbered as (
       select id, row_number() over (order by id) as n from u
     ), p as (
       insert into public.profiles (id, display_name)
       select id, 'Runner ' || lpad(n::text, 3, '0') from numbered returning id
     )
     insert into public.memberships (community_id, user_id, role, joined_at)
     select $1, numbered.id,
            (case when n = 1 then 'organizer' else 'member' end)::public.membership_role,
            case when n % 10 = 0 then now() - interval '30 days' else now() - interval '400 days' end
     from numbered`,
    [communityId, MEMBERS],
  );
  // RSVPs: ~60 % of eligible pairs going, ~10 % not going.
  await admin.query(
    `insert into public.training_rsvps (session_id, community_id, user_id, response)
     select s.id, s.community_id, m.user_id,
            (case when abs(hashtext(s.id::text || m.user_id::text)) % 100 < 60 then 'going' else 'not_going' end)::public.rsvp_response
     from public.training_sessions s
     join public.memberships m on m.community_id = s.community_id and m.joined_at <= s.starts_at
     where s.community_id = $1 and abs(hashtext(s.id::text || m.user_id::text)) % 100 < 70`,
    [communityId],
  );
  await admin.query(
    `update public.training_sessions s
     set going_count = (select count(*) from public.training_rsvps r where r.session_id = s.id and r.response = 'going')
     where s.community_id = $1`,
    [communityId],
  );
  // Records for going RSVPs: ~80 % present, ~10 % absent, ~10 % unrecorded.
  await admin.query(
    `insert into public.attendance_records (session_id, community_id, user_id, status, had_rsvp_going, is_walk_in)
     select r.session_id, r.community_id, r.user_id,
            (case when abs(hashtext(r.user_id::text || r.session_id::text)) % 10 < 8 then 'present'
                  when abs(hashtext(r.user_id::text || r.session_id::text)) % 10 = 8 then 'absent'
                  else 'unrecorded' end)::public.attendance_status,
            true, false
     from public.training_rsvps r
     where r.community_id = $1 and r.response = 'going'`,
    [communityId],
  );
  // Walk-ins: ~5 % of the eligible pairs without a going RSVP.
  await admin.query(
    `insert into public.attendance_records (session_id, community_id, user_id, status, had_rsvp_going, is_walk_in)
     select s.id, s.community_id, m.user_id, 'present', false, true
     from public.training_sessions s
     join public.memberships m on m.community_id = s.community_id and m.joined_at <= s.starts_at
     left join public.training_rsvps r on r.session_id = s.id and r.user_id = m.user_id
     where s.community_id = $1 and r.response is distinct from 'going'
       and abs(hashtext(m.user_id::text || s.id::text || 'w')) % 100 < 5`,
    [communityId],
  );
  await admin.query('analyze');
  const people = await admin.query<{ user_id: string; role: string }>(
    "select user_id, role from public.memberships where community_id = $1 order by role, user_id",
    [communityId],
  );
  organizerId = people.rows.find((p) => p.role === 'organizer')!.user_id;
  memberId = people.rows.find((p) => p.role === 'member')!.user_id;
}, 120_000);

afterAll(closeDb);

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  console.log(`[stats perf] ${label}: ${ms.toFixed(0)} ms`);
  expect(ms, label).toBeLessThan(BOUND_MS);
  return result;
}

describe(`statistics on ${MEMBERS} members x ${SESSIONS} sessions`, () => {
  it('every function answers within the bound, and the numbers stay consistent', async () => {
    const { rows } = await admin.query<{ pairs: number; records: number; rsvps: number }>(
      `select (select count(*)::int from public.attendance_records where community_id = $1) as records,
              (select count(*)::int from public.training_rsvps where community_id = $1) as rsvps,
              (select count(*)::int from private.stats_rows($1, null, now())) as pairs`,
      [communityId],
    );
    console.log(`[stats perf] dataset: ${rows[0].pairs} member-session pairs, ${rows[0].rsvps} RSVPs, ${rows[0].records} records`);
    expect(rows[0].pairs).toBeGreaterThan(40_000);

    for (const window of ['30d', 'all'] as StatsWindow[]) {
      const community = await timed(`get_community_statistics ${window}`, () => communityStats(organizerId, communityId, window));
      const list = await timed(`list_member_statistics_summary ${window}`, () => summary(organizerId, communityId, window));
      await timed(`get_member_statistics ${window}`, () => memberStats(organizerId, communityId, memberId, window));
      await timed(`get_my_statistics ${window}`, () => myStats(memberId, communityId, window));
      await timed(`get_my_attendance_history ${window}`, () => history(memberId, communityId, window, 100));

      // No removed members and no walk-ins before joining here: the sums are exact.
      expect(list.members).toHaveLength(MEMBERS);
      expect(list.truncated).toBe(false);
      expect(list.members.reduce((n, m) => n + m.attended, 0)).toBe(community.total_attendances);
      expect(list.members.reduce((n, m) => n + m.rsvp_going_recorded, 0)).toBe(community.rsvp_going_recorded);
      // Run 60 started exactly 720 h before the INSERT, so just before the later call's window.
      expect(community.completed_trainings).toBe(window === 'all' ? SESSIONS : 59);
    }
  });

  it('the summary returns at most 500 members and says when it truncated', async () => {
    await admin.query(
      `with u as (insert into auth.users (is_anonymous) select true from generate_series(1, 201) returning id),
       p as (insert into public.profiles (id, display_name) select id, 'Zed ' || id from u returning id)
       insert into public.memberships (community_id, user_id) select $1, id from p`,
      [communityId],
    );
    const list = await timed('list_member_statistics_summary all (501 members)', () => summary(organizerId, communityId, 'all'));
    expect(list).toMatchObject({ total_members: 501, truncated: true });
    expect(list.members).toHaveLength(500);
    // Ordered by display name: the cut drops the last name.
    expect(list.members.at(-1)!.display_name.startsWith('Zed ')).toBe(true);
    expect(list.members[0].display_name).toBe('Runner 001');
  });
});
