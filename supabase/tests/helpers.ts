import { Pool, type PoolClient } from 'pg';
import { inject } from 'vitest';

/**
 * Test helpers for the embedded Postgres started in `global-setup.ts`.
 *
 * `admin` is a superuser pool: use it to arrange fixtures, inspect tables and "time travel"
 * (e.g. move `expires_at` or `rsvp_deadline` into the past). Code under test must run through
 * `asUser` / `asAnon` / `asService`, which behave like a PostgREST request for that role.
 */

export const admin = new Pool({ connectionString: inject('databaseUrl'), max: 20 });

export type Db = Pick<PoolClient, 'query'>;
export type ApiRole = 'anon' | 'authenticated' | 'service_role';

/** SQLSTATE raised by Postgres when the role lacks a table / function / schema privilege. */
export const INSUFFICIENT_PRIVILEGE = '42501';
/** SQLSTATE used by the RPCs for business errors; the message carries the error code. */
export const RAISED = 'P0001';

/**
 * Runs `fn` on its own connection as `role`, with `request.jwt.claims` set the way Supabase
 * sets it. Statements autocommit (one transaction each, like one API request each), so a
 * statement that is denied does not poison the following ones. Each call uses an independent
 * connection: run several concurrently with `Promise.all` for concurrency tests.
 */
export async function asRole<T>(
  role: ApiRole,
  claims: Record<string, unknown> | null,
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await admin.connect();
  let broken = false;
  try {
    await client.query("select set_config('request.jwt.claims', $1, false)", [
      claims === null ? '' : JSON.stringify(claims),
    ]);
    await client.query(`set role ${role}`);
    return await fn(client);
  } finally {
    try {
      // Ends a transaction the test may have left open, then restores the superuser session.
      await client.query('rollback');
      await client.query('reset role');
      await client.query("select set_config('request.jwt.claims', '', false)");
    } catch {
      // The connection is unusable; destroy it instead of returning it to the pool.
      broken = true;
    }
    client.release(broken);
  }
}

/** A signed-in user (anonymous sign-in users also have the `authenticated` role). */
export function asUser<T>(userId: string, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  return asRole('authenticated', { sub: userId, role: 'authenticated' }, fn);
}

/** A request with the anon key and no user session. */
export function asAnon<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  return asRole('anon', { role: 'anon' }, fn);
}

/** A request with the service-role key. */
export function asService<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  return asRole('service_role', { role: 'service_role' }, fn);
}

/** Inserts an auth user (as Supabase anonymous sign-in would) and returns its id. */
export async function createUser(): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    'insert into auth.users (is_anonymous) values (true) returning id',
  );
  return rows[0].id;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, (_, i) => `$${i + 1}`).join(', ');
}

/** Calls a function that returns a scalar / jsonb and returns that value. */
export async function rpc<T = Record<string, unknown>>(
  db: Db,
  name: string,
  args: unknown[] = [],
): Promise<T> {
  const { rows } = await db.query(
    `select public.${name}(${placeholders(args.length)}) as result`,
    args,
  );
  return rows[0].result as T;
}

/** Calls a function that returns a table row type and returns the row. */
export async function rpcRow<T = Record<string, unknown>>(
  db: Db,
  name: string,
  args: unknown[] = [],
): Promise<T> {
  const { rows } = await db.query(
    `select * from public.${name}(${placeholders(args.length)})`,
    args,
  );
  return rows[0] as T;
}

/** Tables that hold seeded reference data and must survive `resetData()`. */
const REFERENCE_TABLES = ['activity_types'];

/** Empties every app table in `public` (except reference data) and `auth.users`. */
export async function resetData(): Promise<void> {
  const { rows } = await admin.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' and tablename <> all($1::text[])",
    [REFERENCE_TABLES],
  );
  const tables = rows.map((row) => `public."${row.tablename}"`);
  await admin.query(`truncate table ${['auth.users', ...tables].join(', ')} cascade`);
}

/** Closes the pool; call from `afterAll` in every test file that imports these helpers. */
export async function closeDb(): Promise<void> {
  await admin.end();
}

// Fixtures ------------------------------------------------------------------------------------

export interface CommunityFixture {
  communityId: string;
  /** The single-use organizer invitation code returned by admin_create_community. */
  organizerCode: string;
}

/** Creates a community through the real bootstrap RPC, as service_role. */
export async function createCommunity(
  name = 'Test Pack',
  timezone = 'Europe/Bucharest',
): Promise<CommunityFixture> {
  const result = await asService((db) =>
    rpc<{ community_id: string; organizer_code: string }>(db, 'admin_create_community', [
      name,
      timezone,
    ]),
  );
  return { communityId: result.community_id, organizerCode: result.organizer_code };
}

/**
 * Arranges a user with a profile and a membership directly (superuser), bypassing the
 * invitation flow. Returns the user id.
 */
export async function addMember(
  communityId: string,
  options: { role?: 'organizer' | 'member'; status?: 'active' | 'removed'; name?: string } = {},
): Promise<string> {
  const { role = 'member', status = 'active', name = 'Test Runner' } = options;
  const userId = await createUser();
  await admin.query('insert into public.profiles (id, display_name) values ($1, $2)', [
    userId,
    name,
  ]);
  await admin.query(
    'insert into public.memberships (community_id, user_id, role, status) values ($1, $2, $3, $4)',
    [communityId, userId, role, status],
  );
  return userId;
}

export interface InvitationFixture {
  id: string;
  code: string;
}

/** Arranges an invitation row directly (superuser), with a caller-chosen code. */
export async function insertInvitation(
  communityId: string,
  code: string,
  options: {
    role?: 'organizer' | 'member';
    expiresAt?: string | null;
    maxRedemptions?: number | null;
    revoked?: boolean;
  } = {},
): Promise<InvitationFixture> {
  const { role = 'member', expiresAt = null, maxRedemptions = null, revoked = false } = options;
  const { rows } = await admin.query<InvitationFixture>(
    `insert into public.invitation_codes (community_id, code, role, expires_at, max_redemptions, revoked_at)
     values ($1, $2, $3, $4, $5, case when $6::boolean then now() end)
     returning id, code`,
    [communityId, code, role, expiresAt, maxRedemptions, revoked],
  );
  return rows[0];
}

/** Number of rows in a public table, as superuser. */
export async function countRows(table: string, where = 'true', params: unknown[] = []): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    `select count(*)::int as n from public.${table} where ${where}`,
    params,
  );
  return rows[0].n;
}
