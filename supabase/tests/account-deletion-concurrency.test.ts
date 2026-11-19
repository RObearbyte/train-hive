import type { PoolClient } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  buildFullLife,
  deleteMyAccount,
  exportMyData,
  goingCountMismatches,
  type FullLife,
  leaveCommunity,
  packWithTwoOrganizers,
  referencesTo,
  setMemberRole,
} from './account-deletion-helpers';
import { recordAttendance } from './attendance-helpers';
import { openUserTransaction, withMutatedFunction } from './creator-codes-helpers';
import {
  admin,
  asUser,
  closeDb,
  countRows,
  createPack,
  createTraining,
  createUser,
  getSession,
  insertInvitation,
  resetData,
  rpc,
  setRsvp,
  trainingInput,
  updateTraining,
} from './helpers';
import { createAnnouncement, makeAnnouncementDue, publishDue } from './notifications-helpers';
import { errorKey, formOf, Outcomes, waitForBlocked } from './qa-helpers';

/**
 * GDPR G2: delete_my_account racing the writers that touch the same rows: the user's own RSVP and
 * consent calls, an organizer recording their attendance, an organizer editing a session, the
 * announcement publisher, a role change and a join. Each pair is run in both orders with one side
 * held open in a transaction, so the interleaving is deterministic, then all of them at once.
 * After every run: no deadlock, no raw constraint error, no row referring to the deleted user, and
 * every going_count equals its going rows.
 */

beforeEach(resetData);
afterAll(closeDb);

async function openServiceTransaction(): Promise<{ db: PoolClient; finish: (commit: boolean) => Promise<void> }> {
  const client = await admin.connect();
  await client.query('begin');
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'service_role' })]);
  await client.query('set local role service_role');
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

async function expectClean(victim: string): Promise<void> {
  expect(await referencesTo(victim)).toEqual({});
  expect(await goingCountMismatches()).toEqual([]);
}

interface Race {
  name: string;
  /** The competing call as a fresh request (used while the deletion holds its locks). */
  run: (life: FullLife) => Promise<unknown>;
  /** The same call inside an open transaction (used to make the deletion wait). */
  hold: (life: FullLife) => Promise<{ finish: (commit: boolean) => Promise<void> }>;
  /** A fragment of the competing call's SQL, to see it waiting; null when it never waits (SKIP LOCKED). */
  fragment: string | null;
  /** Outcomes allowed for the competing call when the deletion went first. */
  afterDeletion: RegExp;
}

async function holdAsUser(userId: string, sql: string, params: unknown[]) {
  const tx = await openUserTransaction(userId);
  await tx.db.query(sql, params);
  return tx;
}

const races: Race[] = [
  {
    name: "the user's own set_rsvp",
    run: (l) => setRsvp(l.victim, l.sessions.s5.id, 'not_going'),
    hold: (l) => holdAsUser(l.victim, 'select public.set_rsvp($1, $2)', [l.sessions.s5.id, 'not_going']),
    fragment: 'set_rsvp',
    afterDeletion: /^P0001:not_a_member$/,
  },
  {
    name: "another member's set_rsvp on the same open session",
    run: (l) => setRsvp(l.alpha.memberIds[0], l.sessions.s5.id, 'not_going'),
    hold: (l) => holdAsUser(l.alpha.memberIds[0], 'select public.set_rsvp($1, $2)', [l.sessions.s5.id, 'not_going']),
    fragment: 'set_rsvp',
    afterDeletion: /^ok$/,
  },
  {
    name: "record_attendance of the user's own attendance",
    run: (l) => recordAttendance(l.alpha.organizerId, l.sessions.s3.id, l.victim, 'present', 'Late correction'),
    hold: (l) =>
      holdAsUser(l.alpha.organizerId, 'select public.record_attendance($1, $2, $3)', [l.sessions.s3.id, l.victim, 'present']),
    fragment: 'record_attendance',
    afterDeletion: /^P0001:attendee_not_a_member$/,
  },
  {
    name: 'record_attendance on a session the user organized',
    run: (l) => recordAttendance(l.alpha.organizerId, l.sessions.s1.id, l.alpha.memberIds[1], 'present'),
    hold: (l) =>
      holdAsUser(l.alpha.organizerId, 'select public.record_attendance($1, $2, $3)', [
        l.sessions.s1.id,
        l.alpha.memberIds[1],
        'present',
      ]),
    fragment: 'record_attendance',
    afterDeletion: /^ok$/,
  },
  {
    name: 'update_training of an open session (fans out training_updated)',
    run: async (l) => updateTraining(l.alpha.organizerId, l.sessions.s5.id, formOf(await getSession(l.sessions.s5.id), { title: 'Moved run' })),
    hold: async (l) =>
      holdAsUser(l.alpha.organizerId, 'select public.update_training($1, $2)', [
        l.sessions.s5.id,
        JSON.stringify(formOf(await getSession(l.sessions.s5.id), { title: 'Moved run' })),
      ]),
    fragment: 'update_training',
    afterDeletion: /^ok$/,
  },
  {
    name: 'update_training of a confirmed session (fans out training_updated)',
    run: async (l) =>
      updateTraining(l.alpha.organizerId, l.sessions.s7.id, formOf(await getSession(l.sessions.s7.id), { title: 'Renamed' })),
    hold: async (l) =>
      holdAsUser(l.alpha.organizerId, 'select public.update_training($1, $2)', [
        l.sessions.s7.id,
        JSON.stringify(formOf(await getSession(l.sessions.s7.id), { title: 'Renamed' })),
      ]),
    fragment: 'update_training',
    afterDeletion: /^ok$/,
  },
  {
    name: 'create_training (fans out training_created)',
    run: (l) => createTraining(l.alpha.organizerId, l.alpha.communityId),
    hold: (l) =>
      holdAsUser(l.alpha.organizerId, 'select public.create_training($1, $2)', [
        l.alpha.communityId,
        JSON.stringify(trainingInput()),
      ]),
    fragment: 'create_training',
    afterDeletion: /^ok$/,
  },
  {
    name: 'publish_due_announcements (fans out announcement_published)',
    run: () => publishDue(),
    hold: async () => {
      const tx = await openServiceTransaction();
      await tx.db.query('select public.publish_due_announcements()');
      return tx;
    },
    // SKIP LOCKED: it never waits for the deletion, it skips the rows the deletion holds.
    fragment: null,
    afterDeletion: /^ok$/,
  },
  {
    name: "set_member_role demoting the user",
    run: (l) => setMemberRole(l.alpha.organizerId, l.alpha.communityId, l.victim, 'member'),
    hold: (l) =>
      holdAsUser(l.alpha.organizerId, 'select public.set_member_role($1, $2, $3)', [l.alpha.communityId, l.victim, 'member']),
    fragment: 'set_member_role',
    afterDeletion: /^P0001:not_found$/,
  },
  {
    name: "the user's own record_consent",
    run: (l) => asUser(l.victim, (db) => rpc(db, 'record_consent', ['profile_demographics'])),
    hold: (l) => holdAsUser(l.victim, 'select public.record_consent($1)', ['profile_demographics']),
    fragment: 'record_consent',
    afterDeletion: /^P0001:not_authenticated$/,
  },
  {
    name: "the user's own export_my_data",
    run: (l) => exportMyData(l.victim),
    hold: (l) => holdAsUser(l.victim, 'select public.export_my_data()', []),
    fragment: 'export_my_data',
    afterDeletion: /^P0001:not_authenticated$/,
  },
];

/** A full life plus an organizer's scheduled announcement that is due (for the publisher). */
async function world(): Promise<FullLife> {
  const life = await buildFullLife();
  const due = await createAnnouncement(life.alpha.organizerId, life.alpha.communityId, {
    title: 'Due now',
    scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await makeAnnouncementDue(due.id);
  return life;
}

describe('deletion first, the other call waits', () => {
  for (const race of races) {
    it(race.name, async () => {
      const life = await world();
      const deletion = await openUserTransaction(life.victim);
      await deletion.db.query('select public.delete_my_account()');

      const other = race.run(life).then(() => 'ok', errorKey);
      if (race.fragment) await waitForBlocked(race.fragment);
      await deletion.finish(true);

      expect(await other).toMatch(race.afterDeletion);
      await expectClean(life.victim);
    });
  }
});

describe('the other call first, the deletion waits', () => {
  for (const race of races) {
    it(race.name, async () => {
      const life = await world();
      const other = await race.hold(life);

      const deletion = deleteMyAccount(life.victim).then(() => 'ok', errorKey);
      await waitForBlocked('delete_my_account');
      await other.finish(true);

      expect(await deletion).toBe('ok');
      await expectClean(life.victim);
    });
  }
});

describe('everything at once', () => {
  it('a storm around one deletion never deadlocks and leaves nothing behind', async () => {
    for (let round = 0; round < 3; round += 1) {
      await resetData();
      const life = await world();
      const outcomes = new Outcomes();
      const business = /^P0001:/;
      const ops: (() => Promise<unknown>)[] = [
        () => outcomes.run('delete', /^$/, () => deleteMyAccount(life.victim)),
        ...races.map((race) => () => outcomes.run(race.name, business, () => race.run(life))),
        () => outcomes.run('rsvp m2', business, () => setRsvp(life.alpha.memberIds[1], life.sessions.s5.id, 'going')),
        () => outcomes.run('rsvp m3', business, () => setRsvp(life.beta.memberIds[0], life.sessions.s10.id, 'going')),
        () =>
          outcomes.run('mark all read', business, () =>
            asUser(life.victim, (db) => rpc(db, 'mark_all_notifications_read', [life.alpha.communityId])),
          ),
        () =>
          outcomes.run('leave beta', business, () => leaveCommunity(life.victim, life.beta.communityId)),
      ];
      // Shuffle the start order each round.
      ops.sort(() => Math.random() - 0.5);
      await Promise.all(ops.map((op) => op()));

      expect(outcomes.unexpected).toEqual([]);
      expect(outcomes.counts.get('delete:ok')).toBe(1);
      await expectClean(life.victim);
    }
  });
});

describe('mutation check', () => {
  it("without create_training's membership lock, a creation in flight leaves a notification for the deleted user", async () => {
    const life = await world();
    const orphan = await withMutatedFunction(
      'public.create_training(uuid, jsonb)',
      "and m.role = 'organizer'\n  for no key update;",
      "and m.role = 'organizer';",
      async () => {
        const create = await holdAsUser(life.alpha.organizerId, 'select public.create_training($1, $2)', [
          life.alpha.communityId,
          JSON.stringify(trainingInput()),
        ]);
        // The deletion no longer waits for the creation...
        await deleteMyAccount(life.victim);
        await create.finish(true);
        // ...which committed a notification for the deleted user afterwards.
        return referencesTo(life.victim);
      },
    );
    expect(orphan).toEqual({ 'public.notifications.user_id': 1, 'public.notification_delivery_jobs.user_id': 1 });
  });
});

describe('deletion against joins and other organizers', () => {
  it('a join into the community the user is alone in: deletion first, the join finds no code', async () => {
    const { communityId, organizerId } = await createPack(0);
    const code = await insertInvitation(communityId, 'JN2345AB');
    const joiner = await createUser();

    const deletion = await openUserTransaction(organizerId);
    await deletion.db.query('select public.delete_my_account()');
    const join = asUser(joiner, (db) => rpc<{ ok: boolean; error?: string }>(db, 'redeem_invitation', [code.code, 'Joiner']));
    await waitForBlocked('redeem_invitation');
    await deletion.finish(true);

    expect(await join).toEqual({ ok: false, error: 'invalid_code' });
    expect(await countRows('communities', 'id = $1', [communityId])).toBe(0);
    expect(await countRows('memberships', 'user_id = $1', [joiner])).toBe(0);
  });

  it('a join into that community first: the user is then the last organizer and is refused', async () => {
    const { communityId, organizerId } = await createPack(0);
    const code = await insertInvitation(communityId, 'JN2345AC');
    const joiner = await createUser();

    const join = await holdAsUser(joiner, 'select public.redeem_invitation($1, $2)', [code.code, 'Joiner']);
    const deletion = deleteMyAccount(organizerId).then(() => 'ok', errorKey);
    await waitForBlocked('delete_my_account');
    await join.finish(true);

    expect(await deletion).toBe('P0001:last_organizer');
    expect(await countRows('memberships', "community_id = $1 and status = 'active'", [communityId])).toBe(2);
  });

  it('two organizers of a community with members deleting at once: exactly one succeeds', async () => {
    for (let round = 0; round < 6; round += 1) {
      const pack = await packWithTwoOrganizers(1);
      const results = await Promise.all([
        deleteMyAccount(pack.organizerId).then(() => 'ok', errorKey),
        deleteMyAccount(pack.secondOrganizerId).then(() => 'ok', errorKey),
      ]);
      expect(results.sort()).toEqual(['P0001:last_organizer', 'ok']);
      expect(
        await countRows('memberships', "community_id = $1 and status = 'active' and role = 'organizer'", [pack.communityId]),
      ).toBe(1);
    }
  });

  it('an organizer leaving while the co-organizer deletes their account: one of them is refused', async () => {
    for (let round = 0; round < 6; round += 1) {
      const pack = await packWithTwoOrganizers(1);
      const results = await Promise.all([
        leaveCommunity(pack.organizerId, pack.communityId).then(() => 'ok', errorKey),
        deleteMyAccount(pack.secondOrganizerId).then(() => 'ok', errorKey),
      ]);
      expect(results.sort()).toEqual(['P0001:last_organizer', 'ok']);
      expect(
        await countRows('memberships', "community_id = $1 and status = 'active' and role = 'organizer'", [pack.communityId]),
      ).toBe(1);
    }
  });
});
