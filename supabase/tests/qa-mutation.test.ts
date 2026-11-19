import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  admin,
  asUser,
  cancelTraining,
  closeDb,
  createCommunity,
  createPack,
  createTraining,
  createUser,
  finalize,
  getSession,
  insertInvitation,
  makeDue,
  realGoingCount,
  resetData,
  rpc,
  rpcRow,
  setRsvp,
  trainingInput,
  updateTraining,
} from './helpers';
import { errorKey, formOf } from './qa-helpers';

/**
 * QA (M1-Q1): mutation checks. Each case breaks ONE rule in the live test database (by
 * re-creating a function without the rule, disabling a trigger or loosening a policy), runs a
 * probe that asserts the rule, and restores the original. The probe must hold on the pristine
 * schema and must notice the mutant. This proves the rule is really enforced where we think it
 * is, and that a regression there would be caught.
 */

type Probe = () => Promise<boolean>;

/** True when `op` rejects with exactly `expected` (`<SQLSTATE>:<message>`). */
async function rejectsWith(expected: string, op: () => Promise<unknown>): Promise<boolean> {
  try {
    await op();
    return false;
  } catch (error) {
    return errorKey(error) === expected;
  }
}

/** Re-creates a function with `search` replaced by `replacement` for the duration of `fn`. */
async function withMutatedFunction<T>(
  signature: string,
  search: string,
  replacement: string,
  fn: () => Promise<T>,
): Promise<T> {
  const { rows } = await admin.query<{ def: string }>(
    'select pg_get_functiondef($1::regprocedure) as def',
    [signature],
  );
  const original = rows[0].def;
  expect(original, `${signature} no longer contains: ${search}`).toContain(search);
  // Every occurrence: some rules are spelled out more than once in a function.
  await admin.query(original.replaceAll(search, replacement));
  try {
    return await fn();
  } finally {
    await admin.query(original);
  }
}

async function withSql<T>(breakSql: string, restoreSql: string, fn: () => Promise<T>): Promise<T> {
  await admin.query(breakSql);
  try {
    return await fn();
  } finally {
    await admin.query(restoreSql);
  }
}

// Probes: each returns true when the rule holds --------------------------------------------------

const lateRsvpIsRejected: Probe = async () => {
  const { communityId, organizerId, memberIds } = await createPack(1);
  const session = await createTraining(organizerId, communityId);
  await makeDue(session.id);
  return rejectsWith('P0001:rsvp_closed', () => setRsvp(memberIds[0], session.id, 'going'));
};

const rsvpOnDecidedSessionIsRejected: Probe = async () => {
  const { communityId, organizerId, memberIds } = await createPack(1);
  const session = await createTraining(organizerId, communityId);
  await cancelTraining(organizerId, session.id);
  return rejectsWith('P0001:rsvp_closed', () => setRsvp(memberIds[0], session.id, 'going'));
};

const fullSessionReportsSessionFull: Probe = async () => {
  const { communityId, organizerId, memberIds } = await createPack(2);
  const session = await createTraining(organizerId, communityId, { min_participants: 1, max_participants: 1 });
  await setRsvp(memberIds[0], session.id, 'going');
  return rejectsWith('P0001:session_full', () => setRsvp(memberIds[1], session.id, 'going'));
};

const nonMemberCannotRsvp: Probe = async () => {
  const { communityId, organizerId, memberIds } = await createPack(1);
  const session = await createTraining(organizerId, communityId);
  await admin.query("update public.memberships set status = 'removed' where user_id = $1", [memberIds[0]]);
  return rejectsWith('P0001:not_a_member', () => setRsvp(memberIds[0], session.id, 'going'));
};

const memberCannotCreateTraining: Probe = async () => {
  const { communityId, memberIds } = await createPack(1);
  return rejectsWith('P0001:forbidden', () =>
    asUser(memberIds[0], (db) => rpcRow(db, 'create_training', [communityId, JSON.stringify(trainingInput())])),
  );
};

// G2: create_training now re-checks the organizer role itself under its membership lock, so the
// is_organizer mutant is probed through a function that relies on is_organizer alone.
const memberCannotCreateInvitation: Probe = async () => {
  const { communityId, memberIds } = await createPack(1);
  return rejectsWith('P0001:forbidden', () =>
    asUser(memberIds[0], (db) => rpcRow(db, 'create_invitation', [communityId])),
  );
};

const underMinimumIsCancelled: Probe = async () => {
  const { communityId, organizerId, memberIds } = await createPack(1);
  const session = await createTraining(organizerId, communityId, { min_participants: 2 });
  await setRsvp(memberIds[0], session.id, 'going');
  await makeDue(session.id);
  await finalize();
  const row = await getSession(session.id);
  return row.status === 'cancelled' && row.cancel_reason === 'insufficient_participation';
};

const decisionDoesNotOscillate: Probe = async () => {
  const { communityId, organizerId, memberIds } = await createPack(1);
  const session = await createTraining(organizerId, communityId, { min_participants: 1 });
  await setRsvp(memberIds[0], session.id, 'going');
  await makeDue(session.id);
  await finalize();
  await cancelTraining(organizerId, session.id);
  await finalize();
  const row = await getSession(session.id);
  return row.status === 'cancelled' && row.cancel_reason === 'organizer';
};

const pendingDecisionCannotBeEscaped: Probe = async () => {
  const { communityId, organizerId, memberIds } = await createPack(1);
  const session = await createTraining(organizerId, communityId, { min_participants: 2 });
  await setRsvp(memberIds[0], session.id, 'going');
  await makeDue(session.id);
  const due = await getSession(session.id);
  return rejectsWith('P0001:validation_failed:min_participants', () =>
    updateTraining(organizerId, session.id, formOf(due, { min_participants: 1 })),
  );
};

const removedMemberStopsCounting: Probe = async () => {
  const { communityId, organizerId, memberIds } = await createPack(1);
  const session = await createTraining(organizerId, communityId, { min_participants: 1 });
  await setRsvp(memberIds[0], session.id, 'going');
  await admin.query("update public.memberships set status = 'removed' where user_id = $1", [memberIds[0]]);
  const row = await getSession(session.id);
  return row.going_count === 0 && (await realGoingCount(session.id)) === 0;
};

const outsiderSeesNoSessions: Probe = async () => {
  const { communityId, organizerId } = await createPack();
  await createTraining(organizerId, communityId);
  const outsider = await createUser();
  const { rows } = await asUser(outsider, (db) => db.query('select id from public.training_sessions'));
  return rows.length === 0;
};

const exhaustedCodeIsRefused: Probe = async () => {
  const { communityId } = await createCommunity();
  await insertInvitation(communityId, 'MEMBER22', { maxRedemptions: 1 });
  const [first, second] = [await createUser(), await createUser()];
  const redeem = (userId: string) =>
    asUser(userId, (db) => rpc<{ ok: boolean; error?: string }>(db, 'redeem_invitation', ['MEMBER22', 'Ana Runner']));
  await redeem(first);
  try {
    const result = await redeem(second);
    return result.ok === false && result.error === 'exhausted';
  } catch {
    return false;
  }
};

const sixthFailedAttemptIsRateLimited: Probe = async () => {
  await createCommunity();
  const userId = await createUser();
  const preview = () =>
    asUser(userId, (db) => rpc<{ ok: boolean; error?: string }>(db, 'preview_invitation', ['WRNG2222']));
  for (let i = 0; i < 5; i += 1) await preview();
  return (await preview()).error === 'rate_limited';
};

const memberCodeNeverGrantsOrganizer: Probe = async () => {
  const { communityId, organizerId } = await createPack();
  const invitation = await asUser(organizerId, (db) => rpcRow<{ code: string; role: string }>(db, 'create_invitation', [communityId]));
  const userId = await createUser();
  const result = await asUser(userId, (db) => rpc<{ role?: string }>(db, 'redeem_invitation', [invitation.code, 'Ana Runner']));
  return invitation.role === 'member' && result.role === 'member';
};

// Mutants ----------------------------------------------------------------------------------------

const SET_RSVP = 'public.set_rsvp(uuid, public.rsvp_response)';

const MUTANTS: [string, Probe, (probe: Probe) => Promise<boolean>][] = [
  [
    'set_rsvp without the deadline check',
    lateRsvpIsRejected,
    (probe) => withMutatedFunction(SET_RSVP, 'or clock_timestamp() >= v_session.rsvp_deadline', '', probe),
  ],
  [
    'set_rsvp without the status check',
    rsvpOnDecidedSessionIsRejected,
    (probe) => withMutatedFunction(SET_RSVP, "v_session.status <> 'scheduled' or", '', probe),
  ],
  [
    'set_rsvp without the capacity check',
    fullSessionReportsSessionFull,
    (probe) =>
      withMutatedFunction(SET_RSVP, 'and v_session.going_count >= v_session.max_participants', 'and false', probe),
  ],
  [
    'set_rsvp accepting removed members',
    nonMemberCannotRsvp,
    (probe) =>
      withMutatedFunction(SET_RSVP, "and m.status = 'active'", '', probe),
  ],
  [
    'create_training with neither role check (is_organizer and the membership lock)',
    memberCannotCreateTraining,
    (probe) =>
      withMutatedFunction('public.is_organizer(uuid)', "and m.role = 'organizer'", '', () =>
        withMutatedFunction(
          'public.create_training(uuid, jsonb)',
          "and m.role = 'organizer'\n  for no key update;",
          '\n  for no key update;',
          probe,
        ),
      ),
  ],
  [
    'is_organizer without the role check',
    memberCannotCreateInvitation,
    (probe) => withMutatedFunction('public.is_organizer(uuid)', "and m.role = 'organizer'", '', probe),
  ],
  [
    'finalizer that always confirms',
    underMinimumIsCancelled,
    (probe) =>
      withMutatedFunction('public.finalize_due_sessions()', 's.going_count >= s.min_participants', 'true', probe),
  ],
  [
    'finalizer that re-decides decided sessions',
    decisionDoesNotOscillate,
    (probe) =>
      withMutatedFunction('public.finalize_due_sessions()', "where s.status = 'scheduled'", "where s.status <> 'completed'", probe),
  ],
  [
    'update_training that treats a due session as open',
    pendingDecisionCannotBeEscaped,
    (probe) =>
      withMutatedFunction(
        'public.update_training(uuid, jsonb)',
        "v_open := v_session.status = 'scheduled' and clock_timestamp() < v_session.rsvp_deadline;",
        "v_open := v_session.status = 'scheduled';",
        probe,
      ),
  ],
  [
    'no release of RSVPs on member removal',
    removedMemberStopsCounting,
    (probe) =>
      withSql(
        'alter table public.memberships disable trigger memberships_release_rsvps_on_removal',
        'alter table public.memberships enable trigger memberships_release_rsvps_on_removal',
        probe,
      ),
  ],
  [
    'training_sessions policy open to everyone',
    outsiderSeesNoSessions,
    (probe) =>
      withSql(
        'alter policy training_sessions_select_active_members on public.training_sessions using (true)',
        'alter policy training_sessions_select_active_members on public.training_sessions using (public.is_active_member(community_id))',
        probe,
      ),
  ],
  [
    'training_sessions without row level security',
    outsiderSeesNoSessions,
    (probe) =>
      withSql(
        'alter table public.training_sessions disable row level security',
        'alter table public.training_sessions enable row level security',
        probe,
      ),
  ],
  [
    'check_invitation without the redemption limit',
    exhaustedCodeIsRefused,
    (probe) =>
      withMutatedFunction(
        'private.check_invitation(public.invitation_codes, uuid)',
        'and p_invitation.redemption_count >= p_invitation.max_redemptions',
        'and false',
        probe,
      ),
  ],
  [
    'rate limit raised to 5000 attempts',
    sixthFailedAttemptIsRateLimited,
    (probe) =>
      withMutatedFunction('private.invitation_rate_limited(uuid)', 'count(*) >= 5', 'count(*) >= 5000', probe),
  ],
  [
    'create_invitation minting organizer codes',
    memberCodeNeverGrantsOrganizer,
    (probe) =>
      withMutatedFunction(
        'public.create_invitation(uuid, timestamp with time zone, integer)',
        "private.insert_invitation(p_community_id, 'member',",
        "private.insert_invitation(p_community_id, 'organizer',",
        probe,
      ),
  ],
];

beforeEach(resetData);
afterAll(closeDb);

describe('QA mutation checks', () => {
  it.each(MUTANTS)('%s is noticed', async (_name, probe, mutate) => {
    expect(await probe(), 'the rule holds on the pristine schema').toBe(true);
    await resetData();
    expect(await mutate(probe), 'the probe notices the mutant').toBe(false);
    await resetData();
    expect(await probe(), 'the rule holds again after the mutant is reverted').toBe(true);
  });

  it('leaves the schema exactly as the migrations created it', async () => {
    const { rows } = await admin.query<{ n: number }>(
      `select count(*)::int as n from pg_trigger t
       join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and not t.tgisinternal and t.tgenabled <> 'O'`,
    );
    expect(rows[0].n).toBe(0);
    const { rows: tables } = await admin.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(tables).toEqual([]);
    const { rows: policy } = await admin.query<{ qual: string }>(
      "select qual from pg_policies where policyname = 'training_sessions_select_active_members'",
    );
    expect(policy[0].qual).toContain('is_active_member');
  });
});
