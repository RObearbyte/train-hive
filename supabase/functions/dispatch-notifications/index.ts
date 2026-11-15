/**
 * Edge Function: drains the push outbox through the Expo Push Service (M3-B2).
 *
 * Invoked every minute by pg_cron/pg_net (migration 20261115000600) with the shared secret in
 * the `x-dispatch-secret` header. It runs with the service-role key, so the secret check is
 * the only gate: deploy with `--no-verify-jwt` (the caller is the database, not a user, and
 * the service key is never accepted from the request). Thin handler: all logic is in dispatch.ts.
 *
 * Secrets (supabase secrets set): DISPATCH_SECRET, EXPO_ACCESS_TOKEN (optional).
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
import {
  dispatchNotifications,
  isAuthorized,
  type ClaimedJob,
  type CompleteStatus,
  type DispatchRpc,
} from './dispatch.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!isAuthorized(req.headers.get('x-dispatch-secret'), Deno.env.get('DISPATCH_SECRET'))) {
    return json({ error: 'unauthorized' }, 401);
  }

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return json({ error: 'server_misconfigured' }, 500);

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const rpc: DispatchRpc = {
    async claimJobs(limit: number, worker: string): Promise<ClaimedJob[]> {
      const { data, error } = await supabase.rpc('claim_notification_jobs', { p_limit: limit, p_worker: worker });
      if (error) throw new Error(`claim_notification_jobs: ${error.message}`);
      return (data ?? []) as ClaimedJob[];
    },
    async completeJob(jobId: string, status: CompleteStatus, error: string | null, retryInSeconds: number | null) {
      const { data, error: e } = await supabase.rpc('complete_notification_job', {
        p_job_id: jobId,
        p_status: status,
        p_error: error,
        p_retry_in_seconds: retryInSeconds,
      });
      if (e) throw new Error(`complete_notification_job: ${e.message}`);
      return data;
    },
    async invalidateTokens(tokens: string[], error: string) {
      const { data, error: e } = await supabase.rpc('invalidate_push_tokens', { p_tokens: tokens, p_error: error });
      if (e) throw new Error(`invalidate_push_tokens: ${e.message}`);
      return data;
    },
  };

  try {
    const summary = await dispatchNotifications({
      rpc,
      fetch: (u, init) => fetch(u, init),
      worker: `dispatch-${crypto.randomUUID()}`,
      limit: 100,
      accessToken: Deno.env.get('EXPO_ACCESS_TOKEN') || undefined,
    });
    return json(summary, 200);
  } catch (e) {
    console.error(JSON.stringify({ event: 'dispatch_failed', error: e instanceof Error ? e.message : 'unknown' }));
    return json({ error: 'dispatch_failed' }, 500);
  }
});
