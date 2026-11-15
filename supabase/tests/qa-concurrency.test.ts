import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  admin,
  asService,
  asUser,
  cancelTraining,
  closeDb,
  createPack,
  createTraining,
  finalize,
  getSession,
  realGoingCount,
  resetData,
  rpc,
  rpcRow,
  type RsvpResponse,
  type RsvpResult,
  type Session,
  setRsvp,
} from './helpers';
import {
  auditViolations,
  clearSessionAudit,
  deadlineIn,
  errorKey,
  formOf,
  installSessionAudit,
  Outcomes,
  raised,
  removeSessionAudit,
  sleep,
  waitForBlocked,
} from './qa-helpers';

/**
 * QA (M1-Q1): races around the deadline decision, randomized invariant checks and a deadlock
 * probe. A test-only audit trigger (qa-helpers.ts) records every session write, so invariants
 * are checked at every committed step of a run and not only on the final state.
 */

const RSVP_ERRORS = /^P0001:(rsvp_closed|session_full|not_a_member)$/;
const ORGANIZER_ERRORS = /^P0001:(validation_failed:[a-z_]+|session_not_editable)$/;

async function sessionsOf(communityIds: string[]): Promise<Session[]> {
  const { rows } = await admin.query<Session>(
    'select * from public.training_sessions where community_id = any($1::uuid[]) order by id',
    [communityIds],
  );
  return rows;
}

beforeAll(installSessionAudit);
beforeEach(async () => {
  await resetData();
  await clearSessionAudit();
});
afterAll(async () => {
  await removeSessionAudit();
  await closeDb();
});

describe('QA audit self-check', () => {
  it('the audit used below reports every kind of violation when one is forced', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const session = await createTraining(organizerId, communityId, { min_participants: 1, max_participants: 5 });
    await setRsvp(memberIds[0], session.id, 'going');
    const set = (sql: string) => admin.query(`update public.training_sessions set ${sql} where id = $1`, [session.id]);

    await set('going_count = 3'); // count drift
    await set('going_count = 1');
    await set("status = 'confirmed', decided_at = now()"); // decided before the deadline
    await set('min_participants = 2, max_participants = 6'); // limits changed after the decision
    await set("status = 'scheduled'"); // un-decided
    await set("rsvp_deadline = now() - interval '1 hour', decided_at = null");
    await set('min_participants = 1'); // limit changed after the deadline
    await set('going_count = 0'); // count changed after the deadline (and drift)

    const rules = new Set((await auditViolations({ lateRsvp: true })).map((v) => v.rule));
    expect([...rules].sort()).toEqual(['count', 'deadline-frozen', 'decided-frozen', 'decision', 'late-rsvp', 'transition']);
  });
});

describe('QA finalizer races', () => {
  it('a burst of RSVPs right at the deadline: the decision matches the committed count and never changes', async () => {
    const { communityId, organizerId, memberIds } = await createPack(12);
    const outcomes: string[] = [];

    for (let round = 0; round < 4; round += 1) {
      const session = await createTraining(organizerId, communityId, { min_participants: 6 });
      await deadlineIn(session.id, 350);
      const lastAccepted = new Map<string, RsvpResponse>();

      const members = memberIds.map((id, index) =>
        asUser(id, async (db) => {
          // Half the pack starts with "going", so the count hovers around the minimum.
          for (let step = index + round; ; step += 1) {
            const response: RsvpResponse = step % 2 === 0 ? 'going' : 'not_going';
            try {
              const result = await rpc<RsvpResult>(db, 'set_rsvp', [session.id, response]);
              expect(result.status).toBe('scheduled');
              lastAccepted.set(id, response);
            } catch (error) {
              expect(errorKey(error)).toBe('P0001:rsvp_closed');
              return;
            }
          }
        }),
      );
      const finalizer = (async () => {
        while ((await finalize()) === 0) await sleep(5);
      })();
      await Promise.all([...members, finalizer]);

      const decided = await getSession(session.id);
      const real = await realGoingCount(session.id);
      expect(decided.status).not.toBe('scheduled');
      expect(decided.going_count).toBe(real);
      expect(decided.status).toBe(real >= 6 ? 'confirmed' : 'cancelled');
      expect(decided.cancel_reason).toBe(real >= 6 ? null : 'insufficient_participation');
      expect(decided.decided_at!.getTime()).toBeGreaterThanOrEqual(decided.rsvp_deadline.getTime());
      outcomes.push(decided.status);

      // Every accepted RSVP is stored, and none was written at or after the deadline.
      const { rows } = await admin.query<{ user_id: string; response: RsvpResponse; late: boolean }>(
        `select r.user_id, r.response, r.updated_at >= s.rsvp_deadline as late
         from public.training_rsvps r join public.training_sessions s on s.id = r.session_id
         where r.session_id = $1`,
        [session.id],
      );
      expect(new Map(rows.map((row) => [row.user_id, row.response]))).toEqual(lastAccepted);
      expect(rows.filter((row) => row.late)).toEqual([]);

      // Late client updates cannot move the decision.
      const late = await Promise.allSettled(
        memberIds.flatMap((id) => [setRsvp(id, session.id, 'going'), setRsvp(id, session.id, 'not_going')]),
      );
      for (const result of late) {
        expect(result.status).toBe('rejected');
        expect((result as PromiseRejectedResult).reason).toMatchObject(raised('rsvp_closed'));
      }
      expect(await finalize()).toBe(0);
      expect(await getSession(session.id)).toEqual(decided);
    }

    expect(await auditViolations({ lateRsvp: true })).toEqual([]);
    // Informational: which way the four races went.
    expect(outcomes).toHaveLength(4);
  });

  it('finalizer racing organizer cancel and update_training: no escape, no oscillation, no stuck session', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const log = new Outcomes();
    const sessions: Session[] = [];
    for (let i = 0; i < 6; i += 1) {
      // One going, minimum two: the finalizer would cancel each of these.
      const session = await createTraining(organizerId, communityId, { min_participants: 2, max_participants: 5 });
      await setRsvp(memberIds[0], session.id, 'going');
      sessions.push(session);
    }
    for (const session of sessions) await deadlineIn(session.id, 300);
    const stopAt = Date.now() + 900;

    // The organizer tries to dodge the cancellation: lower the minimum, move the deadline,
    // raise the limit; and cancels half of the sessions somewhere around the deadline.
    const escapes = sessions.map((session, index) =>
      asUser(organizerId, async (db) => {
        await sleep(200 + index * 15);
        const attempts: Record<string, unknown>[] = [
          { min_participants: 1 },
          { rsvp_deadline: new Date(Date.now() + 86_400_000).toISOString() },
          { max_participants: 9 },
          { title: `Edited ${index}` },
        ];
        for (let step = 0; Date.now() < stopAt; step += 1) {
          const current = await getSession(session.id);
          await log.run('update', ORGANIZER_ERRORS, () =>
            rpcRow(db, 'update_training', [session.id, JSON.stringify(formOf(current, attempts[step % attempts.length]))]),
          );
        }
      }),
    );
    const cancels = sessions
      .filter((_, index) => index % 2 === 1)
      .map(async (session, index) => {
        await sleep(280 + index * 20);
        await log.run('cancel', /^$/, () => cancelTraining(organizerId, session.id));
      });
    const finalizer = (async () => {
      while (Date.now() < stopAt) {
        await log.run('finalize', /^$/, () => finalize());
        await sleep(5);
      }
    })();
    await Promise.all([...escapes, ...cancels, finalizer]);
    await finalize();

    expect(log.unexpected).toEqual([]);
    expect(await auditViolations()).toEqual([]);
    const after = await sessionsOf([communityId]);
    for (const [index, session] of sessions.entries()) {
      const row = after.find((s) => s.id === session.id)!;
      expect(row.going_count).toBe(1);
      if (index % 2 === 1) {
        // A cancel always sticks, whichever side of the decision it landed on.
        expect(row.status).toBe('cancelled');
      }
      if (row.status === 'scheduled') {
        // Only possible when an update moved the deadline while RSVPs were still open.
        expect(row.rsvp_deadline.getTime()).toBeGreaterThan(Date.now());
      } else if (row.cancel_reason !== 'organizer') {
        expect(row.status).toBe(row.going_count >= row.min_participants ? 'confirmed' : 'cancelled');
      }
    }
    // The decision is final: more finalizer runs and more cancels change nothing.
    const frozen = await sessionsOf([communityId]);
    await finalize();
    for (const session of sessions.filter((_, index) => index % 2 === 1)) {
      await cancelTraining(organizerId, session.id);
    }
    expect(await sessionsOf([communityId])).toEqual(frozen);
  });

  it('an organizer cancel of a confirmed session is never undone by the finalizer', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const session = await createTraining(organizerId, communityId, { min_participants: 2 });
    for (const id of memberIds) await setRsvp(id, session.id, 'going');
    await deadlineIn(session.id, -1000);
    expect(await finalize()).toBe(1);
    expect((await getSession(session.id)).status).toBe('confirmed');

    const cancelled = await cancelTraining(organizerId, session.id);
    const results = await Promise.all([finalize(), finalize(), cancelTraining(organizerId, session.id), finalize()]);

    expect(results.filter((r) => typeof r === 'number')).toEqual([0, 0, 0]);
    expect(await getSession(session.id)).toEqual(cancelled);
    expect(cancelled).toMatchObject({ status: 'cancelled', cancel_reason: 'organizer', going_count: 2 });
    expect(cancelled.decided_at).not.toBeNull();
    expect(await auditViolations()).toEqual([]);
  });
});

describe('QA randomized invariants and deadlock probe', () => {
  it('a storm of RSVPs, edits, cancels, removals and finalizer runs keeps every invariant, with no deadlock', async () => {
    const packs = [await createPack(6), await createPack(6)];
    const log = new Outcomes();
    const random = (n: number) => Math.floor(Math.random() * n);

    const sessionIds: string[][] = [];
    for (const pack of packs) {
      const ids: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const session = await createTraining(pack.organizerId, pack.communityId, {
          min_participants: 2 + random(3),
          max_participants: i % 2 === 0 ? null : 4 + random(3),
        });
        await deadlineIn(session.id, 900 + i * 500);
        ids.push(session.id);
      }
      sessionIds.push(ids);
    }
    const stopAt = Date.now() + 3500;

    const members = packs.flatMap((pack, p) =>
      pack.memberIds.map((id) =>
        asUser(id, async (db) => {
          const responses: RsvpResponse[] = ['going', 'going', 'not_going', 'no_response'];
          while (Date.now() < stopAt) {
            await log.run('rsvp', RSVP_ERRORS, () =>
              rpc(db, 'set_rsvp', [sessionIds[p][random(4)], responses[random(responses.length)]]),
            );
          }
        }),
      ),
    );
    const organizers = packs.map((pack, p) =>
      asUser(pack.organizerId, async (db) => {
        for (let step = 0; Date.now() < stopAt; step += 1) {
          // The first session of each pack only ever gets title edits, so that at least one
          // session is certain to reach its deadline and be decided by the finalizer.
          const index = random(4);
          const id = sessionIds[p][index];
          const current = await getSession(id);
          if (index > 0 && random(25) === 0) {
            await log.run('cancel', /^$/, () => rpcRow(db, 'cancel_training', [id]));
            continue;
          }
          const min = 1 + random(5);
          const change = [
            { title: `Storm ${random(1000)}` },
            { min_participants: min, max_participants: random(2) === 0 ? null : min + random(4) },
            { rsvp_deadline: new Date(Date.now() + 200 + random(1500)).toISOString() },
            { max_participants: 1 + random(8) },
          ][index === 0 || step === 0 ? 0 : random(4)];
          await log.run('update', ORGANIZER_ERRORS, () =>
            rpcRow(db, 'update_training', [id, JSON.stringify(formOf(current, change))]),
          );
          await sleep(10);
        }
      }),
    );
    const finalizer = (async () => {
      while (Date.now() < stopAt) {
        await log.run('finalize', /^$/, () => finalize());
        await sleep(15);
      }
    })();
    const remover = (async () => {
      // Removes (and for some, later restores) one member at a time, as an admin would.
      for (let i = 0; Date.now() < stopAt; i += 1) {
        await sleep(250);
        const victim = packs[i % 2].memberIds[random(6)];
        await log.run('remove', /^$/, () =>
          admin.query("update public.memberships set status = 'removed' where user_id = $1", [victim]),
        );
        if (i % 3 === 0) {
          await sleep(100);
          await log.run('restore', /^$/, () =>
            admin.query("update public.memberships set status = 'active' where user_id = $1", [victim]),
          );
        }
      }
    })();

    await Promise.all([...members, ...organizers, finalizer, remover]);

    // No deadlock (40P01), no constraint violation, no unexpected error of any kind.
    expect(log.unexpected).toEqual([]);
    // The storm actually exercised every operation.
    for (const label of ['rsvp:ok', 'rsvp:P0001:rsvp_closed', 'update:ok', 'finalize:ok', 'remove:ok']) {
      expect(log.total(label), label).toBeGreaterThan(0);
    }
    const { rows: decisions } = await admin.query<{ n: number }>(
      'select count(*)::int as n from qa.session_audit where old_decided is null and new_decided is not null',
    );
    expect(decisions[0].n).toBeGreaterThan(0);

    // Checked at every recorded write: legal transitions, exact counts, correct and final decisions.
    expect(await auditViolations()).toEqual([]);

    // And on the final state.
    const { rows: drift } = await admin.query(
      `select s.id, s.going_count, count(r.id)::int as real
       from public.training_sessions s
       left join public.training_rsvps r on r.session_id = s.id and r.response = 'going'
       group by s.id having s.going_count <> count(r.id)`,
    );
    expect(drift).toEqual([]);
    const { rows: ghosts } = await admin.query(
      `select r.session_id, r.user_id
       from public.training_rsvps r
       join public.training_sessions s on s.id = r.session_id and s.status = 'scheduled'
       join public.memberships m on m.community_id = r.community_id and m.user_id = r.user_id
       where r.response = 'going' and m.status <> 'active'`,
    );
    expect(ghosts).toEqual([]);
    const { rows: overbooked } = await admin.query(
      'select id from public.training_sessions where max_participants is not null and going_count > max_participants',
    );
    expect(overbooked).toEqual([]);
  });

  it('removing every member while they all RSVP to every session does not deadlock', async () => {
    const { communityId, organizerId, memberIds } = await createPack(10);
    const log = new Outcomes();
    const sessions: Session[] = [];
    for (let i = 0; i < 5; i += 1) sessions.push(await createTraining(organizerId, communityId, { min_participants: 1 }));
    // Members walk the sessions in opposite orders; removals lock all of them.
    const rsvps = memberIds.map((id, index) =>
      asUser(id, async (db) => {
        const order = index % 2 === 0 ? sessions : [...sessions].reverse();
        for (let lap = 0; lap < 3; lap += 1) {
          for (const session of order) {
            await log.run('rsvp', RSVP_ERRORS, () => rpc(db, 'set_rsvp', [session.id, lap % 2 === 0 ? 'going' : 'not_going']));
          }
        }
      }),
    );
    const removals = memberIds.map(async (id, index) => {
      await sleep(index * 8);
      await log.run('remove', /^$/, () =>
        admin.query("update public.memberships set status = 'removed' where user_id = $1", [id]),
      );
    });
    const edits = sessions.map((session) =>
      log.run('update', ORGANIZER_ERRORS, () =>
        asUser(organizerId, (db) => rpcRow(db, 'update_training', [session.id, JSON.stringify(formOf(session, { title: 'Edited' }))])),
      ),
    );

    await Promise.all([...rsvps, ...removals, ...edits, asService((db) => rpc(db, 'finalize_due_sessions'))]);

    expect(log.unexpected).toEqual([]);
    expect(log.total('remove:ok')).toBe(10);
    for (const session of sessions) {
      expect(await getSession(session.id)).toMatchObject({ going_count: 0 });
      expect(await realGoingCount(session.id)).toBe(0);
    }
    expect(await auditViolations()).toEqual([]);
  });

  // DEFECT Q1-1 (low): deleting a user deadlocks with that user's first RSVP to a session.
  // set_rsvp locks membership -> session -> (FK check) profile; the delete cascade locks
  // profile -> membership. One of the two transactions is aborted with 40P01.
  it('DEFECT Q1-1: deleting a user while their first RSVP is in flight does not deadlock', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const session = await createTraining(organizerId, communityId, { min_participants: 1 });
    const user = memberIds[0];

    const gate = await admin.connect();
    let rsvp: Promise<string>;
    let deletion: Promise<string>;
    try {
      await gate.query('begin');
      await gate.query('select 1 from public.training_sessions where id = $1 for update', [session.id]);
      // The RSVP now holds a share lock on the membership and waits for the session row.
      rsvp = setRsvp(user, session.id, 'going').then(() => 'ok', errorKey);
      await waitForBlocked('set_rsvp');
      // The delete removes the profile row and waits for the membership row.
      deletion = admin.query('delete from auth.users where id = $1', [user]).then(() => 'ok', errorKey);
      await waitForBlocked('delete from auth.users');
      await gate.query('commit');
    } finally {
      await gate.query('rollback');
      gate.release();
    }
    const results = await Promise.all([rsvp, deletion]);

    // Expected: both complete (in either order) or the RSVP fails with a business error.
    // Actual: one of them fails with "40P01:deadlock detected".
    expect(results.filter((r) => r.startsWith('40P01'))).toEqual([]);
  });

  it('whatever the outcome of that race, the count stays exact', async () => {
    const { communityId, organizerId, memberIds } = await createPack(4);
    const session = await createTraining(organizerId, communityId, { min_participants: 1 });

    await Promise.all(
      memberIds.flatMap((id) => [
        setRsvp(id, session.id, 'going').catch((error: unknown) => {
          expect(errorKey(error)).toMatch(/^(P0001:not_a_member|40P01:.*|23503:.*)$/);
        }),
        admin.query('delete from auth.users where id = $1', [id]).catch((error: unknown) => {
          expect(errorKey(error)).toMatch(/^40P01:/);
        }),
      ]),
    );

    expect((await getSession(session.id)).going_count).toBe(await realGoingCount(session.id));
  });
});
