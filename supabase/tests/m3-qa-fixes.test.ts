import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  dispatchNotifications,
  type ClaimedJob,
  type CompleteStatus,
  type DispatchRpc,
  type ExpoMessage,
  type FetchLike,
} from '../functions/dispatch-notifications/dispatch';
import {
  addMember,
  admin,
  asAnon,
  asService,
  asUser,
  closeDb,
  countRows,
  createPack,
  createTraining,
  resetData,
  rpc,
  rpcRow,
} from './helpers';
import { claimJobs, createAnnouncement, expoToken, jobs, notifications } from './notifications-helpers';

/**
 * M3-B3: rules added for the Milestone 3 QA defects Q4-1, Q4-2, Q4-4, Q4-5, Q4-6 and the
 * observations O-1 (rate limit), O-2 (retention), O-3 (badge). The original QA reproductions
 * live in qa-comms*.test.ts; these tests pin the exact behaviour chosen.
 */

beforeEach(resetData);
afterAll(closeDb);

const raised = (message: string) => ({ code: 'P0001', message });

const markAll = (userId: string, communityId: string) =>
  asUser(userId, (db) => rpc<number>(db, 'mark_all_notifications_read', [communityId]));
const unreadAnnouncements = (userId: string, communityId: string) =>
  asUser(userId, (db) => rpc<number>(db, 'unread_announcement_count', [communityId]));
const readRows = async (userId: string) =>
  (
    await admin.query<{ announcement_id: string }>(
      'select announcement_id from public.announcement_reads where user_id = $1 order by 1',
      [userId],
    )
  ).rows.map((r) => r.announcement_id);

// ---- Q4-4 ----------------------------------------------------------------------------------

describe('Q4-4: mark_all_notifications_read marks the referenced announcements read', () => {
  it('marks exactly the announcements of the notifications it marks; other users and communities untouched', async () => {
    const a = await createPack(2);
    const b = await createPack(1);
    const [me, other] = a.memberIds;
    const ann1 = await createAnnouncement(a.organizerId, a.communityId, { title: 'one' });
    const ann2 = await createAnnouncement(a.organizerId, a.communityId, { title: 'two' });
    await createTraining(a.organizerId, a.communityId);
    // A member of both communities: the other community's rows must stay unread.
    await admin.query("insert into public.memberships (community_id, user_id, role, status) values ($1, $2, 'member', 'active')", [b.communityId, me]);
    const annB = await createAnnouncement(b.organizerId, b.communityId, { title: 'b' });

    expect(await unreadAnnouncements(me, a.communityId)).toBe(2);
    expect(await markAll(me, a.communityId)).toBe(3); // two announcements + one training
    expect(await unreadAnnouncements(me, a.communityId)).toBe(0);
    expect(await readRows(me)).toEqual([ann1.id, ann2.id].sort());

    // Other user of the same community: untouched.
    expect(await unreadAnnouncements(other, a.communityId)).toBe(2);
    expect(await readRows(other)).toEqual([]);
    expect(await countRows('notifications', 'user_id = $1 and read_at is null', [other])).toBe(3);
    // Other community of the same user: untouched.
    expect(await unreadAnnouncements(me, b.communityId)).toBe(1);
    expect(await countRows('notifications', 'user_id = $1 and community_id = $2 and read_at is null', [me, b.communityId])).toBe(1);
    expect((await readRows(me)).includes(annB.id)).toBe(false);

    // Idempotent: nothing more to mark, read_at of the reads stays the first one.
    const before = await admin.query('select read_at from public.announcement_reads where user_id = $1 order by announcement_id', [me]);
    expect(await markAll(me, a.communityId)).toBe(0);
    const after = await admin.query('select read_at from public.announcement_reads where user_id = $1 order by announcement_id', [me]);
    expect(after.rows).toEqual(before.rows);
  });

  it('announcements without a notification marked by this call stay unread (member joined later)', async () => {
    const a = await createPack(0);
    await createAnnouncement(a.organizerId, a.communityId, { title: 'before join' });
    const late = await addMember(a.communityId, { name: 'Late' });
    expect(await unreadAnnouncements(late, a.communityId)).toBe(1);
    expect(await markAll(late, a.communityId)).toBe(0);
    expect(await unreadAnnouncements(late, a.communityId)).toBe(1);
  });

  it('mark_notification_read of an announcement notification marks the announcement too; others untouched', async () => {
    const a = await createPack(2);
    const [me, other] = a.memberIds;
    const ann = await createAnnouncement(a.organizerId, a.communityId);
    const [note] = await notifications('user_id = $1', [me]);
    await asUser(me, (db) => rpcRow(db, 'mark_notification_read', [note.id]));
    expect(await unreadAnnouncements(me, a.communityId)).toBe(0);
    expect(await readRows(me)).toEqual([ann.id]);
    expect(await readRows(other)).toEqual([]);
    // Repeat: idempotent.
    await asUser(me, (db) => rpcRow(db, 'mark_notification_read', [note.id]));
    expect(await countRows('announcement_reads', 'user_id = $1', [me])).toBe(1);
  });

  it('mark-all and single reads racing an account deletion never deadlock', async () => {
    for (let round = 0; round < 8; round += 1) {
      await resetData();
      const a = await createPack(1);
      const [me] = a.memberIds;
      for (let i = 0; i < 3; i += 1) await createAnnouncement(a.organizerId, a.communityId, { title: `r${i}` });
      const [note] = await notifications('user_id = $1', [me]);
      const results = await Promise.allSettled([
        markAll(me, a.communityId),
        asUser(me, (db) => rpcRow(db, 'mark_notification_read', [note.id])),
        admin.query('delete from auth.users where id = $1', [me]),
      ]);
      for (const r of results) {
        if (r.status === 'rejected') {
          expect(String((r.reason as { message?: string }).message), `round ${round}`).toMatch(/^(not_a_member|not_found)$/);
        }
      }
      expect(results[2].status).toBe('fulfilled');
      expect(await countRows('notifications', 'user_id = $1', [me])).toBe(0);
    }
  });

  it('mark_announcement_read still marks its notification', async () => {
    const a = await createPack(1);
    const [me] = a.memberIds;
    const ann = await createAnnouncement(a.organizerId, a.communityId);
    await asUser(me, (db) => rpcRow(db, 'mark_announcement_read', [ann.id]));
    expect(await countRows('notifications', 'user_id = $1 and read_at is null', [me])).toBe(0);
  });

  it('unauthorized paths: anon, outsiders and removed members', async () => {
    const a = await createPack(1);
    const b = await createPack(1);
    await createAnnouncement(a.organizerId, a.communityId);
    await expect(asAnon((db) => rpc(db, 'mark_all_notifications_read', [a.communityId]))).rejects.toMatchObject({ code: '42501' });
    await expect(markAll(b.memberIds[0], a.communityId)).rejects.toMatchObject(raised('not_a_member'));
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [a.memberIds[0]]);
    await expect(markAll(a.memberIds[0], a.communityId)).rejects.toMatchObject(raised('not_a_member'));
    expect(await countRows('announcement_reads')).toBe(0);
    expect(await countRows('notifications', 'read_at is not null')).toBe(0);
  });
});

// ---- Q4-5 ----------------------------------------------------------------------------------

describe('Q4-5: clean_required_text', () => {
  const create = (a: { organizerId: string; communityId: string }, title: string, body = 'ok') =>
    createAnnouncement(a.organizerId, a.communityId, { title, body });

  it('rejects titles and bodies that are blank once invisible characters are ignored', async () => {
    const a = await createPack(1);
    const blanks = [
      '​', '‌‍', '⁠', '﻿', ' ', '  ', '　', '⠀',
      '­', '‎‏', 'ㅤ', '️', '\u{E0020}', ' ', '‮', '\u0007\u0001',
      ' ​  \t\n ',
    ];
    for (const t of blanks) {
      await expect(create(a, t), JSON.stringify(t)).rejects.toMatchObject(raised('validation_failed:title'));
      await expect(create(a, 'x', t), JSON.stringify(t)).rejects.toMatchObject(raised('validation_failed:body'));
    }
    expect(await countRows('announcements')).toBe(0);
  });

  it('strips controls and bidi controls, normalizes spaces in titles, keeps newlines and tabs in bodies', async () => {
    const a = await createPack(1);
    const row = await create(
      a,
      '‮Pay now⁦ \u0007fdp.exe\u0085⁩',
      'line1\r\nline2\u0007\u000B\rline3 \tx‭',
    );
    expect(row.title).toBe('Pay now fdp.exe');
    expect(row.body).toBe('line1\nline2\nline3\n\tx');
    const [note] = await notifications('related_announcement_id = $1', [row.id]);
    expect(note.title).toBe('Pay now fdp.exe');
  });

  it('keeps emoji sequences (zero-width joiner, variation selector) and visible text next to invisible characters', async () => {
    const a = await createPack(1);
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const row = await create(a, `${family} run ❤️`);
    expect(row.title).toBe(`${family} run ❤️`);
  });

  it('applies to update_announcement too', async () => {
    const a = await createPack(1);
    const row = await createAnnouncement(a.organizerId, a.communityId, {
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await expect(
      asUser(a.organizerId, (db) => rpcRow(db, 'update_announcement', [row.id, '​ ', 'b', null])),
    ).rejects.toMatchObject(raised('validation_failed:title'));
  });
});

// ---- Q4-6 ----------------------------------------------------------------------------------

describe('Q4-6: deep_link allowlist', () => {
  const insert = (a: { memberIds: string[]; communityId: string }, sessionId: string, link: string, key: string) =>
    admin.query(
      `insert into public.notifications (user_id, community_id, kind, title, body, deep_link, related_session_id, dedupe_key)
       values ($1, $2, 'training_created', 't', 'b', $3, $4, $5)`,
      [a.memberIds[0], a.communityId, link, sessionId, key],
    );

  it('accepts exactly /activity, /trainings/<uuid>, /announcements/<uuid> (lowercase)', async () => {
    const a = await createPack(1);
    const s = await createTraining(a.organizerId, a.communityId);
    const uuid = s.id;
    for (const [i, link] of ['/activity', `/trainings/${uuid}`, `/announcements/${uuid}`].entries()) {
      await insert(a, s.id, link, `ok:${i}`);
    }
    const bad = [
      '/activity/', '/activity?x=1', `/trainings/${uuid.toUpperCase()}`, `/trainings/${uuid}/edit`, `/trainings/${uuid}?a=b`,
      `//trainings/${uuid}`, `/trainings/${uuid.slice(0, -1)}`, `/trainings/${uuid}0`, '/trainings/', '/', '',
      `/Trainings/${uuid}`, `/trainings/${uuid}\n`, `/announcements/${'-'.repeat(36)}`, `https://evil.example/trainings/${uuid}`,
    ];
    for (const [i, link] of bad.entries()) {
      await expect(insert(a, s.id, link, `bad:${i}`), JSON.stringify(link)).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('the constraint is validated (no NOT VALID left behind on a clean database)', async () => {
    const { rows } = await admin.query<{ convalidated: boolean }>(
      "select convalidated from pg_constraint where conname = 'notifications_deep_link_check'",
    );
    expect(rows).toEqual([{ convalidated: true }]);
  });
});

// ---- O-1 rate limit ------------------------------------------------------------------------

describe('O-1: announcement rate limit', () => {
  it('10 per organizer and community per hour, any status; another organizer, another community and an hour later are separate', async () => {
    const a = await createPack(1);
    const second = await addMember(a.communityId, { role: 'organizer', name: 'Second' });
    const later = new Date(Date.now() + 3_600_000).toISOString();
    for (let i = 0; i < 5; i += 1) await createAnnouncement(a.organizerId, a.communityId, { title: `n${i}` });
    for (let i = 0; i < 5; i += 1) {
      const s = await createAnnouncement(a.organizerId, a.communityId, { title: `s${i}`, scheduledFor: later });
      await asUser(a.organizerId, (db) => rpcRow(db, 'cancel_announcement', [s.id]));
    }
    await expect(createAnnouncement(a.organizerId, a.communityId)).rejects.toMatchObject(raised('announcement_rate_limited'));
    await expect(createAnnouncement(a.organizerId, a.communityId, { scheduledFor: later })).rejects.toMatchObject(
      raised('announcement_rate_limited'),
    );
    // Another organizer of the same community has their own budget.
    await createAnnouncement(second, a.communityId);
    // An hour later the window has moved.
    await admin.query("update public.announcements set created_at = now() - interval '61 minutes' where author_id = $1 and title = 'n0'", [a.organizerId]);
    await createAnnouncement(a.organizerId, a.communityId, { title: 'after an hour' });
    await expect(createAnnouncement(a.organizerId, a.communityId)).rejects.toMatchObject(raised('announcement_rate_limited'));
  });

  it('concurrent creations never exceed the cap', async () => {
    const a = await createPack(1);
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, (_, i) => createAnnouncement(a.organizerId, a.communityId, { title: `c${i}` })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject(raised('announcement_rate_limited'));
    }
    expect(await countRows('announcements')).toBe(10);
  });

  it('service paths are not limited: scheduled announcements publish regardless', async () => {
    const a = await createPack(1);
    const later = new Date(Date.now() + 3_600_000).toISOString();
    for (let i = 0; i < 10; i += 1) await createAnnouncement(a.organizerId, a.communityId, { title: `s${i}`, scheduledFor: later });
    await admin.query("update public.announcements set scheduled_for = now() - interval '1 second'");
    expect(await asService((db) => rpc<number>(db, 'publish_due_announcements'))).toBe(10);
  });

  it('a member or outsider still gets forbidden, not the rate-limit code', async () => {
    const a = await createPack(1);
    const b = await createPack(0);
    await expect(createAnnouncement(a.memberIds[0], a.communityId)).rejects.toMatchObject(raised('forbidden'));
    await expect(createAnnouncement(b.organizerId, a.communityId)).rejects.toMatchObject(raised('forbidden'));
    await expect(
      asAnon((db) => rpcRow(db, 'create_announcement', [a.communityId, 't', 'b', null])),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

// ---- O-2 retention -------------------------------------------------------------------------

describe('O-2: purge retention of in-app notifications', () => {
  it('read > 90 days and unread > 180 days go (with their jobs); younger ones stay; idempotent', async () => {
    const a = await createPack(6);
    await createTraining(a.organizerId, a.communityId);
    const set = (user: string, age: string, read: boolean) =>
      admin.query(
        `update public.notifications set created_at = now() - $2::interval, read_at = case when $3 then now() end where user_id = $1`,
        [user, age, read],
      );
    const [readOld, readYoung, unreadOld, unreadYoung, readEdge, fresh] = a.memberIds;
    await set(readOld, '91 days', true);
    await set(readYoung, '89 days', true);
    await set(unreadOld, '181 days', false);
    await set(unreadYoung, '179 days', false);
    await set(readEdge, '100 days', false);
    await set(fresh, '0 days', false);
    expect(await asService((db) => rpc<number>(db, 'purge_old_notification_data'))).toBe(2);
    const left = (await admin.query<{ user_id: string }>('select user_id from public.notifications')).rows.map((r) => r.user_id);
    expect(left.sort()).toEqual([readYoung, unreadYoung, readEdge, fresh].sort());
    expect(await countRows('notification_delivery_jobs', 'user_id = any($1)', [[readOld, unreadOld]])).toBe(0);
    expect(await countRows('notification_delivery_jobs')).toBe(4);
    expect(await asService((db) => rpc<number>(db, 'purge_old_notification_data'))).toBe(0);
  });

  it('is not callable by signed-in users', async () => {
    const a = await createPack(1);
    await expect(asUser(a.organizerId, (db) => rpc(db, 'purge_old_notification_data'))).rejects.toMatchObject({ code: '42501' });
  });
});

// ---- O-3 badge -----------------------------------------------------------------------------

describe('O-3: push badge counts only notifications of active memberships', () => {
  it('ignores a left community, counts every community the user is still active in', async () => {
    const a = await createPack(1);
    const b = await createPack(0);
    const [me] = a.memberIds;
    await admin.query("insert into public.memberships (community_id, user_id, role, status) values ($1, $2, 'member', 'active')", [b.communityId, me]);
    await createAnnouncement(a.organizerId, a.communityId, { title: 'a' });
    await createAnnouncement(b.organizerId, b.communityId, { title: 'b' });
    const claimA = (await claimJobs('w1')).find((j) => j.user_id === me)!;
    expect(claimA.unread_count).toBe(2);
    await admin.query("update public.notification_delivery_jobs set status = 'pending', locked_at = null, locked_by = null, attempts = 0");
    await admin.query("update public.memberships set status = 'removed' where user_id = $1 and community_id = $2", [me, b.communityId]);
    const claimB = (await claimJobs('w2')).filter((j) => j.user_id === me);
    for (const j of claimB) expect(j.unread_count).toBe(1);
  });
});

// ---- Dispatcher: Q4-1 bisection and Q4-2 progressive completion / looping -----------------

function realRpc(overrides: Partial<DispatchRpc> = {}): DispatchRpc {
  return {
    claimJobs: (limit, worker) => claimJobs(worker, limit) as Promise<ClaimedJob[]>,
    completeJob: (jobId: string, status: CompleteStatus, error, retryIn) =>
      asService((db) => rpc(db, 'complete_notification_job', [jobId, status, error, retryIn])),
    invalidateTokens: (tokens, error) => asService((db) => rpc(db, 'invalidate_push_tokens', [tokens, error])),
    ...overrides,
  };
}

async function addToken(userId: string, token: string) {
  await admin.query("insert into public.device_push_tokens (user_id, token, platform) values ($1, $2, 'android')", [userId, token]);
}

const okResponse = (count: number) => ({
  status: 200,
  headers: { get: () => null },
  json: async () => ({ data: Array.from({ length: count }, (_, i) => ({ status: 'ok', id: `t-${i}` })) }),
});
const rejectResponse = (status = 400, code = 'PUSH_TOO_MANY_EXPERIENCE_IDS') => ({
  status,
  headers: { get: () => null },
  json: async () => ({ errors: [{ code, message: 'contains ExponentPushToken[secret]' }], details: { x: ['y'] } }),
});

/** Fake Expo: rejects (400) any request that contains a token whose name includes `foreign`. */
function foreignAwareExpo() {
  const calls: number[] = [];
  const fetchFn: FetchLike = async (_url, init) => {
    const messages = JSON.parse(init.body) as ExpoMessage[];
    calls.push(messages.length);
    if (messages.some((m) => m.to.includes('foreign'))) return rejectResponse();
    return okResponse(messages.length);
  };
  return { fetch: fetchFn, calls };
}

describe('Q4-1: whole-request rejections are bisected', () => {
  it('only the foreign token fails; it is invalidated with the reason code; the other 99 are sent', async () => {
    const p = await createPack(100);
    await createTraining(p.organizerId, p.communityId);
    for (const [i, id] of p.memberIds.entries()) await addToken(id, expoToken(i === 37 ? 'foreign-x' : `good-${i}`));
    const expo = foreignAwareExpo();
    const logs: string[] = [];
    const summary = await dispatchNotifications({
      rpc: realRpc(), fetch: expo.fetch, worker: 'b', log: (e, f) => logs.push(JSON.stringify({ e, f })),
    });
    expect(summary).toMatchObject({ sent: 99, dead: 1, tokensInvalidated: 1 });
    // One rejected request per level (at most 7 levels for 100 messages) plus its accepted sibling half;
    // the exact number depends on where the claim order puts the foreign token.
    expect(summary.expoRequests).toBe(1 + 2 * summary.bisections);
    expect(summary.bisections).toBeGreaterThanOrEqual(6);
    expect(summary.bisections).toBeLessThanOrEqual(7);
    const bad = (await jobs('user_id = $1', [p.memberIds[37]]))[0];
    expect(bad).toMatchObject({ status: 'dead', last_error: 'permanent:HTTP_400' });
    const { rows } = await admin.query('select last_error, invalidated_at is not null as invalid from public.device_push_tokens where token = $1', [expoToken('foreign-x')]);
    expect(rows).toEqual([{ last_error: 'PUSH_TOO_MANY_EXPERIENCE_IDS', invalid: true }]);
    expect(logs.join('\n')).not.toMatch(/ExponentPushToken|foreign/);
    // Next notification: the invalidated token is no longer sent, no bisection needed.
    await createTraining(p.organizerId, p.communityId, { title: 'Second' });
    const next = foreignAwareExpo();
    const again = await dispatchNotifications({ rpc: realRpc(), fetch: next.fetch, worker: 'b2', log: () => undefined });
    expect(again).toMatchObject({ expoRequests: 1, bisections: 0, sent: 99, skipped: 1 });
  });

  it('a user with a foreign and a good token is still sent', async () => {
    const p = await createPack(2);
    await createTraining(p.organizerId, p.communityId);
    await addToken(p.memberIds[0], expoToken('foreign-own'));
    await addToken(p.memberIds[0], expoToken('own-good'));
    await addToken(p.memberIds[1], expoToken('other-good'));
    const summary = await dispatchNotifications({ rpc: realRpc(), fetch: foreignAwareExpo().fetch, worker: 'b', log: () => undefined });
    expect(summary).toMatchObject({ sent: 2, dead: 0, tokensInvalidated: 1 });
  });

  it('a request rejected everywhere (payload problem) invalidates nothing and marks the jobs dead', async () => {
    const p = await createPack(4);
    await createTraining(p.organizerId, p.communityId);
    for (const [i, id] of p.memberIds.entries()) await addToken(id, expoToken(`all-${i}`));
    const fetchFn: FetchLike = async () => rejectResponse(400, 'VALIDATION_ERROR');
    const summary = await dispatchNotifications({ rpc: realRpc(), fetch: fetchFn, worker: 'b', log: () => undefined });
    expect(summary).toMatchObject({ dead: 4, tokensInvalidated: 0, expoRequests: 7 });
    expect(await countRows('device_push_tokens', 'invalidated_at is not null')).toBe(0);
  });

  it('401/403/429 are never bisected', async () => {
    for (const status of [401, 403, 429]) {
      await resetData();
      const p = await createPack(4);
      await createTraining(p.organizerId, p.communityId);
      for (const [i, id] of p.memberIds.entries()) await addToken(id, expoToken(`auth-${status}-${i}`));
      const fetchFn: FetchLike = async () => rejectResponse(status, 'UNAUTHORIZED');
      const summary = await dispatchNotifications({ rpc: realRpc(), fetch: fetchFn, worker: 'b', log: () => undefined });
      expect(summary, String(status)).toMatchObject({ expoRequests: 1, bisections: 0, failed: 4, tokensInvalidated: 0 });
    }
  });

  it('the request cap bounds bisection; what did not fit is handed back for an immediate retry', async () => {
    const p = await createPack(8);
    await createTraining(p.organizerId, p.communityId);
    for (const [i, id] of p.memberIds.entries()) await addToken(id, expoToken(i % 2 === 0 ? `foreign-${i}` : `good-${i}`));
    const summary = await dispatchNotifications({
      rpc: realRpc(), fetch: foreignAwareExpo().fetch, worker: 'b', maxExpoRequests: 3, log: () => undefined,
    });
    expect(summary.expoRequests).toBe(3);
    expect(summary.deferred).toBeGreaterThan(0);
    const rows = await jobs();
    const deferred = rows.filter((j) => j.last_error === 'transient:Deferred');
    expect(deferred.length).toBe(summary.deferred);
    for (const j of deferred) {
      expect(j.status).toBe('failed');
      expect(j.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    }
    expect(rows.every((j) => j.status !== 'sending')).toBe(true);
  });
});

describe('Q4-2: progressive completion and claiming until empty or out of time', () => {
  it('one run drains a queue larger than one batch, in batches', async () => {
    const p = await createPack(250);
    await createTraining(p.organizerId, p.communityId);
    for (const [i, id] of p.memberIds.entries()) await addToken(id, expoToken(`big-${i}`));
    const claims: number[] = [];
    const base = realRpc();
    const summary = await dispatchNotifications({
      rpc: { ...base, claimJobs: async (limit, worker) => { const r = await base.claimJobs(limit, worker); claims.push(r.length); return r; } },
      fetch: async (_u, init) => okResponse((JSON.parse(init.body) as unknown[]).length),
      worker: 'loop',
      log: () => undefined,
    });
    expect(claims).toEqual([100, 100, 50]);
    expect(summary).toMatchObject({ claimed: 250, sent: 250, batches: 3, expoRequests: 3 });
  });

  it('stops claiming once the time budget is used (injected clock)', async () => {
    const p = await createPack(30);
    await createTraining(p.organizerId, p.communityId);
    for (const [i, id] of p.memberIds.entries()) await addToken(id, expoToken(`clock-${i}`));
    let clock = 0;
    const summary = await dispatchNotifications({
      rpc: realRpc(),
      fetch: async (_u, init) => { clock += 25_000; return okResponse((JSON.parse(init.body) as unknown[]).length); },
      worker: 'clock',
      limit: 10,
      now: () => clock,
      log: () => undefined,
    });
    // Batch 1 at t=0, batch 2 at t=25 s, then t=50 s >= 40 s: stop.
    expect(summary).toMatchObject({ batches: 2, claimed: 20, sent: 20 });
    expect(await countRows('notification_delivery_jobs', "status = 'pending'")).toBe(10);
  });

  it('past the hard deadline the rest of a batch is handed back, not left in sending', async () => {
    const p = await createPack(150);
    await createTraining(p.organizerId, p.communityId);
    for (const [i, id] of p.memberIds.entries()) await addToken(id, expoToken(`late-${i}`));
    let clock = 0;
    const summary = await dispatchNotifications({
      rpc: realRpc(),
      fetch: async (_u, init) => { clock += 120_000; return okResponse((JSON.parse(init.body) as unknown[]).length); },
      worker: 'late',
      limit: 150,
      now: () => clock,
      log: () => undefined,
    });
    expect(summary).toMatchObject({ sent: 100, deferred: 50, failed: 50, expoRequests: 1 });
    expect(await countRows('notification_delivery_jobs', "status = 'sending'")).toBe(0);
  });

  it('stops after a batch with transient trouble instead of claiming more', async () => {
    const p = await createPack(15);
    await createTraining(p.organizerId, p.communityId);
    for (const [i, id] of p.memberIds.entries()) await addToken(id, expoToken(`tr-${i}`));
    const summary = await dispatchNotifications({
      rpc: realRpc(),
      fetch: async () => ({ status: 503, headers: { get: () => null }, json: async () => ({}) }),
      worker: 'tr',
      limit: 5,
      log: () => undefined,
    });
    expect(summary).toMatchObject({ batches: 1, claimed: 5, failed: 5 });
  });

  it('a failure of the second request leaves the first chunk completed and fails only its own jobs', async () => {
    const p = await createPack(130);
    await createTraining(p.organizerId, p.communityId);
    for (const [i, id] of p.memberIds.entries()) await addToken(id, expoToken(`crash-${i}`));
    let call = 0;
    await expect(
      dispatchNotifications({
        rpc: realRpc(),
        fetch: async (_u, init) => {
          call += 1;
          if (call === 2) throw Object.assign(new Error('killed'), { name: 'Killed' });
          return okResponse((JSON.parse(init.body) as unknown[]).length);
        },
        worker: 'crash',
        limit: 130,
        log: () => undefined,
      }),
    ).resolves.toMatchObject({ sent: 100, failed: 30 });
    expect(await countRows('notification_delivery_jobs', "status = 'sent'")).toBe(100);
  });
});
