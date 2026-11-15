import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { admin, asAnon, asRole, asService, asUser, closeDb, createUser, INSUFFICIENT_PRIVILEGE, resetData, rpc } from './helpers';
import { communityStats, history, memberStats, myStats, SeasonBuilder, summary } from './stats-helpers';

/**
 * M4-B1: authorization matrix and input validation of every statistics RPC.
 * Members read only their own numbers; organizers read their own community; nobody reads across
 * communities; removed members and removed organizers read nothing; anon and service_role have
 * no execute privilege.
 */

beforeEach(resetData);
afterAll(closeDb);

const raised = (message: string) => ({ code: 'P0001', message });
const denied = { code: INSUFFICIENT_PRIVILEGE };

async function world() {
  const a = await SeasonBuilder.create('Europe/Bucharest', 'Pack A');
  const b = await SeasonBuilder.create('Europe/Bucharest', 'Pack B');
  const orgA = await a.person({ role: 'organizer', name: 'Org A' });
  const memA = await a.person({ name: 'Member A' });
  const memA2 = await a.person({ name: 'Member A2' });
  const removedMemA = await a.person({ name: 'Removed A', status: 'removed' });
  const removedOrgA = await a.person({ role: 'organizer', name: 'Removed Org A', status: 'removed' });
  const orgB = await b.person({ role: 'organizer', name: 'Org B' });
  const memB = await b.person({ name: 'Member B' });
  const outsider = await createUser();
  await admin.query("insert into public.profiles (id, display_name) values ($1, 'Outsider')", [outsider]);

  const sA = await a.session({ hoursAgo: 30 });
  await a.going(sA, memA, 'present');
  await a.going(sA, memA2, 'absent');
  await a.going(sA, removedMemA, 'present');
  const sB = await b.session({ hoursAgo: 30 });
  await b.going(sB, memB, 'present');
  await b.going(sB, orgB, 'present');
  return { a: a.communityId, b: b.communityId, orgA, memA, memA2, removedMemA, removedOrgA, orgB, memB, outsider, sA, sB };
}

describe('get_my_statistics / get_my_attendance_history', () => {
  it('active members (organizers included) only', async () => {
    const w = await world();
    expect((await myStats(w.memA, w.a)).attended).toBe(1);
    expect((await myStats(w.orgA, w.a)).eligible).toBe(1);
    expect((await history(w.memA, w.a)).items).toHaveLength(1);
    for (const caller of [w.outsider, w.orgB, w.memB, w.removedMemA, w.removedOrgA]) {
      await expect(myStats(caller, w.a)).rejects.toMatchObject(raised('not_a_member'));
      await expect(history(caller, w.a)).rejects.toMatchObject(raised('not_a_member'));
    }
    for (const community of [randomUUID(), null]) {
      await expect(myStats(w.memA, community as string)).rejects.toMatchObject(raised('not_a_member'));
      await expect(history(w.memA, community as string)).rejects.toMatchObject(raised('not_a_member'));
    }
  });
});

describe('organizer functions', () => {
  it('get_member_statistics: organizers of that community only, any member of it (removed included)', async () => {
    const w = await world();
    expect(await memberStats(w.orgA, w.a, w.memA)).toMatchObject({ user_id: w.memA, attended: 1 });
    expect(await memberStats(w.orgA, w.a, w.removedMemA)).toMatchObject({ membership_status: 'removed', attended: 1 });
    expect(await memberStats(w.orgA, w.a, w.removedOrgA)).toMatchObject({ membership_status: 'removed', role: 'organizer' });
    expect(await memberStats(w.orgA, w.a, w.orgA)).toMatchObject({ role: 'organizer' });

    // Members (also about themselves), outsiders, other organizers, removed organizers.
    for (const caller of [w.memA, w.memA2, w.outsider, w.orgB, w.memB, w.removedOrgA, w.removedMemA]) {
      await expect(memberStats(caller, w.a, w.memA)).rejects.toMatchObject(raised('forbidden'));
    }
    await expect(memberStats(w.memA, w.a, w.memA2)).rejects.toMatchObject(raised('forbidden'));
    // No cross-community reads: the target must have a membership in the community asked about.
    await expect(memberStats(w.orgB, w.b, w.memA)).rejects.toMatchObject(raised('not_found'));
    await expect(memberStats(w.orgA, w.a, w.memB)).rejects.toMatchObject(raised('not_found'));
    await expect(memberStats(w.orgA, w.a, w.outsider)).rejects.toMatchObject(raised('not_found'));
    await expect(memberStats(w.orgA, w.a, randomUUID())).rejects.toMatchObject(raised('not_found'));
    await expect(memberStats(w.orgA, w.a, null)).rejects.toMatchObject(raised('not_found'));
    await expect(memberStats(w.orgA, randomUUID(), w.memA)).rejects.toMatchObject(raised('forbidden'));
  });

  it('get_community_statistics and list_member_statistics_summary: active organizers of that community only', async () => {
    const w = await world();
    expect(await communityStats(w.orgA, w.a, '7d')).toMatchObject({ completed_trainings: 1, total_attendances: 2 });
    expect((await summary(w.orgA, w.a, '7d')).members.map((m) => m.display_name)).toEqual(['Member A', 'Member A2', 'Org A']);
    for (const caller of [w.memA, w.outsider, w.orgB, w.memB, w.removedOrgA, w.removedMemA]) {
      await expect(communityStats(caller, w.a)).rejects.toMatchObject(raised('forbidden'));
      await expect(summary(caller, w.a)).rejects.toMatchObject(raised('forbidden'));
    }
    for (const community of [randomUUID(), null]) {
      await expect(communityStats(w.orgA, community as string)).rejects.toMatchObject(raised('forbidden'));
      await expect(summary(w.orgA, community as string)).rejects.toMatchObject(raised('forbidden'));
    }
    // B's overview holds none of A's data.
    expect(await communityStats(w.orgB, w.b, '7d')).toMatchObject({ completed_trainings: 1, total_attendances: 2, active_members: 2 });
  });

  it('a person in two communities sees each community separately', async () => {
    const w = await world();
    await admin.query("insert into public.memberships (community_id, user_id, joined_at) values ($1, $2, now() - interval '400 days')", [w.b, w.memA]);
    await admin.query(
      "insert into public.training_rsvps (session_id, community_id, user_id, response) values ($1, $2, $3, 'going')",
      [w.sB, w.b, w.memA],
    );
    await admin.query("update public.training_sessions set going_count = going_count + 1 where id = $1", [w.sB]);
    await admin.query(
      "insert into public.attendance_records (session_id, community_id, user_id, status, had_rsvp_going) values ($1, $2, $3, 'absent', true)",
      [w.sB, w.b, w.memA],
    );
    expect(await myStats(w.memA, w.a, '7d')).toMatchObject({ eligible: 1, attended: 1, absent: 0 });
    expect(await myStats(w.memA, w.b, '7d')).toMatchObject({ eligible: 1, attended: 0, absent: 1 });
    expect((await history(w.memA, w.a, '7d')).items.map((i) => i.session_id)).toEqual([w.sA]);
    expect(await memberStats(w.orgB, w.b, w.memA, '7d')).toMatchObject({ absent: 1, attended: 0 });
  });
});

describe('anon, service_role and callers without a user id', () => {
  it('anon and service_role have no execute privilege on any statistics function', async () => {
    const w = await world();
    const calls: [string, unknown[]][] = [
      ['select public.get_my_statistics($1, $2)', [w.a, '30d']],
      ['select public.get_my_attendance_history($1, $2)', [w.a, '30d']],
      ['select public.get_my_attendance_history($1, $2, $3, $4)', [w.a, '30d', 10, null]],
      ['select public.get_member_statistics($1, $2, $3)', [w.a, w.memA, '30d']],
      ['select public.get_community_statistics($1, $2)', [w.a, '30d']],
      ['select public.list_member_statistics_summary($1, $2)', [w.a, '30d']],
    ];
    for (const [sql, params] of calls) {
      await expect(asAnon((db) => db.query(sql, params)), sql).rejects.toMatchObject(denied);
      await expect(asService((db) => db.query(sql, params)), sql).rejects.toMatchObject(denied);
    }
  });

  it('an authenticated request without a user id is not_authenticated', async () => {
    const w = await world();
    const noSub = (name: string, args: unknown[]) =>
      asRole('authenticated', { role: 'authenticated' }, (db) => rpc(db, name, args));
    const calls: [string, unknown[]][] = [
      ['get_my_statistics', [w.a, '30d']],
      ['get_my_attendance_history', [w.a, '30d']],
      ['get_member_statistics', [w.a, w.memA, '30d']],
      ['get_community_statistics', [w.a, '30d']],
      ['list_member_statistics_summary', [w.a, '30d']],
    ];
    for (const [name, args] of calls) {
      await expect(noSub(name, args), name).rejects.toMatchObject(raised('not_authenticated'));
    }
  });
});

describe('input validation', () => {
  it('p_window must be 7d, 30d, 90d or all', async () => {
    const w = await world();
    for (const window of ['week', '', '7D', '1d', ' 7d', null]) {
      await expect(myStats(w.memA, w.a, window)).rejects.toMatchObject(raised('validation_failed:window'));
      await expect(history(w.memA, w.a, window)).rejects.toMatchObject(raised('validation_failed:window'));
      await expect(memberStats(w.orgA, w.a, w.memA, window)).rejects.toMatchObject(raised('validation_failed:window'));
      await expect(communityStats(w.orgA, w.a, window)).rejects.toMatchObject(raised('validation_failed:window'));
      await expect(summary(w.orgA, w.a, window)).rejects.toMatchObject(raised('validation_failed:window'));
    }
    // Authorization is checked first: an outsider learns nothing from a bad window.
    await expect(myStats(w.outsider, w.a, 'week')).rejects.toMatchObject(raised('not_a_member'));
    await expect(communityStats(w.memA, w.a, 'week')).rejects.toMatchObject(raised('forbidden'));
  });

  it('p_limit must be between 1 and 100', async () => {
    const w = await world();
    for (const limit of [0, -1, 101, null]) {
      await expect(history(w.memA, w.a, 'all', limit)).rejects.toMatchObject(raised('validation_failed:limit'));
    }
    expect((await history(w.memA, w.a, 'all', 100)).items).toHaveLength(1);
    expect((await history(w.memA, w.a, 'all', 1)).items).toHaveLength(1);
  });
});

describe('no writes', () => {
  it('statistics functions are stable and change nothing', async () => {
    const w = await world();
    const { rows } = await admin.query<{ proname: string; provolatile: string }>(
      `select proname, provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and (proname like 'stats\\_%' or proname in
         ('get_my_statistics', 'get_my_attendance_history', 'get_member_statistics', 'get_community_statistics',
          'list_member_statistics_summary'))
       order by 1`,
    );
    expect(rows.length).toBe(15);
    expect(rows.filter((r) => r.provolatile === 'v').map((r) => r.proname)).toEqual([]);
    // A stable function cannot write: calling one inside a read-only transaction succeeds.
    await asUser(w.orgA, async (db) => {
      await db.query('begin read only');
      await db.query('select public.get_community_statistics($1, $2)', [w.a, 'all']);
      await db.query('select public.list_member_statistics_summary($1, $2)', [w.a, 'all']);
      await db.query('select public.get_member_statistics($1, $2, $3)', [w.a, w.memA, 'all']);
      await db.query('select public.get_my_statistics($1, $2)', [w.a, 'all']);
      await db.query('select public.get_my_attendance_history($1, $2)', [w.a, 'all']);
      await db.query('commit');
    });
  });
});
