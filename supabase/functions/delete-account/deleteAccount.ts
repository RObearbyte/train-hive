/**
 * Account-deletion FALLBACK (GDPR G2). Deploy only if `delete_my_account` fails on the hosted
 * project because the `delete from auth.users` inside it is refused (docs/ACCOUNT_DELETION_FALLBACK.md).
 * The app is NOT wired to it.
 *
 * Flow for one request:
 *   1. The caller is the user of the `Authorization: Bearer <access token>` header, verified by
 *      Supabase Auth (`verifyUser`). The user id comes ONLY from the verified token; the request
 *      body is never read.
 *   2. `my_deletion_blockers` called WITH the caller's token: the same rules as in the app
 *      (last organizer of a community with other active members -> 409 last_organizer).
 *   3. `admin_erase_user_data(user id)` with the service role: the delete_my_account erasure
 *      (same locks; re-checks last_organizer under them), keeping the auth.users row.
 *   4. `auth.admin.deleteUser(user id)`: removes the auth user; its cascade removes the consent
 *      ledger, sessions, identities.
 * A failure in step 4 leaves the data erased and the (now empty) auth user in place; calling the
 * function again with the same token repeats steps 2-4 harmlessly.
 *
 * Pure module: no Deno globals and no I/O of its own; index.ts injects the Supabase clients.
 * Nothing here logs a token or personal data: only error codes.
 */

export interface DeletionBlocker {
  community_id: string;
  name: string;
  active_members: number;
}

export interface DeletionBlockers {
  can_delete: boolean;
  last_organizer: DeletionBlocker[];
}

/** An error from a Postgres RPC: `message` is the backend error code (P0001), `details` its DETAIL. */
export interface RpcError {
  message: string;
  details?: string | null;
}

export class RpcFailure extends Error {
  readonly details: string | null;
  constructor(error: RpcError) {
    super(error.message);
    this.name = 'RpcFailure';
    this.details = error.details ?? null;
  }
}

export interface DeleteAccountDeps {
  /** The user id of a valid access token, or null when Auth rejects the token. */
  verifyUser(accessToken: string): Promise<string | null>;
  /** `my_deletion_blockers()` called with the caller's access token. Throws RpcFailure. */
  deletionBlockers(accessToken: string): Promise<DeletionBlockers>;
  /** `admin_erase_user_data(p_user_id)` with the service role. Throws RpcFailure. */
  eraseUserData(userId: string): Promise<Record<string, unknown>>;
  /** `auth.admin.deleteUser(userId)` with the service role. Throws on failure. */
  deleteAuthUser(userId: string): Promise<void>;
  /** Error codes only, never tokens or personal data. */
  log?(event: Record<string, unknown>): void;
}

export interface DeleteAccountResponse {
  status: number;
  body: Record<string, unknown>;
}

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match ? match[1] : null;
}

function blockedDetail(details: string | null): { communities: DeletionBlocker[] } {
  if (details) {
    try {
      const parsed = JSON.parse(details) as { communities?: unknown };
      if (Array.isArray(parsed.communities)) return { communities: parsed.communities as DeletionBlocker[] };
    } catch {
      // A DETAIL that is not the documented JSON: answer with an empty list rather than fail.
    }
  }
  return { communities: [] };
}

function rpcCode(error: unknown): string | null {
  return error instanceof RpcFailure ? error.message : null;
}

/**
 * Handles one request. Only the method and the Authorization header are read: the user to
 * delete is never taken from the body, the query string or any other header.
 */
export async function handleDeleteAccount(req: Request, deps: DeleteAccountDeps): Promise<DeleteAccountResponse> {
  const log = deps.log ?? (() => {});
  if (req.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };

  const token = bearerToken(req.headers.get('authorization'));
  if (!token) return { status: 401, body: { error: 'not_authenticated' } };

  let userId: string | null;
  try {
    userId = await deps.verifyUser(token);
  } catch {
    log({ event: 'delete_account_verify_failed' });
    return { status: 503, body: { error: 'auth_unavailable' } };
  }
  if (!userId) return { status: 401, body: { error: 'not_authenticated' } };

  let blockers: DeletionBlockers;
  try {
    blockers = await deps.deletionBlockers(token);
  } catch (error) {
    if (rpcCode(error) === 'not_authenticated') return { status: 401, body: { error: 'not_authenticated' } };
    log({ event: 'delete_account_blockers_failed', code: rpcCode(error) ?? 'unknown' });
    return { status: 500, body: { error: 'deletion_failed' } };
  }
  if (!blockers.can_delete) {
    return { status: 409, body: { error: 'last_organizer', details: { communities: blockers.last_organizer } } };
  }

  let summary: Record<string, unknown>;
  try {
    summary = await deps.eraseUserData(userId);
  } catch (error) {
    const code = rpcCode(error);
    if (code === 'last_organizer' && error instanceof RpcFailure) {
      // Became the last organizer between the check and the erasure's locks.
      return { status: 409, body: { error: 'last_organizer', details: blockedDetail(error.details) } };
    }
    if (code === 'not_found') return { status: 401, body: { error: 'not_authenticated' } };
    log({ event: 'delete_account_erase_failed', code: code ?? 'unknown' });
    return { status: 500, body: { error: 'deletion_failed' } };
  }

  try {
    await deps.deleteAuthUser(userId);
  } catch {
    // The data is gone; only the auth user is left. A retry with the same token finishes it.
    log({ event: 'delete_account_auth_delete_failed' });
    return { status: 500, body: { error: 'auth_delete_failed', data_erased: true, retry: true } };
  }

  return { status: 200, body: { ok: true, ...summary } };
}
