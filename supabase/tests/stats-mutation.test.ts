import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { admin, closeDb, resetData } from './helpers';
import { communityStats, myStats, SeasonBuilder } from './stats-helpers';

/**
 * Mutation checks for the statistics rules, in the style of attendance-mutation.test.ts: each
 * case breaks ONE rule in the live test database, runs a probe that asserts the rule, and
 * restores the original. The probe must hold on the pristine schema and must notice the mutant.
 */

beforeEach(resetData);
afterAll(closeDb);

type Probe = () => Promise<boolean>;

async function withMutatedFunction<T>(signature: string, search: string, replacement: string, fn: () => Promise<T>): Promise<T> {
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

/** One member, one finalized session 30 hours ago with a going RSVP and NO mark (unrecorded). */
const unrecordedIsNotAbsent: Probe = async () => {
  const season = await SeasonBuilder.create();
  const M = await season.person();
  await season.going(await season.session({ hoursAgo: 30 }), M, 'unrecorded');
  await season.rsvp(await season.session({ hoursAgo: 40 }), M, 'going');
  const stats = await myStats(M, season.communityId, '7d');
  return stats.eligible === 2 && stats.absent === 0 && stats.not_recorded === 2 && stats.missed === 0 && stats.rsvp_reliability === null;
};

/** A cancelled session (with an RSVP and even a stray record) never counts as eligible or attended. */
const cancelledNeverCounts: Probe = async () => {
  const season = await SeasonBuilder.create();
  const O = await season.person({ role: 'organizer' });
  const M = await season.person();
  const cancelled = await season.session({ hoursAgo: 30, kind: 'cancelled_organizer' });
  await season.going(cancelled, M, 'present');
  const stats = await myStats(M, season.communityId, '7d');
  const community = await communityStats(O, season.communityId, '7d');
  return (
    stats.eligible === 0 &&
    stats.attended === 0 &&
    community.completed_trainings === 0 &&
    community.total_attendances === 0 &&
    community.cancelled_by_organizer === 1
  );
};

describe('statistics mutation checks', () => {
  it('counting unrecorded as absent is noticed', async () => {
    expect(await unrecordedIsNotAbsent()).toBe(true);
    await resetData();
    const noticed = await withMutatedFunction(
      'private.stats_member_payload(uuid, uuid, text, timestamptz)',
      "count(*) filter (where e.attendance = 'absent')::integer as absent,",
      "count(*) filter (where e.attendance <> 'present')::integer as absent,",
      async () => !(await unrecordedIsNotAbsent()),
    );
    expect(noticed).toBe(true);
  });

  it('a missing record treated as absent is noticed', async () => {
    await resetData();
    const noticed = await withMutatedFunction(
      'private.stats_rows(uuid, timestamptz, timestamptz, uuid)',
      "coalesce(a.status, 'unrecorded'::public.attendance_status)",
      "coalesce(a.status, 'absent'::public.attendance_status)",
      async () => !(await unrecordedIsNotAbsent()),
    );
    expect(noticed).toBe(true);
  });

  it('including cancelled sessions is noticed', async () => {
    expect(await cancelledNeverCounts()).toBe(true);
    await resetData();
    const noticed = await withMutatedFunction(
      'private.stats_sessions(uuid, timestamptz, timestamptz)',
      "and s.status = 'completed' and s.attendance_finalized_at is not null and s.cancel_reason is null",
      "and s.status in ('completed', 'cancelled')",
      async () => !(await cancelledNeverCounts()),
    );
    expect(noticed).toBe(true);
  });
});
