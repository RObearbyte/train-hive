import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { admin, asRole, asService, asUser, rpc, rpcRow } from './helpers';

/** Helpers for the creator-code tests (C1). */

export type CreatorResult = {
  ok: boolean;
  error?: string;
  community_id?: string;
  membership_id?: string;
  already_created?: boolean;
};

export type IssuedCode = { code: string; expires_at: string; max_uses: number };

export type CommunityRow = { id: string; name: string; timezone: string; created_at: Date };

export type MyCommunity = {
  community_id: string;
  membership_id: string;
  name: string;
  timezone: string;
  role: 'organizer' | 'member';
  joined_at: string;
};

/** Issues a creator code through the real service-role RPC. */
export function issueCode(
  options: { note?: string | null; days?: number; maxUses?: number } = {},
): Promise<IssuedCode> {
  const { note = null, days = 14, maxUses = 1 } = options;
  return asService((db) => rpc<IssuedCode>(db, 'admin_create_creator_code', [note, days, maxUses]));
}

export function previewCode(userId: string, code: string | null): Promise<CreatorResult> {
  return asUser(userId, (db) => rpc<CreatorResult>(db, 'preview_creator_code', [code]));
}

export interface CreateInput {
  name?: string | null;
  timezone?: string | null;
  displayName?: string | null;
  requestId?: string | null;
}

/** Calls create_community_with_code as `userId`; a fresh request id unless one is given. */
export function createWithCode(
  userId: string,
  code: string | null,
  input: CreateInput = {},
): Promise<CreatorResult> {
  return asUser(userId, (db) => createWithCodeOn(db, code, input));
}

export function createWithCodeOn(
  db: Pick<PoolClient, 'query'>,
  code: string | null,
  input: CreateInput = {},
): Promise<CreatorResult> {
  const {
    name = 'Trail Pack',
    timezone = 'Europe/Bucharest',
    displayName = 'Alex Creator',
    requestId = randomUUID(),
  } = input;
  return rpc<CreatorResult>(db, 'create_community_with_code', [code, name, timezone, displayName, requestId]);
}

export function updateCommunity(
  userId: string,
  communityId: string | null,
  name: string | null,
  timezone: string | null,
): Promise<CommunityRow> {
  return asUser(userId, (db) => rpcRow<CommunityRow>(db, 'update_community', [communityId, name, timezone]));
}

export function listMyCommunities(userId: string): Promise<MyCommunity[]> {
  return asUser(userId, (db) => rpc<MyCommunity[]>(db, 'list_my_communities'));
}

/** An authenticated request without a user id in the JWT. */
export function asNobody<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  return asRole('authenticated', { role: 'authenticated' }, fn);
}

export async function codeRow(code: string): Promise<{
  id: string;
  use_count: number;
  max_uses: number;
  revoked_at: Date | null;
  expires_at: Date;
  note: string | null;
  created_by: string | null;
}> {
  const { rows } = await admin.query('select * from public.community_creator_codes where code = $1', [code]);
  return rows[0];
}

export async function failedAttempts(userId: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    'select count(*)::int as n from public.invitation_attempts where user_id = $1 and not success',
    [userId],
  );
  return rows[0].n;
}

/**
 * Opens a transaction as `userId` on its own connection and leaves it open, so a test can hold
 * the locks it takes while another request runs. `finish` commits or rolls back and releases.
 */
export async function openUserTransaction(userId: string): Promise<{
  db: PoolClient;
  finish: (commit: boolean) => Promise<void>;
}> {
  const client = await admin.connect();
  await client.query('begin');
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ]);
  await client.query('set local role authenticated');
  return {
    db: client,
    finish: async (commit) => {
      try {
        await client.query(commit ? 'commit' : 'rollback');
      } finally {
        client.release();
      }
    },
  };
}

/** Resolves once at least `count` backends are waiting on a heavyweight lock (max 15 s). */
export async function waitForLockWaiters(count = 1): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const { rows } = await admin.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and state = 'active'",
    );
    if (rows[0].n >= count) return;
    if (Date.now() > deadline) throw new Error(`no backend waited on a lock (wanted ${count})`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Re-creates a function with `search` replaced by `replacement` for the duration of `fn`. */
export async function withMutatedFunction<T>(
  signature: string,
  search: string,
  replacement: string,
  fn: () => Promise<T>,
): Promise<T> {
  const { rows } = await admin.query<{ def: string }>('select pg_get_functiondef($1::regprocedure) as def', [
    signature,
  ]);
  const original = rows[0].def;
  if (!original.includes(search)) throw new Error(`${signature} no longer contains: ${search}`);
  await admin.query(original.replaceAll(search, replacement));
  try {
    return await fn();
  } finally {
    await admin.query(original);
  }
}
