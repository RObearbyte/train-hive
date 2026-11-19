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

/** The consents every join requires (GDPR G1): Terms + Privacy acknowledgement and the 16+ confirmation. */
export const JOIN_CONSENTS = ['terms_privacy', 'age_16'] as const;

/**
 * Inserts an auth user (as Supabase anonymous sign-in would) and returns its id.
 *
 * By default the user has also completed the first-launch screen: the ledger holds a current
 * `terms_privacy` and `age_16` grant (inserted directly, as superuser), so the onboarding RPCs
 * behave as they did before the G1 join gate. Pass `{ consent: false }` for a user who has not
 * accepted anything (the gate tests in consent*.test.ts).
 */
export async function createUser(options: { consent?: boolean } = {}): Promise<string> {
  const { consent = true } = options;
  const { rows } = await admin.query<{ id: string }>(
    `with u as (insert into auth.users (is_anonymous) values (true) returning id),
          c as (
            insert into public.consent_records (user_id, purpose, document_version, granted)
            select u.id, p.purpose,
                   case when p.purpose = 'terms_privacy' then private.terms_privacy_version()
                        else private.privacy_version() end,
                   true
            from u, unnest($1::text[]) as p(purpose)
          )
     select id from u`,
    [consent ? [...JOIN_CONSENTS] : []],
  );
  return rows[0].id;
}

/**
 * Fixture: records a current grant of each purpose the user does not hold yet (superuser insert,
 * same shape as `record_consent`). Does nothing for a user that no longer exists. The RPC itself
 * is covered by consent*.test.ts.
 */
export async function grantConsents(userId: string, purposes: readonly string[]): Promise<void> {
  await admin.query(
    `insert into public.consent_records (user_id, purpose, document_version, granted)
     select $1, p.purpose,
            case when p.purpose = 'terms_privacy' then private.terms_privacy_version()
                 else private.privacy_version() end,
            true
     from unnest($2::text[]) as p(purpose)
     where exists (select 1 from auth.users u where u.id = $1)
       and not private.has_consent($1, p.purpose)`,
    [userId, purposes],
  );
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
const REFERENCE_TABLES = ['activity_types', 'legal_documents'];

/**
 * Empties every app table in `public` (except reference data) and `auth.users`, and puts the
 * legal document versions back to the seeded '1'.
 */
export async function resetData(): Promise<void> {
  const { rows } = await admin.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' and tablename <> all($1::text[])",
    [REFERENCE_TABLES],
  );
  const tables = rows.map((row) => `public."${row.tablename}"`);
  await admin.query(`truncate table ${['auth.users', ...tables].join(', ')} cascade`);
  await admin.query(
    "update public.legal_documents set version = '1' where version <> '1'",
  );
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
export async function bootstrapCommunity(
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
 * Arranges a community and its single-use organizer invitation directly (superuser), in the
 * state admin_create_community leaves behind. Used for fixtures because the RPC validates the
 * time zone against pg_timezone_names, which takes ~250 ms per call on Windows; the RPC itself
 * is covered through `bootstrapCommunity` and the admin_create_community tests.
 */
export async function createCommunity(
  name = 'Test Pack',
  timezone = 'Europe/Bucharest',
): Promise<CommunityFixture> {
  const { rows } = await admin.query<{ community_id: string; code: string }>(
    `with community as (
       insert into public.communities (name, timezone) values ($1, $2) returning id
     )
     insert into public.invitation_codes (community_id, code, role, max_redemptions, expires_at)
     select id, private.generate_invitation_code(), 'organizer', 1, now() + interval '7 days'
     from community
     returning community_id, code`,
    [name, timezone],
  );
  return { communityId: rows[0].community_id, organizerCode: rows[0].code };
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

// Trainings -----------------------------------------------------------------------------------

export interface Session {
  id: string;
  community_id: string;
  organizer_id: string | null;
  title: string;
  description: string | null;
  activity_type: string;
  starts_at: Date;
  ends_at: Date | null;
  rsvp_deadline: Date;
  timezone: string;
  location_name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  map_url: string | null;
  meeting_instructions: string | null;
  min_participants: number;
  max_participants: number | null;
  going_count: number;
  status: 'scheduled' | 'confirmed' | 'cancelled' | 'completed';
  cancel_reason: 'insufficient_participation' | 'organizer' | null;
  decided_at: Date | null;
  cancelled_at: Date | null;
  cancelled_by: string | null;
  attendance_finalized_at: Date | null;
  attendance_finalized_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export type RsvpResponse = 'going' | 'not_going' | 'no_response';
export type RsvpResult = { response: RsvpResponse; going_count: number; status: Session['status'] };

const HOUR = 3_600_000;

/** An ISO instant `hours` from now, truncated to whole seconds. */
export function hoursFromNow(hours: number): string {
  return new Date(Math.floor((Date.now() + hours * HOUR) / 1000) * 1000).toISOString();
}

/**
 * A complete, valid `p_input` for create_training / update_training: starts in 3 days,
 * RSVP deadline 2 days from now, minimum 2 participants, no maximum.
 */
export function trainingInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Morning run',
    description: 'Easy pace, everyone welcome.',
    activity_type: 'running',
    starts_at: hoursFromNow(72),
    ends_at: hoursFromNow(74),
    rsvp_deadline: hoursFromNow(48),
    timezone: 'Europe/Bucharest',
    location_name: 'Herastrau Park',
    address: 'Main gate',
    latitude: 44.4702,
    longitude: 26.0826,
    map_url: 'https://maps.example.com/?q=44.4702,26.0826',
    meeting_instructions: 'Meet at the fountain.',
    min_participants: 2,
    max_participants: null,
    ...overrides,
  };
}

/** Creates a training through the real RPC as `organizerId`. */
export function createTraining(
  organizerId: string,
  communityId: string,
  overrides: Record<string, unknown> = {},
): Promise<Session> {
  return asUser(organizerId, (db) =>
    rpcRow<Session>(db, 'create_training', [communityId, JSON.stringify(trainingInput(overrides))]),
  );
}

export function updateTraining(
  userId: string,
  sessionId: string,
  input: Record<string, unknown>,
): Promise<Session> {
  return asUser(userId, (db) =>
    rpcRow<Session>(db, 'update_training', [sessionId, JSON.stringify(input)]),
  );
}

export function cancelTraining(userId: string, sessionId: string): Promise<Session> {
  return asUser(userId, (db) => rpcRow<Session>(db, 'cancel_training', [sessionId]));
}

export function setRsvp(userId: string, sessionId: string, response: RsvpResponse): Promise<RsvpResult> {
  return asUser(userId, (db) => rpc<RsvpResult>(db, 'set_rsvp', [sessionId, response]));
}

/** Runs the deadline finalizer as service_role; returns the number of sessions decided. */
export function finalize(): Promise<number> {
  return asService((db) => rpc<number>(db, 'finalize_due_sessions'));
}

/** The session row as stored, read as superuser. */
export async function getSession(sessionId: string): Promise<Session> {
  const { rows } = await admin.query<Session>('select * from public.training_sessions where id = $1', [
    sessionId,
  ]);
  return rows[0];
}

/** Time travel: moves the RSVP deadline of a session one second into the past. */
export async function makeDue(sessionId: string): Promise<void> {
  await admin.query(
    "update public.training_sessions set rsvp_deadline = now() - interval '1 second' where id = $1",
    [sessionId],
  );
}

/** The number of `going` RSVP rows of a session (what going_count must always equal). */
export function realGoingCount(sessionId: string): Promise<number> {
  return countRows('training_rsvps', "session_id = $1 and response = 'going'", [sessionId]);
}

/** A community with an organizer and `memberCount` members, arranged directly. */
export async function createPack(memberCount = 0): Promise<{
  communityId: string;
  organizerId: string;
  memberIds: string[];
}> {
  const { communityId } = await createCommunity();
  const organizerId = await addMember(communityId, { role: 'organizer', name: 'Olga Organizer' });
  const memberIds: string[] = [];
  for (let i = 0; i < memberCount; i += 1) {
    memberIds.push(await addMember(communityId, { name: `Member ${i + 1}` }));
  }
  return { communityId, organizerId, memberIds };
}
