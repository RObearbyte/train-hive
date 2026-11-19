import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  buildFullLife,
  deleteMyAccount,
  exportMyData,
  goingCountMismatches,
  referencesTo,
  scannedColumns,
  snapshotTables,
  userForeignKeys,
  userNamedColumns,
} from './account-deletion-helpers';
import { attendanceSheet } from './attendance-helpers';
import { admin, asUser, closeDb, countRows, getSession, resetData, rpc } from './helpers';
import { errorKey } from './qa-helpers';

/**
 * GDPR G2: delete_my_account on a member with a full history (see buildFullLife). What must hold
 * afterwards: no row anywhere refers to the user; attendance survives anonymously so session-level
 * statistics are unchanged while per-member views no longer show the user; going counts stay
 * correct; nobody else's data changed; the user cannot act any more; and the export taken just
 * before lists exactly what the deletion removed or anonymized.
 */

beforeEach(resetData);
afterAll(closeDb);

type Stats = Record<string, unknown> & {
  trend: { period: string; sessions: number; present: number; average_attendees: number | null }[];
  top_sessions: { session_id: string; present: number; going_count: number }[];
};

const communityStats = (organizerId: string, communityId: string) =>
  asUser(organizerId, (db) => rpc<Stats>(db, 'get_community_statistics', [communityId, 'all']));
const summary = (organizerId: string, communityId: string) =>
  asUser(organizerId, (db) =>
    rpc<{ total_members: number; members: Record<string, unknown>[] }>(db, 'list_member_statistics_summary', [
      communityId,
      'all',
    ]),
  );
const memberStats = (organizerId: string, communityId: string, userId: string) =>
  asUser(organizerId, (db) => rpc<Record<string, unknown>>(db, 'get_member_statistics', [communityId, userId, 'all']));

/** Session-level numbers: every one must survive an account deletion unchanged. */
const SESSION_LEVEL = [
  'completed_trainings',
  'total_attendances',
  'average_attendees',
  'average_attendees_sessions',
  'incomplete_sessions',
  'rsvp_going_present',
  'rsvp_going_recorded',
  'rsvp_conversion',
  'cancelled_insufficient_participation',
  'cancelled_by_organizer',
];

function withoutVolatile(stats: Record<string, unknown>): Record<string, unknown> {
  const { generated_at: _g, to: _t, from: _f, ...rest } = stats;
  return rest;
}

describe('delete_my_account: nothing refers to the user afterwards', () => {
  it('a full-life member leaves no reference in public, private or auth', async () => {
    const life = await buildFullLife();
    const { victim } = life;

    // The scanner covers every foreign key to a user and every column named for a person.
    const scanned = new Set((await scannedColumns()).map((c) => `${c.schema}.${c.table}.${c.column}`));
    for (const ref of [...(await userForeignKeys()), ...(await userNamedColumns())]) {
      expect(scanned.has(ref), ref).toBe(true);
    }
    // ...and it finds the victim everywhere before the deletion (it is not blind).
    const before = await referencesTo(victim);
    for (const key of [
      'auth.users.id',
      'public.profiles.id',
      'public.memberships.user_id',
      'public.training_rsvps.user_id',
      'public.attendance_records.user_id',
      'public.attendance_records.recorded_by',
      'public.attendance_audit_log.user_id',
      'public.attendance_audit_log.changed_by',
      'public.notifications.user_id',
      'public.notification_delivery_jobs.user_id',
      'public.device_push_tokens.user_id',
      'public.notification_preferences.user_id',
      'public.announcement_reads.user_id',
      'public.announcements.author_id',
      'public.training_sessions.organizer_id',
      'public.training_sessions.cancelled_by',
      'public.training_sessions.attendance_finalized_by',
      'public.invitation_codes.created_by',
      'public.invitation_redemptions.user_id',
      'public.community_creator_redemptions.user_id',
      'public.consent_records.user_id',
      'public.invitation_attempts.user_id',
    ]) {
      expect(before[key], key).toBeGreaterThan(0);
    }
    const anonymousBefore = await countRows('attendance_records', 'user_id is null');
    const victimRecords = before['public.attendance_records.user_id'];
    const victimChanges = before['public.attendance_audit_log.user_id'];

    const result = await deleteMyAccount(victim);

    expect(result).toMatchObject({
      user_id: victim,
      communities_deleted: [life.delta.communityId],
      attendance_records_anonymized: victimRecords,
      attendance_changes_anonymized: victimChanges,
    });
    // alpha, beta, gamma (removed), delta (with the community), epsilon.
    expect(result.memberships_deleted).toBe(5);

    expect(await referencesTo(victim)).toEqual({});
    const { rows: auth } = await admin.query('select 1 from auth.users where id = $1', [victim]);
    expect(auth).toHaveLength(0);

    // Attendance about the victim survives without identity.
    expect(await countRows('attendance_records', 'user_id is null')).toBe(anonymousBefore + victimRecords);
    expect(await countRows('attendance_audit_log', 'user_id is null')).toBe(victimChanges);
    // Content the victim authored stays.
    expect(await countRows('announcements', 'id = $1 and author_id is null', [life.announcements.published])).toBe(1);
    expect((await getSession(life.sessions.s1.id)).organizer_id).toBeNull();
    expect((await getSession(life.sessions.s1.id)).attendance_finalized_by).toBeNull();
    expect((await getSession(life.sessions.s8.id)).cancelled_by).toBeNull();
    expect(await countRows('invitation_codes', 'id = $1 and created_by is null', [life.invitationCreatedByVictim])).toBe(1);
    // The sole-member community went with the account; the others stay.
    expect(await countRows('communities', 'id = $1', [life.delta.communityId])).toBe(0);
    for (const id of [life.alpha.communityId, life.beta.communityId, life.gamma.communityId, life.epsilon.communityId]) {
      expect(await countRows('communities', 'id = $1', [id])).toBe(1);
    }
    expect(await goingCountMismatches()).toEqual([]);
  });
});

describe('delete_my_account: statistics', () => {
  it('session-level community numbers are unchanged; per-member views drop the user', async () => {
    const life = await buildFullLife();
    const { victim, alpha, beta, sessions } = life;
    const o1 = alpha.organizerId;
    const [m1, m2] = alpha.memberIds;

    const alphaBefore = await communityStats(o1, alpha.communityId);
    const betaBefore = await communityStats(beta.organizerId, beta.communityId);
    const summaryBefore = await summary(o1, alpha.communityId);
    const m1Before = await memberStats(o1, alpha.communityId, m1);
    const sheetBefore = await attendanceSheet(o1, sessions.s1.id);
    const going = async (id: string) => (await getSession(id)).going_count;
    const goingBefore = {
      s1: await going(sessions.s1.id),
      s5: await going(sessions.s5.id),
      s7: await going(sessions.s7.id),
      s10: await going(sessions.s10.id),
    };

    // Fixture sanity (see buildFullLife): 4 completed trainings, 6 present marks in alpha.
    expect(alphaBefore).toMatchObject({
      completed_trainings: 4,
      total_attendances: 6,
      rsvp_going_present: 5,
      rsvp_going_recorded: 7,
      rsvp_going_total: 8,
      members_attended: 3,
      active_members: 4,
    });
    expect(goingBefore).toEqual({ s1: 3, s5: 2, s7: 2, s10: 1 });

    await deleteMyAccount(victim);

    const alphaAfter = await communityStats(o1, alpha.communityId);
    for (const key of SESSION_LEVEL) expect(alphaAfter[key], key).toEqual(alphaBefore[key]);
    expect(alphaAfter.trend).toEqual(alphaBefore.trend);
    expect(alphaAfter.top_sessions.map((t) => [t.session_id, t.present])).toEqual(
      alphaBefore.top_sessions.map((t) => [t.session_id, t.present]),
    );
    // Per-member numbers no longer include the victim.
    expect(alphaAfter.members_attended).toBe(2);
    expect(alphaAfter.active_members).toBe(3);
    // RSVP rows are deleted (going_count is the number of going rows): the victim's going RSVPs on
    // s1, s3 and s4 no longer count.
    expect(alphaAfter.rsvp_going_total).toBe(5);

    const betaAfter = await communityStats(beta.organizerId, beta.communityId);
    for (const key of SESSION_LEVEL) expect(betaAfter[key], key).toEqual(betaBefore[key]);
    expect(betaAfter.members_attended).toBe((betaBefore.members_attended as number) - 1);

    const summaryAfter = await summary(o1, alpha.communityId);
    expect(summaryAfter.total_members).toBe(summaryBefore.total_members - 1);
    expect(summaryAfter.members).toEqual(summaryBefore.members.filter((line) => line.user_id !== victim));
    expect(summaryAfter.members.some((line) => line.user_id === null)).toBe(false);

    expect(withoutVolatile(await memberStats(o1, alpha.communityId, m1))).toEqual(withoutVolatile(m1Before));
    await expect(memberStats(o1, alpha.communityId, victim).catch(errorKey)).resolves.toBe('P0001:not_found');

    // The sheet never lists an anonymous row as a member; it summarizes them.
    const sheetAfter = await attendanceSheet(o1, sessions.s1.id);
    expect(sheetAfter.entries).toEqual(sheetBefore.entries.filter((e) => e.user_id !== victim));
    expect(sheetAfter.entries.map((e) => e.user_id).sort()).toEqual([m1, m2].sort());
    expect((sheetAfter as unknown as { former_members: unknown }).former_members).toEqual({
      present: 1,
      absent: 0,
      unrecorded: 0,
    });
    expect((sheetBefore as unknown as { former_members: unknown }).former_members).toEqual({
      present: 0,
      absent: 0,
      unrecorded: 0,
    });

    // going_count: the open session released the RSVP, the decided ones uncounted the deleted row.
    expect(await goingCountMismatches()).toEqual([]);
    expect({
      s1: await going(sessions.s1.id),
      s5: await going(sessions.s5.id),
      s7: await going(sessions.s7.id),
      s10: await going(sessions.s10.id),
    }).toEqual({ s1: 2, s5: 1, s7: 1, s10: 0 });
    // Decided sessions keep their decision.
    expect((await getSession(sessions.s7.id)).status).toBe('confirmed');
  });
});

describe('delete_my_account: everybody else is untouched', () => {
  it('every row that did not refer to the user is unchanged, every changed row only lost the user', async () => {
    const life = await buildFullLife();
    const { victim } = life;
    const before = await snapshotTables();

    await deleteMyAccount(victim);
    const after = await snapshotTables();

    // Sessions: going_count is the one column that legitimately changes without referring to the
    // victim (checked against the real RSVP rows in the statistics test).
    const normalize = (table: string, row: string): string => {
      const parsed = JSON.parse(row) as Record<string, unknown>;
      if (table === 'public.training_sessions') delete parsed.going_count;
      return JSON.stringify(parsed);
    };
    // The victim's id becomes null wherever it was kept (anonymized / author columns).
    const anonymize = (row: string): string => {
      const parsed = JSON.parse(row) as Record<string, unknown>;
      for (const key of Object.keys(parsed)) if (parsed[key] === victim) parsed[key] = null;
      return JSON.stringify(parsed);
    };

    for (const [table, rows] of before) {
      const afterRows = new Set((after.get(table) ?? []).map((r) => normalize(table, r)));
      const allowed = new Set(rows.map((r) => normalize(table, anonymize(r))));
      for (const row of rows) {
        if (row.includes(victim) || row.includes(life.delta.communityId)) continue;
        expect(afterRows.has(normalize(table, row)), `${table} lost or changed ${row}`).toBe(true);
      }
      for (const row of afterRows) {
        expect(allowed.has(row), `${table} has an unexpected row ${row}`).toBe(true);
      }
    }
  });
});

describe('delete_my_account: export consistency', () => {
  it('the export taken before the deletion lists exactly what the deletion removes or anonymizes', async () => {
    const life = await buildFullLife();
    const { victim } = life;
    const ex = await exportMyData(victim);
    const refs = await referencesTo(victim);

    const { rows: self } = await admin.query<{ recorded: number; changed: number }>(
      `select (select count(*)::int from public.attendance_records where user_id = $1 and recorded_by = $1) as recorded,
              (select count(*)::int from public.attendance_audit_log where user_id = $1 and changed_by = $1) as changed`,
      [victim],
    );
    const expected: Record<string, number> = {
      'auth.users.id': ex.account ? 1 : 0,
      'public.profiles.id': ex.profile ? 1 : 0,
      'public.memberships.user_id': ex.memberships.length,
      'public.training_rsvps.user_id': ex.rsvps.length,
      'public.attendance_records.user_id': ex.attendance.length,
      'public.attendance_records.recorded_by': ex.authored.attendance_records_created_for_others + self[0].recorded,
      'public.attendance_audit_log.user_id': ex.attendance_changes.length,
      'public.attendance_audit_log.changed_by': ex.authored.attendance_changes_made_for_others + self[0].changed,
      'public.invitation_redemptions.user_id': ex.invitation_redemptions.length,
      'public.community_creator_redemptions.user_id': ex.creator_code_redemptions.length,
      'public.consent_records.user_id': ex.consents.length,
      'public.notifications.user_id': ex.notifications.length,
      'public.notification_delivery_jobs.user_id': ex.notifications.filter((n) => n.push_status !== null).length,
      'public.announcement_reads.user_id': ex.announcement_reads.length,
      'public.device_push_tokens.user_id': ex.push_devices.length,
      'public.notification_preferences.user_id': ex.notification_preferences ? 1 : 0,
      'public.announcements.author_id': ex.authored.announcements.length,
      'public.training_sessions.organizer_id': ex.authored.events_organized.length,
      'public.training_sessions.cancelled_by': ex.authored.events_cancelled,
      'public.training_sessions.attendance_finalized_by': ex.authored.events_attendance_finalized,
      'public.invitation_codes.created_by': ex.authored.invitation_codes.length,
      'public.invitation_attempts.user_id': ex.technical.invitation_attempts.length,
      'private.data_export_log.user_id': ex.technical.data_export_requests.length,
    };
    const nonZero = Object.fromEntries(Object.entries(expected).filter(([, n]) => n > 0));
    // Every place the database refers to the victim is a section of the export, with the same count.
    expect(refs).toEqual(nonZero);
    expect(Object.values(ex.truncated).every((t) => t === false)).toBe(true);

    await deleteMyAccount(victim);

    const ids = (items: Record<string, unknown>[], key: string) => items.map((i) => i[key] as string);
    const remaining = async (table: string, idList: string[], where = 'true') =>
      countRows(table, `id = any($1::uuid[]) and ${where}`, [idList]);

    // Deleted.
    expect(await remaining('memberships', ids(ex.memberships, 'membership_id'))).toBe(0);
    expect(await remaining('training_rsvps', ids(ex.rsvps, 'rsvp_id'))).toBe(0);
    expect(await remaining('invitation_redemptions', ids(ex.invitation_redemptions, 'redemption_id'))).toBe(0);
    expect(await remaining('community_creator_redemptions', ids(ex.creator_code_redemptions, 'redemption_id'))).toBe(0);
    expect(await remaining('consent_records', ids(ex.consents, 'event_id'))).toBe(0);
    expect(await remaining('notifications', ids(ex.notifications, 'notification_id'))).toBe(0);
    expect(await remaining('device_push_tokens', ids(ex.push_devices, 'device_id'))).toBe(0);
    // Anonymized: every listed row still exists, without the victim.
    const records = ids(ex.attendance, 'record_id');
    expect(await remaining('attendance_records', records, 'user_id is null')).toBe(records.length);
    const changes = ids(ex.attendance_changes, 'change_id');
    expect(await remaining('attendance_audit_log', changes, 'user_id is null')).toBe(changes.length);
    const announcements = ids(ex.authored.announcements, 'announcement_id');
    expect(await remaining('announcements', announcements, 'author_id is null')).toBe(announcements.length);
    const organized = ids(ex.authored.events_organized, 'session_id');
    expect(organized.length).toBeGreaterThan(0);
    // An organized session in delta went with the community; the others lost their organizer.
    expect(await remaining('training_sessions', organized, 'organizer_id is null')).toBe(organized.length);
    const codes = ids(ex.authored.invitation_codes, 'invitation_id');
    expect(await remaining('invitation_codes', codes, 'created_by is null')).toBe(codes.length);
  });
});

describe('delete_my_account: the deleted user cannot act any more', () => {
  it('every RPC answers with its own error (never a raw foreign-key error) for a still-valid JWT', async () => {
    const life = await buildFullLife();
    const { victim, alpha, sessions } = life;
    await deleteMyAccount(victim);

    const calls: [string, unknown[]][] = [
      ['select public.delete_my_account()', []],
      ['select public.export_my_data()', []],
      ['select public.my_deletion_blockers()', []],
      ['select public.record_consent($1)', ['age_16']],
      ['select public.withdraw_consent($1)', ['push_notifications']],
      ['select public.my_consents()', []],
      ['select public.set_rsvp($1, $2)', [sessions.s5.id, 'going']],
      ['select public.create_training($1, $2)', [alpha.communityId, '{}']],
      ['select public.update_training($1, $2)', [sessions.s5.id, '{}']],
      ['select public.cancel_training($1)', [sessions.s5.id]],
      ['select public.record_attendance($1, $2, $3)', [sessions.s1.id, alpha.memberIds[0], 'absent']],
      ['select public.add_walk_in_attendee($1, $2)', [sessions.s1.id, alpha.memberIds[0]]],
      ['select public.finalize_attendance($1)', [sessions.s1.id]],
      ['select public.get_attendance_sheet($1)', [sessions.s1.id]],
      ['select public.create_invitation($1)', [alpha.communityId]],
      ['select public.revoke_invitation($1)', [life.invitationCreatedByVictim]],
      ['select public.preview_invitation($1)', ['AAAAAAAA']],
      ['select public.redeem_invitation($1, $2)', ['AAAAAAAA', 'Ghost']],
      ['select public.preview_creator_code($1)', ['AAAAAAAA']],
      [
        'select public.create_community_with_code($1, $2, $3, $4, $5)',
        ['AAAAAAAA', 'Ghost Pack', 'UTC', 'Ghost', '00000000-0000-0000-0000-000000000009'],
      ],
      ['select public.update_display_name($1)', ['Ghost']],
      ['select public.update_community($1, $2, $3)', [alpha.communityId, 'Ghost', 'UTC']],
      ['select public.list_my_communities()', []],
      ['select public.create_announcement($1, $2, $3)', [alpha.communityId, 'Ghost', 'Boo']],
      ['select public.mark_announcement_read($1)', [life.announcements.readByVictim]],
      ['select public.mark_announcements_read($1)', [alpha.communityId]],
      ['select public.mark_all_notifications_read($1)', [alpha.communityId]],
      ['select public.register_push_token($1, $2)', ['ExponentPushToken[ghost]', 'android']],
      ['select public.unregister_push_token($1)', ['ExponentPushToken[victim-phone]']],
      ['select public.get_notification_preferences()', []],
      ['select public.set_notification_preferences($1)', [false]],
      ['select public.get_my_statistics($1, $2)', [alpha.communityId, 'all']],
      ['select public.get_community_statistics($1, $2)', [alpha.communityId, 'all']],
      ['select public.set_member_role($1, $2, $3)', [alpha.communityId, alpha.memberIds[0], 'organizer']],
      ['select public.remove_member($1, $2)', [alpha.communityId, alpha.memberIds[0]]],
      ['select public.leave_community($1)', [alpha.communityId]],
    ];

    const outcomes: Record<string, string> = {};
    for (const [sql, params] of calls) {
      outcomes[sql] = await asUser(victim, (db) => db.query(sql, params)).then(
        (r) => `ok:${JSON.stringify(r.rows[0])}`,
        errorKey,
      );
    }
    for (const [sql, outcome] of Object.entries(outcomes)) {
      // Only the functions' own business errors: no 23503 (foreign key), no 42501 (privilege).
      expect(outcome, sql).toMatch(/^(ok:|P0001:)/);
      expect(outcome, sql).not.toContain('23503');
    }
    expect(outcomes['select public.delete_my_account()']).toBe('P0001:not_authenticated');
    expect(outcomes['select public.export_my_data()']).toBe('P0001:not_authenticated');
    expect(outcomes['select public.my_deletion_blockers()']).toBe('P0001:not_authenticated');
    expect(outcomes['select public.record_consent($1)']).toBe('P0001:not_authenticated');
    expect(outcomes['select public.set_rsvp($1, $2)']).toBe('P0001:not_a_member');
    expect(outcomes['select public.leave_community($1)']).toBe('P0001:not_a_member');
    expect(outcomes['select public.set_member_role($1, $2, $3)']).toBe('P0001:forbidden');
    expect(outcomes['select public.redeem_invitation($1, $2)']).toContain('not_authenticated');
    expect(outcomes['select public.list_my_communities()']).toBe('ok:{"list_my_communities":[]}');

    // And nothing it tried left a row behind.
    expect(await referencesTo(victim)).toEqual({});
  });
});
