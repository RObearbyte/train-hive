import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { auditOf, confirmedSession, makeEnded, recordAttendance } from './attendance-helpers';
import { deleteMyAccount, exportMyData, packWithTwoOrganizers } from './account-deletion-helpers';
import {
  admin,
  asAnon,
  asService,
  asUser,
  closeDb,
  countRows,
  createPack,
  createTraining,
  createUser,
  finalize,
  grantConsents,
  INSUFFICIENT_PRIVILEGE,
  makeDue,
  resetData,
  rpc,
  setRsvp,
} from './helpers';
import { claimJobs, createAnnouncement, expoToken, registerToken } from './notifications-helpers';
import { errorKey, raised } from './qa-helpers';

/**
 * GDPR QA fixes (docs/QA_REPORT.md Q7-1, Q7-2, Q7-3, Q7-4, Q7-6; migration
 * 20261125000100_gdpr_qa_fixes.sql). All names and values are obviously fake.
 */

beforeEach(resetData);
afterAll(closeDb);

/** A token as the pre-G1 register_push_token wrote it: no consent event behind it. */
async function legacyToken(userId: string, seed: string, extra: { invalidatedDaysAgo?: number; lastSeenDaysAgo?: number } = {}) {
  await admin.query(
    `insert into public.device_push_tokens (user_id, token, platform, invalidated_at, last_seen_at, created_at)
     values ($1, $2, 'android',
             case when $3::int is null then null else now() - make_interval(days => $3::int) end,
             now() - make_interval(days => coalesce($4::int, 0)),
             now() - make_interval(days => coalesce($4::int, 0)))`,
    [userId, expoToken(seed), extra.invalidatedDaysAgo ?? null, extra.lastSeenDaysAgo ?? null],
  );
}

const withdraw = (userId: string, purpose = 'push_notifications') =>
  asUser(userId, (db) => rpc<{ purpose: string; granted: boolean; changed: boolean }>(db, 'withdraw_consent', [purpose]));
const tokensOf = (userId: string) => countRows('device_push_tokens', 'user_id = $1', [userId]);
const ledgerOf = (userId: string, purpose = 'push_notifications') =>
  countRows('consent_records', 'user_id = $1 and purpose = $2', [userId, purpose]);
const purge = () => asService((db) => rpc<number>(db, 'purge_old_notification_data'));

describe('Q7-1: claim_notification_jobs hands out tokens only with push consent', () => {
  it('no consent ever given: tokens [], skip_reason no_push_consent, push_allowed false; the in-app notification stays', async () => {
    const p = await createPack(1);
    const [member] = p.memberIds;
    await legacyToken(member, 'legacy');
    await createAnnouncement(p.organizerId, p.communityId);
    const job = (await claimJobs('w')).find((j) => j.user_id === member);
    expect(job).toMatchObject({ push_allowed: false, skip_reason: 'no_push_consent', tokens: [] });
    expect(await countRows('notifications', 'user_id = $1', [member])).toBe(1);
  });

  it('consent withdrawn after registration: no tokens even if a token row reappears; re-granting restores delivery', async () => {
    const p = await createPack(1);
    const [member] = p.memberIds;
    await registerToken(member, expoToken('phone'));
    await withdraw(member);
    expect(await tokensOf(member)).toBe(0);
    // A row written behind the RPCs' back (or a registration that raced) must still not be used.
    await legacyToken(member, 'phone-again');
    await createAnnouncement(p.organizerId, p.communityId, { title: 'First' });
    expect((await claimJobs('w')).find((j) => j.user_id === member)).toMatchObject({
      push_allowed: false,
      skip_reason: 'no_push_consent',
      tokens: [],
    });

    await asUser(member, (db) => rpc(db, 'record_consent', ['push_notifications', null]));
    await createAnnouncement(p.organizerId, p.communityId, { title: 'Second' });
    expect((await claimJobs('w')).find((j) => j.user_id === member)).toMatchObject({
      push_allowed: true,
      skip_reason: null,
      tokens: [expoToken('phone-again')],
    });
  });

  it('no consent and no token: no_push_consent (consent is checked before tokens)', async () => {
    const p = await createPack(1);
    await createAnnouncement(p.organizerId, p.communityId);
    const [job] = await claimJobs('w');
    expect(job).toMatchObject({ user_id: p.memberIds[0], push_allowed: false, skip_reason: 'no_push_consent', tokens: [] });
  });

  it('ladder order: not_a_member, push_disabled and category_disabled come before no_push_consent', async () => {
    const p = await createPack(3);
    const [removed, pushOff, categoryOff] = p.memberIds;
    for (const id of p.memberIds) await legacyToken(id, id);
    await asUser(pushOff, (db) => rpc(db, 'set_notification_preferences', [false, null, null, null]));
    // Third argument: the announcements category.
    await asUser(categoryOff, (db) => rpc(db, 'set_notification_preferences', [null, null, false, null]));
    await createAnnouncement(p.organizerId, p.communityId);
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [removed]);
    const byUser = new Map((await claimJobs('w')).map((j) => [j.user_id, j]));
    expect(byUser.get(removed)?.skip_reason).toBe('not_a_member');
    expect(byUser.get(pushOff)?.skip_reason).toBe('push_disabled');
    expect(byUser.get(categoryOff)?.skip_reason).toBe('category_disabled');
  });

  it('only push_notifications counts: other optional consents do not open push', async () => {
    const p = await createPack(1);
    const [member] = p.memberIds;
    await grantConsents(member, ['profile_demographics', 'emergency_contact', 'workout_logs']);
    await legacyToken(member, 'x');
    await createAnnouncement(p.organizerId, p.communityId);
    expect((await claimJobs('w'))[0]).toMatchObject({ skip_reason: 'no_push_consent', tokens: [] });
  });

  it('unauthorized: authenticated and anon cannot claim jobs', async () => {
    const user = await createUser();
    await expect(asUser(user, (db) => db.query('select public.claim_notification_jobs(10, $1)', ['x']))).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    await expect(asAnon((db) => db.query('select public.claim_notification_jobs(10, $1)', ['x']))).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
  });
});

describe('Q7-2: withdrawing push consent always deletes the caller tokens', () => {
  it('no grant on record: tokens deleted, no ledger event, changed false; idempotent; others untouched', async () => {
    const p = await createPack(2);
    const [member, other] = p.memberIds;
    await legacyToken(member, 'a');
    await legacyToken(member, 'b');
    await registerToken(other, expoToken('other'));

    expect(await withdraw(member)).toMatchObject({ purpose: 'push_notifications', granted: false, changed: false });
    expect(await tokensOf(member)).toBe(0);
    expect(await ledgerOf(member)).toBe(0);
    expect(await withdraw(member)).toMatchObject({ granted: false, changed: false });
    expect(await ledgerOf(member)).toBe(0);
    expect(await tokensOf(other)).toBe(1);
  });

  it('already withdrawn and a token reappeared: deleted again, still one withdrawal event', async () => {
    const p = await createPack(1);
    const [member] = p.memberIds;
    await registerToken(member, expoToken('t'));
    expect(await withdraw(member)).toMatchObject({ changed: true });
    await legacyToken(member, 'back');
    expect(await withdraw(member)).toMatchObject({ changed: false });
    expect(await tokensOf(member)).toBe(0);
    expect(await countRows('consent_records', "user_id = $1 and purpose = 'push_notifications' and not granted", [member])).toBe(1);
  });

  it('another optional purpose without a grant leaves push tokens alone', async () => {
    const p = await createPack(1);
    const [member] = p.memberIds;
    await legacyToken(member, 'keep');
    await withdraw(member, 'workout_logs');
    expect(await tokensOf(member)).toBe(1);
  });

  it('unauthorized: anon cannot call it; a deleted account gets not_authenticated', async () => {
    await expect(asAnon((db) => db.query("select public.withdraw_consent('push_notifications')"))).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    const user = await createUser();
    await deleteMyAccount(user);
    await expect(withdraw(user)).rejects.toMatchObject(raised('not_authenticated'));
  });
});

describe('Q7-3: the daily purge prunes the export rate-limit log', () => {
  it('rows older than an hour go, newer rows stay, for every user; the rate limit still counts the last hour', async () => {
    const [a, b] = [await createUser(), await createUser()];
    await admin.query(
      `insert into private.data_export_log (user_id, requested_at)
       values ($1, now() - interval '5 days'), ($1, now() - interval '2 hours'), ($2, now() - interval '61 minutes'),
              ($1, now() - interval '10 minutes'), ($2, now() - interval '59 minutes')`,
      [a, b],
    );
    await purge();
    const { rows } = await admin.query<{ user_id: string; n: number }>(
      'select user_id, count(*)::int as n from private.data_export_log group by user_id',
    );
    expect(new Map(rows.map((r) => [r.user_id, r.n]))).toEqual(new Map([[a, 1], [b, 1]]));
    await purge();
    const again = await admin.query<{ n: number }>('select count(*)::int as n from private.data_export_log');
    expect(again.rows[0].n).toBe(2);

    // The kept row still counts towards the 10-per-hour limit.
    for (let i = 0; i < 9; i += 1) await exportMyData(a);
    await expect(exportMyData(a).catch(errorKey)).resolves.toBe('P0001:rate_limited');
  });

  it('the export README says "about a day"', async () => {
    const user = await createUser();
    const ex = await exportMyData(user);
    expect(ex.README).toContain('rate-limit records kept for about a day');
    expect(ex.README).not.toContain('at most a day');
  });

  it('unauthorized: authenticated cannot run the purge or reach the private helper', async () => {
    const user = await createUser();
    await expect(asUser(user, (db) => db.query('select public.purge_old_notification_data()'))).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    for (const fn of ['private.purge_old_data_export_log()', 'private.purge_stale_push_tokens()']) {
      await expect(asUser(user, (db) => db.query(`select ${fn}`))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(asService((db) => db.query(`select ${fn}`))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    }
  });
});

describe('Q7-4: the daily purge deletes stale push tokens', () => {
  it('invalidated > 30 days or not seen > 270 days: deleted; the rest stays; idempotent', async () => {
    const p = await createPack(1);
    const [member] = p.memberIds;
    await legacyToken(member, 'invalid-31', { invalidatedDaysAgo: 31 });
    await legacyToken(member, 'invalid-29', { invalidatedDaysAgo: 29 });
    await legacyToken(member, 'unseen-271', { lastSeenDaysAgo: 271 });
    await legacyToken(member, 'unseen-269', { lastSeenDaysAgo: 269 });
    await legacyToken(member, 'fresh');

    await purge();
    const kept = async () =>
      (await admin.query<{ token: string }>('select token from public.device_push_tokens where user_id = $1 order by token', [member])).rows.map(
        (r) => r.token,
      );
    expect(await kept()).toEqual([expoToken('fresh'), expoToken('invalid-29'), expoToken('unseen-269')].sort());
    await purge();
    expect(await kept()).toHaveLength(3);
  });

  it('a device that registers again after the purge is back (register refreshes last_seen_at)', async () => {
    const p = await createPack(1);
    const [member] = p.memberIds;
    await legacyToken(member, 'old-phone', { lastSeenDaysAgo: 300 });
    await purge();
    expect(await tokensOf(member)).toBe(0);
    await registerToken(member, expoToken('old-phone'));
    await purge();
    expect(await tokensOf(member)).toBe(1);
  });
});

describe('Q7-6: erasure clears free-text audit reasons', () => {
  it("reasons on rows about the erased member (even naming them) are cleared; other members' reasons stay", async () => {
    const { organizerId, memberIds, session } = await confirmedSession(2, 2);
    const [victim, stays] = memberIds;
    await recordAttendance(organizerId, session.id, victim, 'absent', 'Zed Zebra had the flu');
    await recordAttendance(organizerId, session.id, victim, 'present', 'Member 1 came late after all');
    await recordAttendance(organizerId, session.id, stays, 'absent', 'Away on holiday');
    const { rows: names } = await admin.query<{ display_name: string }>('select display_name from public.profiles where id = $1', [victim]);
    await recordAttendance(organizerId, session.id, stays, 'present', `Swapped with ${names[0].display_name}`);

    const summary = await deleteMyAccount(victim);
    expect(summary.attendance_changes_anonymized).toBe(2);

    const audit = await auditOf(session.id);
    const anonymous = audit.filter((r) => r.user_id === null);
    expect(anonymous).toHaveLength(2);
    expect(anonymous.every((r) => r.reason === null)).toBe(true);
    // Scope (documented in the contract): only rows about or by the erased user are cleared; a
    // reason on another member's row that mentions the erased person stays.
    expect(audit.filter((r) => r.user_id === stays).map((r) => r.reason)).toEqual([
      'Away on holiday',
      `Swapped with ${names[0].display_name}`,
    ]);
    // Statuses and actions of the anonymous trail are kept.
    expect(anonymous.map((r) => r.new_status)).toEqual(['absent', 'present']);
  });

  it('reasons on rows the erased organizer wrote are cleared; rows by the remaining organizer keep theirs', async () => {
    const pack = await packWithTwoOrganizers(2);
    const [m1, m2] = pack.memberIds;
    const session = await createTraining(pack.organizerId, pack.communityId, { min_participants: 1 });
    await setRsvp(m1, session.id, 'going');
    await setRsvp(m2, session.id, 'going');
    await makeDue(session.id);
    await finalize();
    await makeEnded(session.id);

    await recordAttendance(pack.secondOrganizerId, session.id, m1, 'absent', 'Second Organizer says: sick');
    await recordAttendance(pack.organizerId, session.id, m2, 'absent', 'Olga noted: travelling');

    await deleteMyAccount(pack.secondOrganizerId);

    const audit = await auditOf(session.id);
    const byM1 = audit.filter((r) => r.user_id === m1);
    expect(byM1).toHaveLength(1);
    expect(byM1[0]).toMatchObject({ changed_by: null, reason: null, new_status: 'absent' });
    expect(audit.filter((r) => r.user_id === m2)).toMatchObject([{ changed_by: pack.organizerId, reason: 'Olga noted: travelling' }]);
  });

  it('unauthorized: nobody can call the erasure directly or edit the audit log', async () => {
    const user = await createUser();
    await expect(asUser(user, (db) => db.query('select private.erase_user($1)', [user]))).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    await expect(asService((db) => db.query('select private.erase_user($1)', [user]))).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    await expect(asUser(user, (db) => db.query('update public.attendance_audit_log set reason = null where true'))).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
  });
});
