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
import { admin, asService, closeDb, createPack, createTraining, resetData, rpc } from './helpers';
import { claimJobs, expoToken, jobs } from './notifications-helpers';

/**
 * QA (M3-Q1): dispatcher edge cases against the real RPCs and a fake Expo.
 * `DEFECT Q4-n` tests use it.fails and turn red when the defect is fixed.
 */

beforeEach(resetData);
afterAll(closeDb);

function realRpc(): DispatchRpc {
  return {
    claimJobs: (limit, worker) => claimJobs(worker, limit) as Promise<ClaimedJob[]>,
    completeJob: (jobId: string, status: CompleteStatus, error, retryIn) =>
      asService((db) => rpc(db, 'complete_notification_job', [jobId, status, error, retryIn])),
    invalidateTokens: (tokens, error) => asService((db) => rpc(db, 'invalidate_push_tokens', [tokens, error])),
  };
}

const ok = (n: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ status: 'ok', id: `t-${n}-${i}` }));

async function addToken(userId: string, token: string) {
  await admin.query("insert into public.device_push_tokens (user_id, token, platform) values ($1, $2, 'android')", [userId, token]);
}

describe('shared secret: edge cases', () => {
  it('rejects every non-exact value, including look-alikes, padding, case, prefixes and absurd lengths', () => {
    const secret = 'Zm9vYmFyYmF6cXV4LXNlY3JldA==';
    expect(isAuthorized(secret, secret)).toBe(true);
    const wrong: (string | null | undefined)[] = [
      '', ' ', secret + ' ', ' ' + secret, secret + '\n', secret.toUpperCase(), secret.slice(0, -1), secret + 'x',
      secret.slice(1), `Bearer ${secret}`, null, undefined, 'x'.repeat(100_000), secret + '\u0000',
    ];
    for (const value of wrong) expect(isAuthorized(value, secret), JSON.stringify(value)?.slice(0, 40)).toBe(false);
  });

  it('an unset, null, empty configuration rejects everything, including an equally empty header', () => {
    for (const expected of [undefined, null, '']) {
      for (const provided of [undefined, null, '', 'x', 'undefined', 'null']) {
        expect(isAuthorized(provided, expected)).toBe(false);
      }
    }
  });

  it('non-string inputs from a hostile runtime do not throw or authorize', () => {
    for (const v of [0, 1, {}, [], ['secret'], true] as unknown[]) {
      expect(isAuthorized(v as string, 'secret')).toBe(false);
    }
  });

  it('multi-byte secrets compare by bytes: equal length in characters is not enough', () => {
    expect(isAuthorized('é', 'e')).toBe(false);
    expect(isAuthorized('éa', 'aé')).toBe(false);
    expect(isAuthorized('日本語', '日本語')).toBe(true);
  });
});

describe('dispatcher: request-level failures must not spread to other users', () => {
  // DEFECT Q4-1 (medium): an HTTP 4xx answer applies to the WHOLE request (Expo docs: "4xx or
  // 5xx: the whole request failed"), and the dispatcher marks every job of the chunk dead on
  // HTTP 400. PUSH_TOO_MANY_EXPERIENCE_IDS is exactly such a whole-request error, triggered by a
  // single token that belongs to another Expo project, and register_push_token accepts ANY
  // well-formed token (anonymous sign-in is free). One hostile or stale token therefore kills
  // the pending notification of up to 99 other users per chunk. Expected: drop or bisect the
  // offending token(s) and resend, so unrelated jobs are still delivered.
  it.fails('DEFECT Q4-1: one foreign-project token makes Expo reject the chunk; the other users are still delivered', async () => {
    const p = await createPack(3);
    await createTraining(p.organizerId, p.communityId);
    const [good1, bad, good2] = p.memberIds;
    await addToken(good1, expoToken('good-1'));
    await addToken(bad, expoToken('foreign-project'));
    await addToken(good2, expoToken('good-2'));
    const fetchFn: FetchLike = async (_url, init) => {
      const messages = JSON.parse(init.body) as ExpoMessage[];
      if (messages.some((m) => m.to.includes('foreign'))) {
        return {
          status: 400,
          headers: { get: () => null },
          json: async () => ({ errors: [{ code: 'PUSH_TOO_MANY_EXPERIENCE_IDS', message: 'x' }] }),
        };
      }
      return { status: 200, headers: { get: () => null }, json: async () => ({ data: ok(1, messages.length) }) };
    };
    await dispatchNotifications({ rpc: realRpc(), fetch: fetchFn, worker: 'qa', log: () => undefined });
    const status = async (u: string) => (await jobs('user_id = $1', [u]))[0].status;
    expect(await status(good1)).toBe('sent');
    expect(await status(good2)).toBe('sent');
  });

  // DEFECT Q4-2 (low-medium): jobs are only completed after EVERY Expo request of the run has
  // finished. A run that is killed between chunks (Edge wall-clock limit, platform restart, the
  // 150 s cap with 10 tokens per user) leaves jobs that Expo already accepted in `sending`; they
  // are reclaimed after 5 minutes and pushed AGAIN. Expected: a job is completed as soon as its
  // own Expo answer is known.
  it.fails('DEFECT Q4-2: jobs of an answered chunk are completed before the next Expo request is made', async () => {
    const p = await createPack(130);
    await createTraining(p.organizerId, p.communityId);
    for (const [i, id] of p.memberIds.entries()) await addToken(id, expoToken(`bulk-${i}`));

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let call = 0;
    const fetchFn: FetchLike = async (_url, init) => {
      const messages = JSON.parse(init.body) as ExpoMessage[];
      call += 1;
      const n = call;
      if (n === 2) await gate;
      return { status: 200, headers: { get: () => null }, json: async () => ({ data: ok(n, messages.length) }) };
    };
    const run = dispatchNotifications({ limit: 130, rpc: realRpc(), fetch: fetchFn, worker: 'qa', log: () => undefined });
    try {
      for (let i = 0; i < 200 && call < 2; i += 1) await new Promise((r) => setTimeout(r, 25));
      expect(call).toBe(2);
      const sentWhileSecondInFlight = (await jobs("status = 'sent'")).length;
      expect(sentWhileSecondInFlight).toBe(100);
    } finally {
      release();
      await run;
    }
  });

  it('a transport failure in one chunk does not stop the later chunks (documented behaviour)', async () => {
    const p = await createPack(120);
    await createTraining(p.organizerId, p.communityId);
    for (const [i, id] of p.memberIds.entries()) await addToken(id, expoToken(`mix-${i}`));
    let call = 0;
    const fetchFn: FetchLike = async (_url, init) => {
      const messages = JSON.parse(init.body) as ExpoMessage[];
      call += 1;
      if (call === 1) throw new TypeError('fetch failed');
      return { status: 200, headers: { get: () => null }, json: async () => ({ data: ok(call, messages.length) }) };
    };
    const summary = await dispatchNotifications({ limit: 120, rpc: realRpc(), fetch: fetchFn, worker: 'qa', log: () => undefined });
    expect(summary.expoRequests).toBe(2);
    expect(summary.failed).toBe(100);
    expect(summary.sent).toBe(20);
  });

  it('logs never contain tokens, titles or bodies, even for failing chunks', async () => {
    const p = await createPack(2);
    await createTraining(p.organizerId, p.communityId, { title: 'Secret Squad Run' });
    await addToken(p.memberIds[0], expoToken('leak-check'));
    await addToken(p.memberIds[1], expoToken('leak-check-2'));
    const logs: string[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      const messages = JSON.parse(init.body) as ExpoMessage[];
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({ data: messages.map((m) => ({ status: 'error', message: `bad ${m.to}`, details: { error: 'DeviceNotRegistered' } })) }),
      };
    };
    await dispatchNotifications({ rpc: realRpc(), fetch: fetchFn, worker: 'qa', log: (e, f) => logs.push(JSON.stringify({ e, f })) });
    const all = logs.join('\n');
    expect(all).not.toMatch(/leak-check|ExponentPushToken|Secret Squad/);
    const stored = await jobs();
    expect(stored.map((j) => j.last_error).join(' ')).not.toMatch(/leak-check|ExponentPushToken/);
  });
});
