import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  dispatchNotifications,
  isAuthorized,
  type ClaimedJob,
  type CompleteStatus,
  type DispatchRpc,
  type ExpoMessage,
  type FetchLike,
} from '../functions/dispatch-notifications/dispatch';
import { admin, asService, asUser, closeDb, createPack, createTraining, resetData, rpc, rpcRow } from './helpers';
import { claimJobs, createAnnouncement, expoToken, jobs, registerToken } from './notifications-helpers';

beforeEach(resetData);
afterAll(closeDb);
const resetAll = resetData;

// ---- Real RPCs behind the dispatcher's interface -----------------------------------------

function realRpc(overrides: Partial<DispatchRpc> = {}): DispatchRpc {
  return {
    async claimJobs(limit, worker) {
      return claimJobs(worker, limit) as Promise<ClaimedJob[]>;
    },
    completeJob(jobId: string, status: CompleteStatus, error, retryIn) {
      return asService((db) => rpc(db, 'complete_notification_job', [jobId, status, error, retryIn]));
    },
    invalidateTokens(tokens, error) {
      return asService((db) => rpc(db, 'invalidate_push_tokens', [tokens, error]));
    },
    ...overrides,
  };
}

// ---- Fake Expo ---------------------------------------------------------------------------

type Ticket = { status: 'ok'; id: string } | { status: 'error'; message: string; details: { error: string } };
interface Call {
  messages: ExpoMessage[];
  headers: Record<string, string>;
}

function fakeExpo(
  options: {
    ticket?: (message: ExpoMessage) => Ticket;
    http?: (call: number) => { status: number; headers?: Record<string, string>; body?: unknown } | null;
    throwOnCall?: (call: number) => boolean;
  } = {},
) {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (_url, init) => {
    const messages = JSON.parse(init.body) as ExpoMessage[];
    calls.push({ messages, headers: init.headers });
    const n = calls.length;
    if (options.throwOnCall?.(n)) throw new TypeError('fetch failed');
    const forced = options.http?.(n);
    if (forced) {
      const headers = forced.headers ?? {};
      return {
        status: forced.status,
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
        json: async () => forced.body ?? { errors: [{ code: 'X', message: 'x' }] },
      };
    }
    const data = messages.map(
      (m, i): Ticket =>
        options.ticket?.(m) ?? { status: 'ok', id: `ticket-${n}-${i}` },
    );
    return { status: 200, headers: { get: () => null }, json: async () => ({ data }) };
  };
  return { fetch: fetchFn, calls, sentTo: () => calls.flatMap((c) => c.messages.map((m) => m.to)) };
}

function run(expo: { fetch: FetchLike }, extra: { rpc?: DispatchRpc; limit?: number; accessToken?: string; logs?: string[] } = {}) {
  const logs = extra.logs ?? [];
  return dispatchNotifications({
    rpc: extra.rpc ?? realRpc(),
    fetch: expo.fetch,
    worker: `test-${Math.random().toString(36).slice(2)}`,
    limit: extra.limit,
    accessToken: extra.accessToken,
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
  });
}

// ---- Fixtures ----------------------------------------------------------------------------

async function queued(memberCount: number) {
  const p = await createPack(memberCount);
  const session = await createTraining(p.organizerId, p.communityId);
  return { ...p, session };
}

async function addTokens(userId: string, count: number, prefix: string): Promise<string[]> {
  const tokens = Array.from({ length: count }, (_, i) => expoToken(`${prefix}-${i}`));
  for (const token of tokens) {
    await admin.query(
      "insert into public.device_push_tokens (user_id, token, platform) values ($1, $2, 'android')",
      [userId, token],
    );
  }
  return tokens;
}

const jobOf = async (userId: string) => (await jobs('user_id = $1', [userId]))[0];
const makeDue = (jobId: string) =>
  admin.query("update public.notification_delivery_jobs set next_attempt_at = now() - interval '1 second' where id = $1", [jobId]);

describe('shared secret', () => {
  it('accepts only the exact secret', () => {
    expect(isAuthorized('s3cret-value', 's3cret-value')).toBe(true);
    expect(isAuthorized('s3cret-valuf', 's3cret-value')).toBe(false);
    expect(isAuthorized('s3cret', 's3cret-value')).toBe(false);
    expect(isAuthorized('s3cret-value-and-more', 's3cret-value')).toBe(false);
    expect(isAuthorized('', 's3cret-value')).toBe(false);
    expect(isAuthorized(null, 's3cret-value')).toBe(false);
    expect(isAuthorized(undefined, 's3cret-value')).toBe(false);
  });

  it('rejects everything when no secret is configured, even an empty header', () => {
    expect(isAuthorized('', '')).toBe(false);
    expect(isAuthorized('anything', undefined)).toBe(false);
    expect(isAuthorized('anything', null)).toBe(false);
  });
});

describe('dispatchNotifications: happy paths', () => {
  it('sends one message per token with the deep link and nothing else about the user', async () => {
    const p = await queued(1);
    const [tokenA] = await addTokens(p.memberIds[0], 1, 'a');
    const expo = fakeExpo();
    const logs: string[] = [];

    const summary = await run(expo, { accessToken: 'tok-abc', logs });

    expect(summary).toMatchObject({ claimed: 1, sent: 1, messagesOk: 1, expoRequests: 1, completionErrors: 0 });
    expect(expo.calls).toHaveLength(1);
    expect(expo.calls[0].headers.authorization).toBe('Bearer tok-abc');
    const [message] = expo.calls[0].messages;
    const job = await jobOf(p.memberIds[0]);
    expect(Object.keys(message).sort()).toEqual(
      ['badge', 'body', 'channelId', 'data', 'priority', 'sound', 'title', 'to', 'ttl'].sort(),
    );
    expect(message).toMatchObject({
      to: tokenA,
      title: 'New training: Morning run',
      data: {
        deepLink: `/trainings/${p.session.id}`,
        notificationId: job.notification_id,
        kind: 'training_created',
        communityId: p.communityId,
      },
      sound: 'default',
      channelId: 'default',
      priority: 'high',
      badge: 1,
    });
    // C3: communityId lets the app switch community on a tap without a lookup.
    expect(Object.keys(message.data).sort()).toEqual(['communityId', 'deepLink', 'kind', 'notificationId']);
    expect(message.ttl).toBeGreaterThan(0);
    expect(job).toMatchObject({ status: 'sent', attempts: 1 });
    expect(job.sent_at).toBeInstanceOf(Date);
    // Logs hold counts and codes only.
    const all = logs.join('\n');
    expect(all).not.toContain(tokenA);
    expect(all).not.toContain('ExponentPushToken');
    expect(all).not.toContain('Morning run');
    expect(all).not.toContain('tok-abc');
  });

  it('omits the authorization header without an access token', async () => {
    const p = await queued(1);
    await addTokens(p.memberIds[0], 1, 'a');
    const expo = fakeExpo();
    await run(expo);
    expect(expo.calls[0].headers.authorization).toBeUndefined();
  });

  it('sends to every token of a multi-token job and counts it sent once', async () => {
    const p = await queued(2);
    const tokens = await addTokens(p.memberIds[0], 3, 'multi');
    await addTokens(p.memberIds[1], 1, 'single');
    const expo = fakeExpo();

    const summary = await run(expo);

    expect(summary).toMatchObject({ claimed: 2, sent: 2, messagesOk: 4 });
    expect(expo.sentTo().filter((t) => tokens.includes(t)).sort()).toEqual([...tokens].sort());
    expect((await jobs()).map((j) => j.status)).toEqual(['sent', 'sent']);
  });

  it('derives the ttl from an expires_at the claim provides', async () => {
    const p = await queued(1);
    await addTokens(p.memberIds[0], 1, 'a');
    const expo = fakeExpo();
    const real = realRpc();
    await run(expo, {
      rpc: {
        ...real,
        async claimJobs(limit, worker) {
          const claimed = await real.claimJobs(limit, worker);
          return claimed.map((j) => ({ ...j, expires_at: new Date(Date.now() + 600_000).toISOString() }));
        },
      },
    });
    expect(expo.calls[0].messages[0].ttl).toBeGreaterThan(500);
    expect(expo.calls[0].messages[0].ttl).toBeLessThanOrEqual(600);
  });

  it('chunks at 100 messages per request', async () => {
    const p = await queued(11);
    for (const [i, id] of p.memberIds.entries()) await addTokens(id, 10, `chunk${i}`);
    const expo = fakeExpo();

    const summary = await run(expo);

    expect(summary).toMatchObject({ claimed: 11, sent: 11, messagesOk: 110, expoRequests: 2 });
    expect(expo.calls.map((c) => c.messages.length)).toEqual([100, 10]);
  });
});

describe('dispatchNotifications: skipped jobs never reach Expo', () => {
  it('skips users without tokens, with push disabled or the category switched off', async () => {
    const p = await queued(3);
    await addTokens(p.memberIds[0], 1, 'none-needed');
    await asUser(p.memberIds[0], (db) => rpcRow(db, 'set_notification_preferences', [false, null, null, null]));
    await addTokens(p.memberIds[1], 1, 'cat');
    await asUser(p.memberIds[1], (db) => rpcRow(db, 'set_notification_preferences', [null, null, null, false]));
    // memberIds[2] has no token at all.
    const expo = fakeExpo();

    const summary = await run(expo);

    expect(expo.calls).toHaveLength(0);
    expect(summary).toMatchObject({ claimed: 3, skipped: 3, sent: 0, expoRequests: 0 });
    expect((await jobOf(p.memberIds[0])).last_error).toBe('push_disabled');
    expect((await jobOf(p.memberIds[1])).last_error).toBe('category_disabled');
    expect((await jobOf(p.memberIds[2])).last_error).toBe('no_tokens');
    expect((await jobs()).every((j) => j.status === 'skipped')).toBe(true);
  });

  it('never sends expired jobs (the claim kills them)', async () => {
    const p = await queued(1);
    await addTokens(p.memberIds[0], 1, 'a');
    await admin.query("update public.notification_delivery_jobs set expires_at = now() - interval '1 second'");
    const expo = fakeExpo();

    const summary = await run(expo);

    expect(summary.claimed).toBe(0);
    expect(expo.calls).toHaveLength(0);
    expect(await jobOf(p.memberIds[0])).toMatchObject({ status: 'dead', last_error: 'expired' });
  });
});

describe('dispatchNotifications: invalid tokens', () => {
  const notRegistered = (message: ExpoMessage, bad: string[]): Ticket =>
    bad.includes(message.to)
      ? {
          status: 'error',
          message: `The recipient device is not registered with FCM (${message.to})`,
          details: { error: 'DeviceNotRegistered' },
        }
      : { status: 'ok', id: 'x' };

  it('invalidates the token, still sends the job via its other token, and never claims it again', async () => {
    const p = await queued(1);
    const [good, bad] = await addTokens(p.memberIds[0], 2, 'mix');
    const expo = fakeExpo({ ticket: (m) => notRegistered(m, [bad]) });
    const logs: string[] = [];

    const summary = await run(expo, { logs });

    expect(summary).toMatchObject({ sent: 1, tokensInvalidated: 1 });
    const { rows } = await admin.query<{ token: string; invalidated_at: Date | null; last_error: string | null }>(
      'select token, invalidated_at, last_error from public.device_push_tokens order by token',
    );
    const byToken = Object.fromEntries(rows.map((r) => [r.token, r]));
    expect(byToken[bad].invalidated_at).toBeInstanceOf(Date);
    expect(byToken[bad].last_error).toBe('DeviceNotRegistered');
    expect(byToken[good].invalidated_at).toBeNull();
    // The Expo message text (which can contain the token) is never logged or stored.
    expect(logs.join('\n')).not.toContain(bad);

    // A later notification for the same user only goes to the valid token.
    await createTraining(p.organizerId, p.communityId, { title: 'Second run' });
    const expo2 = fakeExpo();
    await run(expo2);
    expect(expo2.sentTo()).toEqual([good]);
  });

  it('skips the job (no_valid_tokens) when every token is invalid', async () => {
    const p = await queued(1);
    const tokens = await addTokens(p.memberIds[0], 2, 'allbad');
    const expo = fakeExpo({ ticket: (m) => notRegistered(m, tokens) });

    const summary = await run(expo);

    expect(summary).toMatchObject({ skipped: 1, sent: 0, tokensInvalidated: 2 });
    expect(await jobOf(p.memberIds[0])).toMatchObject({ status: 'skipped', last_error: 'no_valid_tokens' });
    const { rows } = await admin.query('select 1 from public.device_push_tokens where invalidated_at is null');
    expect(rows).toEqual([]);
  });
});

describe('dispatchNotifications: failures', () => {
  it('429 with Retry-After schedules the retry at that time', async () => {
    const p = await queued(1);
    await addTokens(p.memberIds[0], 1, 'a');
    const expo = fakeExpo({ http: () => ({ status: 429, headers: { 'retry-after': '120' } }) });

    const summary = await run(expo);

    expect(summary).toMatchObject({ failed: 1, sent: 0 });
    const job = await jobOf(p.memberIds[0]);
    expect(job).toMatchObject({ status: 'failed', attempts: 1, last_error: 'transient:HTTP_429' });
    const wait = job.next_attempt_at.getTime() - Date.now();
    expect(wait).toBeGreaterThan(100_000);
    expect(wait).toBeLessThan(125_000);
    // Not due yet: nothing is claimed.
    expect((await run(fakeExpo())).claimed).toBe(0);
  });

  it('5xx uses the default backoff (30 s, then 60 s) and the job is dead after max attempts', async () => {
    const p = await queued(1);
    await addTokens(p.memberIds[0], 1, 'a');
    const expo = fakeExpo({ http: () => ({ status: 503 }) });

    await run(expo);
    let job = await jobOf(p.memberIds[0]);
    expect(job).toMatchObject({ status: 'failed', attempts: 1 });
    expect(job.next_attempt_at.getTime() - Date.now()).toBeGreaterThan(20_000);
    expect(job.next_attempt_at.getTime() - Date.now()).toBeLessThan(35_000);

    for (let attempt = 2; attempt <= 5; attempt++) {
      await makeDue(job.id);
      await run(expo);
      job = await jobOf(p.memberIds[0]);
      expect(job.attempts).toBe(attempt);
      if (attempt === 2) {
        expect(job.next_attempt_at.getTime() - Date.now()).toBeGreaterThan(50_000);
      }
    }
    expect(job.status).toBe('dead');
    expect(expo.calls).toHaveLength(5);
    // Dead jobs are never claimed again.
    await makeDue(job.id);
    expect((await run(expo)).claimed).toBe(0);
  });

  it('a network error and a MessageRateExceeded ticket are transient', async () => {
    const p = await queued(2);
    const [a] = await addTokens(p.memberIds[0], 1, 'net');
    const [b] = await addTokens(p.memberIds[1], 1, 'rate');
    const net = fakeExpo({ throwOnCall: () => true });
    await run(net);
    expect((await jobs()).map((j) => [j.status, j.last_error])).toEqual([
      ['failed', 'transient:NetworkError'],
      ['failed', 'transient:NetworkError'],
    ]);

    for (const j of await jobs()) await makeDue(j.id);
    const rate = fakeExpo({
      ticket: () => ({ status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } }),
    });
    await run(rate);
    expect((await jobs()).map((j) => [j.status, j.attempts, j.last_error])).toEqual([
      ['failed', 2, 'transient:MessageRateExceeded'],
      ['failed', 2, 'transient:MessageRateExceeded'],
    ]);
    expect([a, b].length).toBe(2);
  });

  it('a request timeout is transient', async () => {
    const p = await queued(1);
    await addTokens(p.memberIds[0], 1, 'a');
    const hang: FetchLike = (_url, init) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    await dispatchNotifications({
      rpc: realRpc(),
      fetch: hang,
      worker: 'timeout-worker',
      timeoutMs: 30,
      log: () => undefined,
    });
    expect(await jobOf(p.memberIds[0])).toMatchObject({ status: 'failed', last_error: 'transient:Timeout' });
  });

  it('permanent errors mark the job dead without a retry', async () => {
    const p = await queued(3);
    const [t0, t1, t2] = await Promise.all(p.memberIds.map(async (id, i) => (await addTokens(id, 1, `perm${i}`))[0]));
    const codes: Record<string, string> = { [t0]: 'MessageTooBig', [t1]: 'InvalidCredentials', [t2]: 'InvalidPayload' };
    const expo = fakeExpo({
      ticket: (m) => ({ status: 'error', message: `bad ${m.to}`, details: { error: codes[m.to] } }),
    });
    const logs: string[] = [];

    const summary = await run(expo, { logs });

    expect(summary).toMatchObject({ dead: 3, failed: 0 });
    const rows = await jobs();
    expect(rows.map((j) => j.status)).toEqual(['dead', 'dead', 'dead']);
    expect(rows.map((j) => j.last_error).sort()).toEqual([
      'permanent:InvalidCredentials',
      'permanent:InvalidPayload',
      'permanent:MessageTooBig',
    ]);
    expect(logs.join('\n')).not.toContain('ExponentPushToken');
    await Promise.all(rows.map((j) => makeDue(j.id)));
    expect((await run(fakeExpo())).claimed).toBe(0);
  });

  it('an HTTP 400 is permanent; a 401 (bad access token) is retried with backoff', async () => {
    const p = await queued(1);
    await addTokens(p.memberIds[0], 1, 'a');
    await run(fakeExpo({ http: () => ({ status: 400 }) }));
    expect(await jobOf(p.memberIds[0])).toMatchObject({ status: 'dead', last_error: 'permanent:HTTP_400' });

    await resetAll();
    const q = await queued(1);
    await addTokens(q.memberIds[0], 1, 'b');
    await run(fakeExpo({ http: () => ({ status: 401 }) }));
    expect(await jobOf(q.memberIds[0])).toMatchObject({ status: 'failed', last_error: 'transient:HTTP_401' });
  });

  it('a malformed response is transient', async () => {
    const p = await queued(1);
    await addTokens(p.memberIds[0], 1, 'a');
    await run(fakeExpo({ http: () => ({ status: 200, body: { data: [] } }) }));
    expect(await jobOf(p.memberIds[0])).toMatchObject({ status: 'failed', last_error: 'transient:BadResponse' });
  });

  it('one transient and one ok token: the job counts as sent (no duplicate pushes on retry)', async () => {
    const p = await queued(1);
    const [a, b] = await addTokens(p.memberIds[0], 2, 'half');
    const expo = fakeExpo({
      ticket: (m) =>
        m.to === b ? { status: 'error', message: 'x', details: { error: 'MessageRateExceeded' } } : { status: 'ok', id: 'i' },
    });
    await run(expo);
    expect(expo.sentTo().sort()).toEqual([a, b].sort());
    expect((await jobOf(p.memberIds[0])).status).toBe('sent');
  });
});

describe('dispatchNotifications: concurrency and crashes', () => {
  it('two concurrent runs never push the same job twice', async () => {
    const p = await queued(12);
    const all: string[] = [];
    for (const [i, id] of p.memberIds.entries()) all.push(...(await addTokens(id, 1, `conc${i}`)));
    const expo = fakeExpo();

    const [a, b] = await Promise.all([run(expo, { limit: 5 }), run(expo, { limit: 5 })]);
    const [c, d] = await Promise.all([run(expo, { limit: 5 }), run(expo, { limit: 5 })]);

    expect(a.claimed + b.claimed + c.claimed + d.claimed).toBe(12);
    expect(expo.sentTo().sort()).toEqual([...all].sort());
    expect((await jobs()).every((j) => j.status === 'sent' && j.attempts === 1)).toBe(true);
  });

  it('a crash after sending leaves the job in sending and it is reclaimed after the stuck timeout', async () => {
    const p = await queued(1);
    const [token] = await addTokens(p.memberIds[0], 1, 'a');
    const expo = fakeExpo();
    const crashing = realRpc({
      completeJob: () => Promise.reject(new Error('worker died')),
    });

    const summary = await run(expo, { rpc: crashing });

    expect(summary).toMatchObject({ claimed: 1, sent: 0, completionErrors: 1 });
    expect(await jobOf(p.memberIds[0])).toMatchObject({ status: 'sending', attempts: 1 });
    // Not reclaimable yet.
    expect((await run(fakeExpo())).claimed).toBe(0);

    await admin.query("update public.notification_delivery_jobs set locked_at = now() - interval '6 minutes'");
    const retry = fakeExpo();
    const second = await run(retry);

    expect(second).toMatchObject({ claimed: 1, sent: 1 });
    expect(retry.sentTo()).toEqual([token]); // the accepted at-least-once duplicate
    expect(await jobOf(p.memberIds[0])).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('a failing token invalidation leaves undelivered jobs reclaimable instead of completing them', async () => {
    const p = await queued(1);
    const [bad] = await addTokens(p.memberIds[0], 1, 'bad');
    const expo = fakeExpo({
      ticket: () => ({ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }),
    });
    const summary = await run(expo, {
      rpc: realRpc({ invalidateTokens: () => Promise.reject(new Error('db down')) }),
    });
    expect(summary.completionErrors).toBe(1);
    expect(await jobOf(p.memberIds[0])).toMatchObject({ status: 'sending' });
    expect(bad).toBeTruthy();
  });

  it('works for announcement jobs too (deep link /announcements/<id>)', async () => {
    const p = await createPack(1);
    await addTokens(p.memberIds[0], 1, 'ann');
    const announcement = await createAnnouncement(p.organizerId, p.communityId, { title: 'Hello team' });
    const expo = fakeExpo();

    await run(expo);

    expect(expo.calls[0].messages[0]).toMatchObject({
      title: expect.stringContaining('Hello team'),
      data: { deepLink: `/announcements/${announcement.id}`, kind: 'announcement_published', communityId: p.communityId },
    });
    expect(expo.calls[0].messages[0].ttl).toBe(86_400);
  });
});

describe('dispatch RPC authorization', () => {
  it('the dispatcher RPCs are not callable by signed-in users', async () => {
    const p = await queued(1);
    for (const [fn, args] of [
      ['claim_notification_jobs', [10, 'x']],
      ['complete_notification_job', ['00000000-0000-0000-0000-000000000000', 'sent', null, null]],
      ['invalidate_push_tokens', [[expoToken('x')], 'DeviceNotRegistered']],
    ] as const) {
      await expect(asUser(p.organizerId, (db) => rpc(db, fn, [...args]))).rejects.toMatchObject({ code: '42501' });
    }
    // And the registered-token helper still works for the owner.
    await registerToken(p.memberIds[0], expoToken('own'));
  });
});

describe('schedule migration', () => {
  it('schedules nothing without pg_cron and pg_net (no-op here), and stores no secret', async () => {
    const cron = await admin.query("select 1 from pg_namespace where nspname in ('cron', 'net', 'vault')");
    expect(cron.rows).toEqual([]);
    const fs = await import('node:fs');
    const path = await import('node:path');
    const sql = fs.readFileSync(
      path.resolve(__dirname, '../migrations/20261115000600_schedule_dispatch.sql'),
      'utf8',
    );
    expect(sql).toContain('vault.decrypted_secrets');
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });
});
