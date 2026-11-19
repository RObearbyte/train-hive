import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { buildFullLife, exportMyData } from './account-deletion-helpers';
import { confirmedSession, recordAttendance } from './attendance-helpers';
import { asNobody } from './creator-codes-helpers';
import { admin, asAnon, asService, closeDb, createPack, createUser, INSUFFICIENT_PRIVILEGE, resetData } from './helpers';
import { errorKey } from './qa-helpers';

/**
 * GDPR G2: export_my_data ("Download my data"). It holds every personal record of the caller
 * (the exact match with what deletion removes is in account-deletion.test.ts) and nothing about
 * anyone else; it is rate limited, capped and only callable by the signed-in user.
 */

beforeEach(resetData);
afterAll(closeDb);

describe('export_my_data: content', () => {
  it('a full-life member gets every section of their own data', async () => {
    const life = await buildFullLife();
    const ex = await exportMyData(life.victim);

    expect(ex.format_version).toBe(1);
    expect(typeof ex.README).toBe('string');
    expect(ex.README.length).toBeGreaterThan(100);
    expect(ex.extensions).toEqual({});
    expect(ex.account).toMatchObject({ user_id: life.victim, is_anonymous: true });
    expect(ex.profile).toMatchObject({ display_name: 'Victor Victim' });

    expect(ex.memberships.map((m) => [m.community_id, m.role, m.status]).sort()).toEqual(
      [
        [life.alpha.communityId, 'organizer', 'active'],
        [life.beta.communityId, 'member', 'active'],
        [life.gamma.communityId, 'member', 'removed'],
        [life.delta.communityId, 'organizer', 'active'],
        [life.epsilon.communityId, 'organizer', 'active'],
      ].sort(),
    );
    const { s1, s2, s3, s4, s5, s6, s7, s9, s10 } = life.sessions;
    expect(ex.rsvps.map((r) => `${r.session_id}:${r.response}`).sort()).toEqual(
      [s1, s3, s4, s5, s7, s9, s10].map((s) => `${s.id}:going`).concat(`${s6.id}:not_going`).sort(),
    );
    expect(ex.attendance.map((a) => `${a.session_id}:${a.status}:${a.is_walk_in}`).sort()).toEqual(
      [`${s1.id}:present:false`, `${s2.id}:present:true`, `${s3.id}:absent:false`, `${s4.id}:unrecorded:false`, `${s9.id}:present:false`].sort(),
    );
    // Changes to the victim's attendance, by an organizer (never named).
    expect(ex.attendance_changes.map((c) => `${c.session_id}:${c.old_status}>${c.new_status}:${c.changed_by}`).sort()).toEqual(
      [
        `${s1.id}:unrecorded>absent:an organizer`,
        `${s1.id}:absent>present:an organizer`,
        `${s2.id}:unrecorded>present:an organizer`,
        `${s3.id}:unrecorded>absent:an organizer`,
        `${s9.id}:unrecorded>present:an organizer`,
      ].sort(),
    );
    expect(ex.attendance_changes.find((c) => c.new_status === 'present' && c.session_id === s1.id)?.reason).toBe(
      'Arrived late',
    );
    expect(ex.invitation_redemptions.map((r) => r.community_id).sort()).toEqual(
      [life.alpha.communityId, life.beta.communityId, life.gamma.communityId].sort(),
    );
    expect(ex.creator_code_redemptions.map((c) => c.community_id).sort()).toEqual(
      [life.delta.communityId, life.epsilon.communityId].sort(),
    );
    expect(ex.consents.map((c) => `${c.purpose}:${c.granted}`)).toEqual([
      'terms_privacy:true',
      'age_16:true',
      'push_notifications:true',
      'workout_logs:true',
      'workout_logs:false',
    ]);
    expect(ex.notification_preferences).toMatchObject({ push_enabled: true, training_reminders: false });
    expect(ex.notifications.length).toBeGreaterThan(5);
    expect(ex.notifications.every((n) => n.push_status !== undefined)).toBe(true);
    expect(ex.announcement_reads.map((r) => r.announcement_id)).toEqual([life.announcements.readByVictim]);
    expect(ex.push_devices.map((d) => [d.platform, d.device_label]).sort()).toEqual([
      ['android', 'Phone'],
      ['ios', 'Tablet'],
    ]);
    expect(ex.authored.announcements.map((a) => a.announcement_id).sort()).toEqual(
      [life.announcements.published, life.announcements.scheduled].sort(),
    );
    expect(ex.authored.events_organized.map((e) => e.session_id)).toEqual([s1.id]);
    expect(ex.authored.invitation_codes.map((c) => c.invitation_id)).toContain(life.invitationCreatedByVictim);
    expect(ex.authored).toMatchObject({
      events_cancelled: 1,
      events_attendance_finalized: 1,
      attendance_records_created_for_others: 2,
      attendance_changes_made_for_others: 2,
    });
    // Three successful joins, two creator codes, one failed preview.
    expect(ex.technical.invitation_attempts.map((a) => a.success)).toEqual([true, true, true, true, true, false]);
    expect(ex.technical.data_export_requests).toHaveLength(1);
    expect(Object.values(ex.truncated).every((t) => t === false)).toBe(true);
  });

  it('holds nothing about anyone else: no other user id, display name or push token value', async () => {
    const life = await buildFullLife();
    const ex = await exportMyData(life.victim);
    const text = JSON.stringify(ex);

    const { rows: others } = await admin.query<{ id: string }>('select id from auth.users where id <> $1', [life.victim]);
    expect(others.length).toBeGreaterThan(5);
    for (const { id } of others) expect(text.includes(id), id).toBe(false);

    const { rows: names } = await admin.query<{ display_name: string }>(
      'select display_name from public.profiles where id <> $1',
      [life.victim],
    );
    for (const { display_name } of names) expect(text.includes(display_name), display_name).toBe(false);

    const { rows: tokens } = await admin.query<{ token: string }>('select token from public.device_push_tokens');
    for (const { token } of tokens) expect(text.includes(token)).toBe(false);
    expect(text.includes('ExponentPushToken')).toBe(false);
  });

  it("another member's export of the same community holds only their own rows", async () => {
    const life = await buildFullLife();
    const m1 = life.alpha.memberIds[0];
    const ex = await exportMyData(m1);
    expect(JSON.stringify(ex).includes(life.victim)).toBe(false);
    expect(ex.memberships.map((m) => m.community_id)).toEqual([life.alpha.communityId]);
    // m1 was marked by the victim on s1: the change is listed, the author is not named.
    expect(ex.attendance_changes.map((c) => c.changed_by)).toEqual(
      expect.arrayContaining(['an organizer']),
    );
    expect(ex.authored.attendance_records_created_for_others).toBe(0);
  });

  it('an organizer who marked themselves sees "you" as the author', async () => {
    const { organizerId, session } = await confirmedSession(0, 0);
    await recordAttendance(organizerId, session.id, organizerId, 'present');
    const ex = await exportMyData(organizerId);
    expect(ex.attendance_changes.map((c) => c.changed_by)).toEqual(['you']);
    // Their own record is not "for others".
    expect(ex.authored.attendance_records_created_for_others).toBe(0);
    expect(ex.authored.attendance_changes_made_for_others).toBe(0);
  });

  it('a user without a profile gets the account and the consents, empty lists elsewhere', async () => {
    const userId = await createUser();
    const ex = await exportMyData(userId);
    expect(ex.account).toMatchObject({ user_id: userId });
    expect(ex.profile).toBeNull();
    expect(ex.notification_preferences).toBeNull();
    expect(ex.memberships).toEqual([]);
    expect(ex.consents.map((c) => c.purpose)).toEqual(['terms_privacy', 'age_16']);
  });

  it('caps each list at 5000 items and says so', async () => {
    const { communityId, memberIds } = await createPack(1);
    const session = await admin.query<{ id: string }>(
      `insert into public.training_sessions (community_id, title, starts_at, rsvp_deadline, timezone, location_name, min_participants)
       values ($1, 'Cap', now() + interval '3 days', now() + interval '2 days', 'UTC', 'Park', 1) returning id`,
      [communityId],
    );
    await admin.query(
      `insert into public.notifications (user_id, community_id, kind, title, body, deep_link, related_session_id, dedupe_key)
       select $1, $2, 'training_created', 'T', 'B', '/trainings/' || $3::text, $3::uuid, 'cap:' || g
       from generate_series(1, 5001) g`,
      [memberIds[0], communityId, session.rows[0].id],
    );
    const ex = await exportMyData(memberIds[0]);
    expect(ex.notifications).toHaveLength(5000);
    expect(ex.truncated.notifications).toBe(true);
    expect(ex.truncated.memberships).toBe(false);
  });
});

describe('export_my_data: rate limit and access', () => {
  it('allows 10 exports per rolling hour, then rate_limited; older ones stop counting', async () => {
    const { memberIds } = await createPack(1);
    const user = memberIds[0];
    for (let i = 0; i < 10; i += 1) await exportMyData(user);
    await expect(exportMyData(user).catch(errorKey)).resolves.toBe('P0001:rate_limited');
    // A refused call records nothing.
    const { rows } = await admin.query<{ n: number }>(
      'select count(*)::int as n from private.data_export_log where user_id = $1',
      [user],
    );
    expect(rows[0].n).toBe(10);

    await admin.query(
      "update private.data_export_log set requested_at = requested_at - interval '61 minutes' where user_id = $1",
      [user],
    );
    await expect(exportMyData(user)).resolves.toMatchObject({ format_version: 1 });
    // The stale rows were pruned by that call.
    const { rows: left } = await admin.query<{ n: number }>(
      'select count(*)::int as n from private.data_export_log where user_id = $1',
      [user],
    );
    expect(left[0].n).toBe(1);
  });

  it('concurrent exports never exceed the limit', async () => {
    const { memberIds } = await createPack(1);
    const results = await Promise.all(
      Array.from({ length: 16 }, () => exportMyData(memberIds[0]).then(() => 'ok', errorKey)),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(10);
    expect(results.filter((r) => r === 'P0001:rate_limited')).toHaveLength(6);
  });

  it('only the signed-in user: anon and service_role have no execute, a JWT without a user is refused', async () => {
    await expect(asAnon((db) => db.query('select public.export_my_data()')).catch((e: { code: string }) => e.code)).resolves.toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    await expect(
      asService((db) => db.query('select public.export_my_data()')).catch((e: { code: string }) => e.code),
    ).resolves.toBe(INSUFFICIENT_PRIVILEGE);
    await expect(asNobody((db) => db.query('select public.export_my_data()')).catch(errorKey)).resolves.toBe(
      'P0001:not_authenticated',
    );
    const ghost = await createUser();
    await admin.query('delete from auth.users where id = $1', [ghost]);
    await expect(exportMyData(ghost).catch(errorKey)).resolves.toBe('P0001:not_authenticated');
  });
});
