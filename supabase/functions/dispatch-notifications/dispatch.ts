/**
 * TrainHive M3-B2 (+ M3-B3 fixes): delivers queued notification jobs through the Expo Push Service.
 *
 * Pure module: no Deno globals, no I/O of its own. `fetch`, the RPC client, the clock and the
 * logger are injected so the same code runs in the Edge Function (index.ts) and in the Vitest
 * integration tests (fake Expo server + the real Postgres RPCs).
 *
 * One run claims jobs in batches until the queue is empty or the time budget is used. Inside a
 * batch the messages (one per token) are packed into requests of at most 100 messages without
 * splitting a job across requests, and the jobs of a request are completed as soon as that
 * request's tickets are processed (M3-B3, Q4-2), so a run killed later never re-pushes them.
 *
 * A whole-request rejection (HTTP 4xx other than 401/403/429, e.g. PUSH_TOO_MANY_EXPERIENCE_IDS
 * when one token belongs to another Expo project) is bisected: the request is split in halves,
 * recursively, down to single messages, so only the offending messages fail (M3-B3, Q4-1). The
 * extra requests are bounded per run (`maxExpoRequests`); what does not fit is retried later.
 *
 * Delivery is at-least-once. A job is only completed from `sending`; a worker that dies after
 * pushing but before completing is reclaimed by `claim_notification_jobs` after 5 minutes and
 * may push the same notification again. Expo has no idempotency key; the app can dedupe on
 * `data.notificationId`.
 *
 * Nothing here logs or stores a push token or a payload: only counts and error codes.
 */

export const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const MAX_MESSAGES_PER_REQUEST = 100;
export const DEFAULT_TIMEOUT_MS = 15_000;
/** No new batch is claimed once this much time has passed since the run started. */
export const DEFAULT_TIME_BUDGET_MS = 40_000;
/** No new Expo request is started after this; the rest of the batch is retried by a later run. */
export const DEFAULT_HARD_DEADLINE_MS = 100_000;
/** Upper bound of Expo requests per run, bisection included. */
export const DEFAULT_MAX_EXPO_REQUESTS = 60;
const MAX_RETRY_SECONDS = 86_400;

// ---- Contract types (see docs/API_CONTRACT.md, "Dispatcher contract") ---------------------

export interface ClaimedJob {
  job_id: string;
  notification_id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  deep_link: string;
  community_id: string;
  related_session_id: string | null;
  related_announcement_id: string | null;
  attempts: number;
  max_attempts: number;
  unread_count: number;
  push_allowed: boolean;
  skip_reason: string | null;
  tokens: string[];
  /** Not returned by claim_notification_jobs today; used for the ttl when present. */
  expires_at?: string | null;
}

export type CompleteStatus = 'sent' | 'skipped' | 'failed' | 'dead';

/** The three service_role RPCs the dispatcher needs. */
export interface DispatchRpc {
  claimJobs(limit: number, worker: string): Promise<ClaimedJob[]>;
  completeJob(
    jobId: string,
    status: CompleteStatus,
    error: string | null,
    retryInSeconds: number | null,
  ): Promise<unknown>;
  invalidateTokens(tokens: string[], error: string): Promise<unknown>;
}

// ---- Injected I/O ------------------------------------------------------------------------

export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export type LogFields = Record<string, string | number | boolean | null>;
export type Logger = (event: string, fields: LogFields) => void;

export interface DispatchOptions {
  rpc: DispatchRpc;
  fetch: FetchLike;
  worker: string;
  /** Jobs claimed per batch (claim_notification_jobs p_limit). */
  limit?: number;
  /** Expo access token (only when "enhanced push security" is enabled for the project). */
  accessToken?: string;
  timeoutMs?: number;
  /** See DEFAULT_TIME_BUDGET_MS. */
  timeBudgetMs?: number;
  /** See DEFAULT_HARD_DEADLINE_MS. */
  hardDeadlineMs?: number;
  /** See DEFAULT_MAX_EXPO_REQUESTS. */
  maxExpoRequests?: number;
  now?: () => number;
  log?: Logger;
}

export interface DispatchSummary {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  dead: number;
  /** Messages (one per token) Expo accepted. */
  messagesOk: number;
  tokensInvalidated: number;
  expoRequests: number;
  /** Jobs whose completion (or the invalidation) threw: they stay `sending` and are reclaimed. */
  completionErrors: number;
  /** claim_notification_jobs calls that returned at least one job. */
  batches: number;
  /** Whole-request rejections that were split in halves. */
  bisections: number;
  /** Jobs handed back (`failed`, retried at once) because the deadline or request cap was hit. */
  deferred: number;
}

// ---- Shared-secret authentication --------------------------------------------------------

/**
 * Constant-time comparison of the `x-dispatch-secret` header with the configured secret.
 * A missing/empty configured secret rejects everything (a misconfigured function must not be
 * open). The loop always walks max(len) bytes so length is not leaked through timing.
 */
export function isAuthorized(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!expected || expected.length === 0) return false;
  if (typeof provided !== 'string') return false;
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(expected);
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

// ---- Message building --------------------------------------------------------------------

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  /** communityId (C3): the community of the notification, so a tap can switch to it without a lookup. */
  data: { deepLink: string; notificationId: string; kind: string; communityId: string };
  sound: 'default';
  channelId: 'default';
  priority: 'high';
  ttl: number;
  badge: number;
}

/** Default time-to-live when the job carries no expiry: announcements 24 h, trainings 1 h. */
function defaultTtl(kind: string): number {
  return kind === 'announcement_published' ? 86_400 : 3_600;
}

export function ttlSeconds(job: ClaimedJob, nowMs: number): number {
  if (job.expires_at) {
    const left = Math.floor((Date.parse(job.expires_at) - nowMs) / 1000);
    if (Number.isFinite(left)) return Math.max(60, Math.min(left, 3 * 86_400));
  }
  return defaultTtl(job.kind);
}

export function buildMessage(job: ClaimedJob, token: string, nowMs: number): ExpoMessage {
  return {
    to: token,
    title: job.title,
    body: job.body,
    data: {
      deepLink: job.deep_link,
      notificationId: job.notification_id,
      kind: job.kind,
      communityId: job.community_id,
    },
    sound: 'default',
    channelId: 'default',
    priority: 'high',
    ttl: ttlSeconds(job, nowMs),
    badge: Math.max(0, Math.trunc(job.unread_count ?? 0)),
  };
}

// ---- Outcomes ----------------------------------------------------------------------------

type Outcome =
  | { type: 'ok' }
  | { type: 'not_registered' }
  | { type: 'transient'; code: string; retryAfter: number | null }
  | { type: 'permanent'; code: string }
  /** A single message whose request Expo rejected as a whole (HTTP 4xx), found by bisection. */
  | { type: 'rejected'; code: string; reason: string };

const PERMANENT_CODES = new Set([
  'MessageTooBig',
  'InvalidCredentials',
  'InvalidPayload',
  'MismatchSenderId',
]);

/**
 * Request-level codes that are about the request itself, not about a token: a single message
 * rejected with one of these never invalidates its token.
 */
const NON_TOKEN_REQUEST_CODES = new Set(['PUSH_TOO_MANY_NOTIFICATIONS', 'TOO_MANY_REQUESTS', 'UNAUTHORIZED']);

/** Retry-After as seconds (integer or HTTP-date), clamped to what the RPC accepts. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  let seconds: number;
  if (/^\d+$/.test(trimmed)) {
    seconds = Number(trimmed);
  } else {
    const at = Date.parse(trimmed);
    if (!Number.isFinite(at)) return null;
    seconds = Math.ceil((at - nowMs) / 1000);
  }
  return Math.min(MAX_RETRY_SECONDS, Math.max(0, seconds));
}

/** Only ever a short code: never the Expo message text, which can contain the token. */
function safeCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(value) ? value : fallback;
}

function ticketOutcome(ticket: unknown): Outcome {
  if (typeof ticket !== 'object' || ticket === null) return { type: 'transient', code: 'BadTicket', retryAfter: null };
  const t = ticket as { status?: unknown; details?: { error?: unknown } };
  if (t.status === 'ok') return { type: 'ok' };
  const code = safeCode(t.details?.error, 'UnknownError');
  if (code === 'DeviceNotRegistered') return { type: 'not_registered' };
  if (code === 'MessageRateExceeded') return { type: 'transient', code, retryAfter: null };
  if (PERMANENT_CODES.has(code)) return { type: 'permanent', code };
  // Unknown error: retry (bounded by max_attempts) rather than dropping the notification.
  return { type: 'transient', code, retryAfter: null };
}

type ChunkAnswer =
  | { kind: 'outcomes'; outcomes: Outcome[]; transport: string }
  /** HTTP 4xx (not 401/403/429): Expo rejected the whole request. */
  | { kind: 'rejected'; status: number; code: string; transport: string };

/** Sends one request; never throws. */
async function sendChunk(messages: ExpoMessage[], opts: DispatchOptions, nowMs: number): Promise<ChunkAnswer> {
  const all = (outcome: Outcome, transport: string): ChunkAnswer => ({
    kind: 'outcomes',
    outcomes: messages.map(() => outcome),
    transport,
  });
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (opts.accessToken) headers.authorization = `Bearer ${opts.accessToken}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await opts.fetch(EXPO_SEND_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(messages),
      signal: controller.signal,
    });
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'), nowMs);
      return all({ type: 'transient', code: `HTTP_${res.status}`, retryAfter }, `http_${res.status}`);
    }
    if (res.status === 401 || res.status === 403) {
      // Credentials/config problem on our side (bad or missing EXPO_ACCESS_TOKEN). Retry with
      // backoff so fixing the secret recovers the queue; max_attempts bounds it.
      return all({ type: 'transient', code: `HTTP_${res.status}`, retryAfter: null }, `http_${res.status}`);
    }
    if (res.status < 200 || res.status >= 300) {
      // Whole-request rejection. The Expo error code (e.g. PUSH_TOO_MANY_EXPERIENCE_IDS) is
      // kept only as a short code; the message text and `details` may contain tokens.
      let code = `HTTP_${res.status}`;
      try {
        const body = (await res.json()) as { errors?: { code?: unknown }[] } | null;
        code = safeCode(body?.errors?.[0]?.code, code);
      } catch {
        // No JSON body: the HTTP status is the code.
      }
      return { kind: 'rejected', status: res.status, code, transport: `http_${res.status}` };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return all({ type: 'transient', code: 'BadResponse', retryAfter: null }, 'bad_json');
    }
    const data = (json as { data?: unknown } | null)?.data;
    if (!Array.isArray(data) || data.length !== messages.length) {
      return all({ type: 'transient', code: 'BadResponse', retryAfter: null }, 'bad_shape');
    }
    return { kind: 'outcomes', outcomes: data.map(ticketOutcome), transport: 'ok' };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return all(
      { type: 'transient', code: aborted ? 'Timeout' : 'NetworkError', retryAfter: null },
      aborted ? 'timeout' : 'network_error',
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---- The run -----------------------------------------------------------------------------

const defaultLog: Logger = (event, fields) => {
  console.log(JSON.stringify({ event, ...fields }));
};

interface JobState {
  job: ClaimedJob;
  pending: number;
  ok: number;
  notRegistered: string[];
  transient: { code: string; retryAfter: number | null }[];
  permanent: string[];
  /** The invalid tokens of this job could not be recorded. */
  invalidationFailed: boolean;
  deferred: boolean;
}

interface Entry {
  state: JobState;
  token: string;
  message: ExpoMessage;
}

export async function dispatchNotifications(opts: DispatchOptions): Promise<DispatchSummary> {
  const log = opts.log ?? defaultLog;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const batchSize = opts.limit ?? 100;
  const timeBudgetMs = opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const hardDeadlineMs = opts.hardDeadlineMs ?? DEFAULT_HARD_DEADLINE_MS;
  const maxRequests = opts.maxExpoRequests ?? DEFAULT_MAX_EXPO_REQUESTS;
  const summary: DispatchSummary = {
    claimed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    dead: 0,
    messagesOk: 0,
    tokensInvalidated: 0,
    expoRequests: 0,
    completionErrors: 0,
    batches: 0,
    bisections: 0,
    deferred: 0,
  };
  const elapsed = () => now() - startedAt;

  const complete = async (
    job: ClaimedJob,
    status: CompleteStatus,
    error: string | null,
    retryIn: number | null,
  ): Promise<void> => {
    try {
      await opts.rpc.completeJob(job.job_id, status, error, retryIn);
      summary[status === 'sent' ? 'sent' : status === 'skipped' ? 'skipped' : status === 'failed' ? 'failed' : 'dead']++;
    } catch (e) {
      // Left in `sending`; claim_notification_jobs reclaims it after the stuck timeout.
      summary.completionErrors++;
      log('complete_failed', { jobId: job.job_id, status, error: e instanceof Error ? e.name : 'unknown' });
    }
  };

  const invalidate = async (tokens: string[], reason: string): Promise<boolean> => {
    if (tokens.length === 0) return true;
    try {
      const n = await opts.rpc.invalidateTokens(tokens, reason);
      if (typeof n === 'number') summary.tokensInvalidated += n;
      return true;
    } catch (e) {
      summary.completionErrors++;
      log('invalidate_failed', { tokens: tokens.length, reason, error: e instanceof Error ? e.name : 'unknown' });
      return false;
    }
  };

  /** Applies the outcome rules to a job whose messages all have an answer. */
  const finish = async (s: JobState): Promise<void> => {
    const { job } = s;
    if (s.invalidationFailed && s.ok === 0) {
      // Could not record the invalid tokens: do not finish the job on partial knowledge unless
      // it was delivered somewhere. Leave it in `sending` for reclaim.
      return;
    }
    if (s.ok > 0) {
      await complete(job, 'sent', null, null);
    } else if (s.transient.length > 0) {
      const waits = s.transient.map((t) => t.retryAfter).filter((v): v is number => v !== null);
      const codes = [...new Set(s.transient.map((t) => t.code))].join(',');
      if (s.deferred) summary.deferred++;
      await complete(job, 'failed', `transient:${codes}`, waits.length > 0 ? Math.max(...waits) : null);
    } else if (s.permanent.length > 0) {
      const codes = [...new Set(s.permanent)].join(',');
      log('job_dead', { jobId: job.job_id, codes });
      await complete(job, 'dead', `permanent:${codes}`, null);
    } else {
      await complete(job, 'skipped', 'no_valid_tokens', null);
    }
  };

  /** Sends messages; on a whole-request rejection splits them in halves (bounded). */
  const deliver = async (messages: ExpoMessage[]): Promise<{ outcomes: Outcome[]; transient: boolean }> => {
    if (summary.expoRequests >= maxRequests || elapsed() >= hardDeadlineMs) {
      return {
        outcomes: messages.map(() => ({ type: 'transient', code: 'Deferred', retryAfter: 0 }) as Outcome),
        transient: false,
      };
    }
    summary.expoRequests++;
    const answer = await sendChunk(messages, opts, now());
    if (answer.kind === 'outcomes') {
      const counts: Record<string, number> = {};
      for (const o of answer.outcomes) {
        const key = o.type === 'ok' || o.type === 'not_registered' ? o.type : o.code;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      log('expo_chunk', { messages: messages.length, transport: answer.transport, ...counts });
      return { outcomes: answer.outcomes, transient: answer.outcomes.some((o) => o.type === 'transient') };
    }
    log('expo_chunk', { messages: messages.length, transport: answer.transport, rejected: answer.code });
    if (messages.length === 1) {
      return {
        outcomes: [{ type: 'rejected', code: `HTTP_${answer.status}`, reason: answer.code }],
        transient: false,
      };
    }
    summary.bisections++;
    const mid = Math.ceil(messages.length / 2);
    const left = await deliver(messages.slice(0, mid));
    const right = await deliver(messages.slice(mid));
    return { outcomes: [...left.outcomes, ...right.outcomes], transient: left.transient || right.transient };
  };

  /** Processes one claimed batch; returns whether Expo or the network showed transient trouble. */
  const processBatch = async (jobs: ClaimedJob[]): Promise<boolean> => {
    const states: JobState[] = [];
    for (const job of jobs) {
      const tokens = Array.isArray(job.tokens) ? job.tokens : [];
      if (job.skip_reason || !job.push_allowed || tokens.length === 0) {
        await complete(job, 'skipped', job.skip_reason ?? (job.push_allowed ? 'no_tokens' : 'push_not_allowed'), null);
      } else {
        states.push({
          job,
          pending: tokens.length,
          ok: 0,
          notRegistered: [],
          transient: [],
          permanent: [],
          invalidationFailed: false,
          deferred: false,
        });
      }
    }

    // Requests of at most 100 messages; a job is never split across requests unless it alone
    // has more than 100 tokens (cannot happen with the 10-token cap, handled anyway).
    const nowMs = now();
    const chunks: Entry[][] = [];
    let current: Entry[] = [];
    for (const state of states) {
      const entries = state.job.tokens.map((token) => ({ state, token, message: buildMessage(state.job, token, nowMs) }));
      if (current.length > 0 && current.length + entries.length > MAX_MESSAGES_PER_REQUEST) {
        chunks.push(current);
        current = [];
      }
      for (const entry of entries) {
        if (current.length === MAX_MESSAGES_PER_REQUEST) {
          chunks.push(current);
          current = [];
        }
        current.push(entry);
      }
    }
    if (current.length > 0) chunks.push(current);

    let troubled = false;
    for (const chunk of chunks) {
      const { outcomes, transient } = await deliver(chunk.map((e) => e.message));
      troubled ||= transient;

      const notRegistered: Entry[] = [];
      const rejected: Entry[] = [];
      chunk.forEach((entry, k) => {
        const outcome = outcomes[k];
        const s = entry.state;
        s.pending--;
        if (outcome.type === 'ok') {
          s.ok++;
          summary.messagesOk++;
        } else if (outcome.type === 'not_registered') {
          s.notRegistered.push(entry.token);
          notRegistered.push(entry);
        } else if (outcome.type === 'transient') {
          if (outcome.code === 'Deferred') s.deferred = true;
          s.transient.push({ code: outcome.code, retryAfter: outcome.retryAfter });
        } else if (outcome.type === 'permanent') {
          s.permanent.push(outcome.code);
        } else {
          s.permanent.push(outcome.code);
          rejected.push(entry);
        }
      });

      // Invalidate dead tokens before completing, so even if completion fails they are never
      // claimed again.
      if (!(await invalidate([...new Set(notRegistered.map((e) => e.token))], 'DeviceNotRegistered'))) {
        for (const e of notRegistered) e.state.invalidationFailed = true;
      }
      // A message that Expo rejects on its own is invalidated only when the same request also
      // got accepted messages (so the payload format is fine) and the code is about the token.
      // Otherwise a payload bug could invalidate every token.
      if (outcomes.some((o) => o.type === 'ok')) {
        const byReason = new Map<string, string[]>();
        for (const e of rejected) {
          const outcome = outcomes[chunk.indexOf(e)];
          if (outcome.type !== 'rejected' || NON_TOKEN_REQUEST_CODES.has(outcome.reason)) continue;
          byReason.set(outcome.reason, [...(byReason.get(outcome.reason) ?? []), e.token]);
        }
        for (const [reason, tokens] of byReason) {
          log('tokens_rejected', { tokens: tokens.length, reason });
          await invalidate([...new Set(tokens)], reason);
        }
      }

      // Progressive completion: every job whose messages are all answered is completed now.
      const done = new Set<JobState>();
      for (const entry of chunk) if (entry.state.pending === 0) done.add(entry.state);
      for (const s of done) await finish(s);
    }
    return troubled;
  };

  const seen = new Set<string>();
  for (;;) {
    if (elapsed() >= timeBudgetMs) break;
    const jobs = await opts.rpc.claimJobs(batchSize, opts.worker);
    if (jobs.length === 0) break;
    summary.batches++;
    summary.claimed += jobs.length;
    // A job handed back with an immediate retry can come back in the same run: process it (it
    // is claimed now) but stop afterwards instead of spinning on it.
    const repeated = jobs.some((j) => seen.has(j.job_id));
    for (const j of jobs) seen.add(j.job_id);
    const troubled = await processBatch(jobs);
    // Stop on Expo/network trouble (let backoff work), on a short batch (queue drained), on the
    // request cap, or on a repeated job.
    if (troubled || repeated || jobs.length < batchSize || summary.expoRequests >= maxRequests) break;
  }

  log('dispatch_done', { ...summary });
  return summary;
}
