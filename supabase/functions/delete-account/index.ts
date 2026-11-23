/**
 * Edge Function: account-deletion FALLBACK (GDPR G2). Deploy ONLY if `delete_my_account` is
 * refused on the hosted project (see docs/ACCOUNT_DELETION_FALLBACK.md). The app does not call it.
 *
 * Deploy WITH the platform's JWT check (the default; no `--no-verify-jwt`): the caller is a
 * signed-in user. The handler verifies the token again with Supabase Auth and takes the user id
 * from it, never from the request. Thin handler: all logic is in deleteAccount.ts.
 *
 * No secrets to set: SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided
 * by the platform to every Edge Function.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
import { handleDeleteAccount, RpcFailure, type DeleteAccountDeps, type DeletionBlockers } from './deleteAccount.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } } as const;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) return json({ error: 'server_misconfigured' }, 500);

  const anon = createClient(url, anonKey, NO_SESSION);
  const service = createClient(url, serviceKey, NO_SESSION);

  const deps: DeleteAccountDeps = {
    async verifyUser(accessToken) {
      const { data, error } = await anon.auth.getUser(accessToken);
      if (error) {
        // 4xx: the token is invalid, expired or its user is gone. Anything else: Auth is unreachable.
        if (typeof error.status === 'number' && error.status >= 400 && error.status < 500) return null;
        throw new Error('auth_unavailable');
      }
      return data.user?.id ?? null;
    },
    async deletionBlockers(accessToken) {
      // A client acting AS the caller: the RPC sees auth.uid() = the token's user.
      const asCaller = createClient(url, anonKey, {
        ...NO_SESSION,
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      });
      const { data, error } = await asCaller.rpc('my_deletion_blockers');
      if (error) throw new RpcFailure({ message: error.message, details: error.details });
      return data as DeletionBlockers;
    },
    async eraseUserData(userId) {
      const { data, error } = await service.rpc('admin_erase_user_data', { p_user_id: userId });
      if (error) throw new RpcFailure({ message: error.message, details: error.details });
      return data as Record<string, unknown>;
    },
    async deleteAuthUser(userId) {
      const { error } = await service.auth.admin.deleteUser(userId);
      if (error) throw new Error('auth_delete_failed');
    },
    log(event) {
      console.error(JSON.stringify(event));
    },
  };

  const { status, body } = await handleDeleteAccount(req, deps);
  return json(body, status);
});
