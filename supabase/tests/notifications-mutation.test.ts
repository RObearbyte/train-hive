import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addMember,
  admin,
  asService,
  cancelTraining,
  closeDb,
  createPack,
  createTraining,
  resetData,
  rpc,
  setRsvp,
} from './helpers';
import {
  cancelAnnouncement,
  claimJobs,
  createAnnouncement,
  expoToken,
  makeAnnouncementDue,
  publishDue,
  recipients,
  registerToken,
} from './notifications-helpers';
import { errorKey, waitForBlocked } from './qa-helpers';

/**
 * Mutation checks for Milestone 3 rules. Each case breaks ONE rule in the live test database,
 * runs a probe that asserts the rule, and restores the original. The probe must hold on the
 * pristine schema and must notice the mutant, which proves the rule is enforced where we think
 * it is and that a regression there would be caught.
 */

type Probe = () => Promise<boolean>;

async function withMutatedFunction<T>(
  signature: string,
  search: string,
  replacement: string,
  fn: () => Promise<T>,
): Promise<T> {
  const { rows } = await admin.query<{ def: string }>('select pg_get_functiondef($1::regprocedure) as def', [signature]);
  const original = rows[0].def;
  expect(original, `${signature} no longer contains: ${search}`).toContain(search);
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

async function check(probe: Probe, mutate: (run: Probe) => Promise<boolean>): Promise<void> {
  await resetData();
  expect(await probe(), 'probe holds on the pristine schema').toBe(true);
  await resetData();
  expect(await mutate(probe), 'probe notices the mutant').toBe(false);
}

// Probes --------------------------------------------------------------------------------------

/** Removed members get no notification of a new training. */
const removedMembersAreNotNotified: Probe = async () => {
  const { communityId, organizerId, memberIds } = await createPack(1);
  const removed = await addMember(communityId, { status: 'removed', name: 'Gone' });
  const session = await createTraining(organizerId, communityId);
  const got = await recipients('training_created', session.id);
  return got.length === 1 && got[0] === memberIds[0] && !got.includes(removed);
};

/** An invalidated token is never handed to the dispatcher. */
const invalidTokensAreNotReturned: Probe = async () => {
  const { communityId, organizerId, memberIds } = await createPack(1);
  await registerToken(memberIds[0], expoToken('ok'));
  await registerToken(memberIds[0], expoToken('dead'));
  await asService((db) => rpc(db, 'invalidate_push_tokens', [[expoToken('dead')], 'DeviceNotRegistered']));
  await createTraining(organizerId, communityId);
  const [job] = await claimJobs('probe');
  return job.tokens.length === 1 && job.tokens[0] === expoToken('ok');
};

/** A cancelled announcement is never published, even when its time has passed. */
const cancelledAnnouncementsStayCancelled: Probe = async () => {
  const { communityId, organizerId } = await createPack(1);
  const a = await createAnnouncement(organizerId, communityId, { scheduledFor: new Date(Date.now() + 3_600_000).toISOString() });
  await cancelAnnouncement(organizerId, a.id);
  await makeAnnouncementDue(a.id);
  const published = await publishDue();
  const status = (await admin.query('select status from public.announcements where id = $1', [a.id])).rows[0].status;
  return published === 0 && status === 'cancelled' && (await recipients('announcement_published', a.id)).length === 0;
};

/** A scheduled announcement is not published before scheduled_for. */
const notPublishedEarly: Probe = async () => {
  const { communityId, organizerId } = await createPack(1);
  const a = await createAnnouncement(organizerId, communityId, { scheduledFor: new Date(Date.now() + 3_600_000).toISOString() });
  const published = await publishDue();
  const status = (await admin.query('select status from public.announcements where id = $1', [a.id])).rows[0].status;
  return published === 0 && status === 'scheduled' && (await recipients('announcement_published', a.id)).length === 0;
};

/** Push preferences: a user with push turned off gets no tokens in the claim. */
const pushPreferenceIsRespected: Probe = async () => {
  const { communityId, organizerId, memberIds } = await createPack(1);
  await registerToken(memberIds[0], expoToken('p'));
  await admin.query('insert into public.notification_preferences (user_id, push_enabled) values ($1, false)', [memberIds[0]]);
  await createTraining(organizerId, communityId);
  const [job] = await claimJobs('probe');
  return job.tokens.length === 0 && job.skip_reason === 'push_disabled';
};

/**
 * Account deletion racing an organizer cancel that holds the session lock never deadlocks.
 * This is the reason notifications.user_id has no foreign key to profiles.
 */
const deletionDoesNotDeadlockWithFanOut: Probe = async () => {
  const { communityId, organizerId, memberIds } = await createPack(2);
  const session = await createTraining(organizerId, communityId, { min_participants: 1 });
  await setRsvp(memberIds[0], session.id, 'going');
  const gate = await admin.connect();
  let cancel: Promise<string>;
  let deletion: Promise<string>;
  try {
    await gate.query('begin');
    await gate.query('select 1 from public.training_sessions where id = $1 for update', [session.id]);
    cancel = cancelTraining(organizerId, session.id).then(() => 'ok', errorKey);
    await waitForBlocked('cancel_training');
    deletion = admin.query('delete from auth.users where id = $1', [memberIds[0]]).then(() => 'ok', errorKey);
    await waitForBlocked('delete from auth.users');
    await gate.query('commit');
  } finally {
    await gate.query('rollback');
    gate.release();
  }
  const results = await Promise.all([cancel, deletion]);
  return results.every((r) => r === 'ok');
};

beforeEach(resetData);
afterAll(closeDb);

describe('M3 mutation checks', () => {
  it('recipients are active members only (private.training_recipients)', async () => {
    await check(removedMembersAreNotNotified, (probe) =>
      withMutatedFunction(
        'private.training_recipients(uuid, uuid, uuid, boolean, uuid)',
        "and m.status = 'active'",
        'and true',
        probe,
      ),
    );
  });

  it('invalidated tokens are filtered out (claim_notification_jobs)', async () => {
    await check(invalidTokensAreNotReturned, (probe) =>
      withMutatedFunction(
        'public.claim_notification_jobs(integer, text)',
        'and t.invalidated_at is null',
        'and true',
        probe,
      ),
    );
  });

  it('scheduled announcements are not published before their time (publish_due_announcements)', async () => {
    await check(notPublishedEarly, (probe) =>
      withMutatedFunction(
        'public.publish_due_announcements()',
        'a.scheduled_for <= clock_timestamp()',
        "a.scheduled_for <= clock_timestamp() + interval '1 day'",
        probe,
      ),
    );
  });

  it('a cancelled announcement is never published (probe holds; also backed by a table check)', async () => {
    await resetData();
    expect(await cancelledAnnouncementsStayCancelled()).toBe(true);
  });

  it('push_enabled = false empties the token list (claim_notification_jobs)', async () => {
    await check(pushPreferenceIsRespected, (probe) =>
      withMutatedFunction(
        'public.claim_notification_jobs(integer, text)',
        "when not coalesce(pref.push_enabled, true) then 'push_disabled'",
        "when false then 'push_disabled'",
        probe,
      ),
    );
  });

  it('no foreign key from notifications to profiles: fan-out cannot deadlock with account deletion', async () => {
    await check(deletionDoesNotDeadlockWithFanOut, (probe) =>
      withSql(
        `alter table public.notifications add constraint qa_notifications_user_fkey
           foreign key (user_id) references public.profiles (id) on delete cascade`,
        'alter table public.notifications drop constraint if exists qa_notifications_user_fkey',
        probe,
      ),
    );
  });
});
