import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { admin, asAnon, asRole, asService, asUser, closeDb, createUser, INSUFFICIENT_PRIVILEGE, resetData, rpc } from './helpers';
import { history, SeasonBuilder, type History } from './stats-helpers';

/**
 * M4-B2: get_member_attendance_history (organizer reads one member's history, QA defect Q5-4).
 */

beforeEach(resetData);
afterAll(closeDb);

const raised = (message: string) => ({ code: 'P0001', message });
const denied = { code: INSUFFICIENT_PRIVILEGE };

const memberHistory = (
  caller: string,
  communityId: string,
  target: string | null,
  window: string | null = 'all',
  limit?: number | null,
  before?: string | null,
) =>
  asUser(caller, (db) =>
    limit === undefined
      ? rpc<History>(db, 'get_member_attendance_history', [communityId, target, window])
      : rpc<History>(db, 'get_member_attendance_history', [communityId, target, window, limit, before ?? null]),
  );

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

  const s1 = await a.session({ hoursAgo: 30, title: 'One' });
  const s2 = await a.session({ hoursAgo: 60, title: 'Two' });
  const s3 = await a.session({ hoursAgo: 90, title: 'Three' });
  await a.going(s1, memA, 'present');
  await a.going(s2, memA, 'absent');
  await a.rsvp(s3, memA, 'going');
  await a.going(s1, removedMemA, 'present');
  const sB = await b.session({ hoursAgo: 30 });
  await b.going(sB, memB, 'present');
  return { ca: a.communityId, b: b.communityId, orgA, memA, memA2, removedMemA, removedOrgA, orgB, memB, outsider };
}

describe('authorization', () => {
  it('organizers of that community read any of its members, removed included', async () => {
    const w = await world();
    const page = await memberHistory(w.orgA, w.ca, w.memA);
    expect(page.items.map((i) => [i.title, i.outcome])).toEqual([
      ['One', 'present'],
      ['Two', 'absent'],
      ['Three', 'unrecorded'],
    ]);
    const removed = await memberHistory(w.orgA, w.ca, w.removedMemA);
    expect(removed.items.map((i) => [i.title, i.outcome])).toEqual([
      ['One', 'present'],
      ['Two', 'unrecorded'],
      ['Three', 'unrecorded'],
    ]);
    expect((await memberHistory(w.orgA, w.ca, w.removedOrgA)).items.length).toBe(3);
    expect((await memberHistory(w.orgA, w.ca, w.orgA)).items.length).toBe(3);
  });

  it('members (also about themselves), outsiders, other organizers and removed organizers: forbidden', async () => {
    const w = await world();
    for (const caller of [w.memA, w.memA2, w.outsider, w.orgB, w.memB, w.removedOrgA, w.removedMemA]) {
      await expect(memberHistory(caller, w.ca, w.memA), caller).rejects.toMatchObject(raised('forbidden'));
    }
    await expect(memberHistory(w.orgA, randomUUID(), w.memA)).rejects.toMatchObject(raised('forbidden'));
    await expect(memberHistory(w.orgA, null as unknown as string, w.memA)).rejects.toMatchObject(raised('forbidden'));
    // Authorization comes before input validation: nothing is learned from a bad window or limit.
    await expect(memberHistory(w.memA, w.ca, w.memA, 'week')).rejects.toMatchObject(raised('forbidden'));
    await expect(memberHistory(w.outsider, w.ca, w.memA, 'all', 0)).rejects.toMatchObject(raised('forbidden'));
    await expect(memberHistory(w.outsider, w.ca, randomUUID(), 'week')).rejects.toMatchObject(raised('forbidden'));
  });

  it('a target without a membership in this community is not_found, also when it exists elsewhere', async () => {
    const w = await world();
    await expect(memberHistory(w.orgA, w.ca, w.memB)).rejects.toMatchObject(raised('not_found'));
    await expect(memberHistory(w.orgB, w.b, w.memA)).rejects.toMatchObject(raised('not_found'));
    await expect(memberHistory(w.orgA, w.ca, w.outsider)).rejects.toMatchObject(raised('not_found'));
    await expect(memberHistory(w.orgA, w.ca, randomUUID())).rejects.toMatchObject(raised('not_found'));
    await expect(memberHistory(w.orgA, w.ca, null)).rejects.toMatchObject(raised('not_found'));
    // not_found comes before input validation as well.
    await expect(memberHistory(w.orgA, w.ca, w.memB, 'week')).rejects.toMatchObject(raised('not_found'));
  });

  it('anon and service_role have no execute privilege; no user id is not_authenticated', async () => {
    const w = await world();
    const sql = 'select public.get_member_attendance_history($1, $2, $3)';
    const params = [w.ca, w.memA, 'all'];
    await expect(asAnon((db) => db.query(sql, params))).rejects.toMatchObject(denied);
    await expect(asService((db) => db.query(sql, params))).rejects.toMatchObject(denied);
    await expect(
      asRole('authenticated', { role: 'authenticated' }, (db) => rpc(db, 'get_member_attendance_history', params)),
    ).rejects.toMatchObject(raised('not_authenticated'));
  });
});

describe('payload', () => {
  it('equals what get_my_attendance_history returns for the same user and window', async () => {
    const w = await world();
    for (const window of ['7d', '30d', '90d', 'all']) {
      for (const target of [w.memA, w.memA2, w.orgA]) {
        const own = await history(target, w.ca, window, 50);
        const theirs = await memberHistory(w.orgA, w.ca, target, window, 50);
        expect(Object.keys(theirs).sort()).toEqual(Object.keys(own).sort());
        expect(theirs.items).toEqual(own.items);
        expect(theirs.has_more).toBe(own.has_more);
        expect(theirs.next_before).toBe(own.next_before);
        expect(theirs.window).toBe(own.window);
      }
    }
    // A removed member has no own endpoint any more; the organizer still sees the past.
    expect((await memberHistory(w.orgA, w.ca, w.removedMemA, '30d')).items).toHaveLength(3);
  });

  it('paginates like the own history: same-instant sessions are never split, nothing skipped or repeated', async () => {
    const season = await SeasonBuilder.create('UTC');
    const org = await season.person({ role: 'organizer' });
    const m = await season.person({ name: 'Runner' });
    const now = Date.now();
    // Hours ago: 10, 20, 20, 20, 30, 40, 50; the three at 20 h are the same instant.
    for (const [i, h] of [10, 20, 20, 20, 30, 40, 50].entries()) {
      const s = await season.session({ at: new Date(now - h * 3_600_000).toISOString(), title: `S${i}` });
      await season.going(s, m, 'present');
    }
    const ids: string[] = [];
    let before: string | null = null;
    let pages = 0;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: History = await memberHistory(org, season.communityId, m, 'all', 2, before);
      const own: History = await history(m, season.communityId, 'all', 2, before);
      expect(page.items).toEqual(own.items);
      expect(page.next_before).toBe(own.next_before);
      expect(page.next_before === null).toBe(!page.has_more);
      ids.push(...page.items.map((i) => i.session_id));
      pages += 1;
      if (!page.has_more) break;
      before = page.next_before;
    }
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
    expect(pages).toBeGreaterThan(1);
  });
});

describe('input validation and read-only', () => {
  it('p_window and p_limit are validated after authorization', async () => {
    const w = await world();
    for (const window of ['week', '', '7D', ' 7d', null]) {
      await expect(memberHistory(w.orgA, w.ca, w.memA, window)).rejects.toMatchObject(raised('validation_failed:window'));
    }
    for (const limit of [0, -1, 101, null]) {
      await expect(memberHistory(w.orgA, w.ca, w.memA, 'all', limit)).rejects.toMatchObject(raised('validation_failed:limit'));
    }
    expect((await memberHistory(w.orgA, w.ca, w.memA, 'all', 100)).items).toHaveLength(3);
    expect((await memberHistory(w.orgA, w.ca, w.memA, 'all', 1)).items).toHaveLength(1);
  });

  it('is stable, security definer with an empty search path, and writes nothing', async () => {
    const w = await world();
    const { rows } = await admin.query<{ provolatile: string; prosecdef: boolean; config: string[] | null }>(
      "select provolatile, prosecdef, proconfig as config from pg_proc where proname = 'get_member_attendance_history'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].provolatile).toBe('s');
    expect(rows[0].prosecdef).toBe(true);
    expect(rows[0].config).toContain('search_path=""');
    await asUser(w.orgA, async (db) => {
      await db.query('begin read only');
      await db.query('select public.get_member_attendance_history($1, $2, $3)', [w.ca, w.memA, 'all']);
      await db.query('commit');
    });
  });
});
