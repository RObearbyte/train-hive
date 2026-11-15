/**
 * TrainHive M3-B2: delivers queued notification jobs through the Expo Push Service.
 *
 * Pure module: no Deno globals, no I/O of its own. `fetch`, the RPC client, the clock and the
 * logger are injected so the same code runs in the Edge Function (index.ts) and in the Vitest
 * integration tests (fake Expo server + the real Postgres RPCs).
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
  limit?: number;
  /** Expo access token (only when "enhanced push security" is enabled for the project). */
  accessToken?: string;
  timeoutMs?: number;
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
  data: { deepLink: string; notificationId: string; kind: string };
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
    data: { deepLink: job.deep_link, notificationId: job.notification_id, kind: job.kind },
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
  | { type: 'permanent'; code: string };

const PERMANENT_CODES = new Set([
  'MessageTooBig',
  'InvalidCredentials',
  'InvalidPayload',
  'MismatchSenderId',
]);

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

/** Sends one chunk; returns one outcome per message, in order. Never throws. */
async function sendChunk(
  messages: ExpoMessage[],
  opts: DispatchOptions,
  nowMs: number,
): Promise<{ outcomes: Outcome[]; transport: string }> {
  const all = (outcome: Outcome) => messages.map(() => outcome);
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
      return { outcomes: all({ type: 'transient', code: `HTTP_${res.status}`, retryAfter }), transport: `http_${res.status}` };
    }
    if (res.status === 401 || res.status === 403) {
      // Credentials/config problem on our side (bad or missing EXPO_ACCESS_TOKEN). Retry with
      // backoff so fixing the secret recovers the queue; max_attempts bounds it.
      return { outcomes: all({ type: 'transient', code: `HTTP_${res.status}`, retryAfter: null }), transport: `http_${res.status}` };
    }
    if (res.status < 200 || res.status >= 300) {
      // 400 and other 4xx: the payload is malformed; retrying cannot help.
      return { outcomes: all({ type: 'permanent', code: `HTTP_${res.status}` }), transport: `http_${res.status}` };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { outcomes: all({ type: 'transient', code: 'BadResponse', retryAfter: null }), transport: 'bad_json' };
    }
    const data = (json as { data?: unknown } | null)?.data;
    if (!Array.isArray(data) || data.length !== messages.length) {
      return { outcomes: all({ type: 'transient', code: 'BadResponse', retryAfter: null }), transport: 'bad_shape' };
    }
    return { outcomes: data.map(ticketOutcome), transport: 'ok' };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      outcomes: all({ type: 'transient', code: aborted ? 'Timeout' : 'NetworkError', retryAfter: null }),
      transport: aborted ? 'timeout' : 'network_error',
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---- The run -----------------------------------------------------------------------------

const defaultLog: Logger = (event, fields) => {
  console.log(JSON.stringify({ event, ...fields }));
};

export async function dispatchNotifications(opts: DispatchOptions): Promise<DispatchSummary> {
  const log = opts.log ?? defaultLog;
  const now = opts.now ?? Date.now;
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
  };

  const jobs = await opts.rpc.claimJobs(opts.limit ?? 100, opts.worker);
  summary.claimed = jobs.length;

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

  // Jobs with nothing to send never touch Expo.
  const sendable: ClaimedJob[] = [];
  for (const job of jobs) {
    const tokens = Array.isArray(job.tokens) ? job.tokens : [];
    if (job.skip_reason || !job.push_allowed || tokens.length === 0) {
      await complete(job, 'skipped', job.skip_reason ?? (job.push_allowed ? 'no_tokens' : 'push_not_allowed'), null);
    } else {
      sendable.push(job);
    }
  }

  // One message per (job, token), chunked at 100 across jobs.
  const nowMs = now();
  const queue = sendable.flatMap((job, jobIndex) =>
    job.tokens.map((token) => ({ jobIndex, token, message: buildMessage(job, token, nowMs) })),
  );
  const results = sendable.map(() => ({
    ok: 0,
    notRegistered: [] as string[],
    transient: [] as { code: string; retryAfter: number | null }[],
    permanent: [] as string[],
  }));

  for (let i = 0; i < queue.length; i += MAX_MESSAGES_PER_REQUEST) {
    const chunk = queue.slice(i, i + MAX_MESSAGES_PER_REQUEST);
    summary.expoRequests++;
    const { outcomes, transport } = await sendChunk(
      chunk.map((entry) => entry.message),
      opts,
      now(),
    );
    const counts: Record<string, number> = {};
    chunk.forEach((entry, k) => {
      const outcome = outcomes[k];
      const r = results[entry.jobIndex];
      const key = outcome.type === 'ok' || outcome.type === 'not_registered' ? outcome.type : outcome.code;
      counts[key] = (counts[key] ?? 0) + 1;
      if (outcome.type === 'ok') {
        r.ok++;
        summary.messagesOk++;
      } else if (outcome.type === 'not_registered') {
        r.notRegistered.push(entry.token);
      } else if (outcome.type === 'transient') {
        r.transient.push({ code: outcome.code, retryAfter: outcome.retryAfter });
      } else {
        r.permanent.push(outcome.code);
      }
    });
    log('expo_chunk', { messages: chunk.length, transport, ...counts });
  }

  // Invalidate dead tokens first, so even if completion fails they are never claimed again.
  const dead = [...new Set(results.flatMap((r) => r.notRegistered))];
  let invalidated = false;
  if (dead.length > 0) {
    try {
      const n = await opts.rpc.invalidateTokens(dead, 'DeviceNotRegistered');
      if (typeof n === 'number') summary.tokensInvalidated += n;
      invalidated = true;
    } catch (e) {
      summary.completionErrors++;
      log('invalidate_failed', { tokens: dead.length, error: e instanceof Error ? e.name : 'unknown' });
    }
  }

  for (let k = 0; k < sendable.length; k++) {
    const job = sendable[k];
    const r = results[k];
    if (r.notRegistered.length > 0 && !invalidated) {
      // Could not record the invalid tokens: do not finish the job on partial knowledge unless
      // it was delivered somewhere. Leave non-delivered ones in `sending` for reclaim.
      if (r.ok === 0) continue;
    }
    if (r.ok > 0) {
      await complete(job, 'sent', null, null);
    } else if (r.transient.length > 0) {
      const waits = r.transient.map((t) => t.retryAfter).filter((v): v is number => v !== null);
      const codes = [...new Set(r.transient.map((t) => t.code))].join(',');
      await complete(job, 'failed', `transient:${codes}`, waits.length > 0 ? Math.max(...waits) : null);
    } else if (r.permanent.length > 0) {
      const codes = [...new Set(r.permanent)].join(',');
      log('job_dead', { jobId: job.job_id, codes });
      await complete(job, 'dead', `permanent:${codes}`, null);
    } else {
      await complete(job, 'skipped', 'no_valid_tokens', null);
    }
  }

  log('dispatch_done', { ...summary });
  return summary;
}
