import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addMember,
  admin,
  asUser,
  cancelTraining,
  closeDb,
  countRows,
  createPack,
  createTraining,
  getSession,
  resetData,
  setRsvp,
  updateTraining,
} from './helpers';
import {
  addWalkIn,
  attendanceSheet,
  auditOf,
  confirmedSession,
  finalizeAttendance,
  makeEnded,
  recordAttendance,
  recordsOf,
} from './attendance-helpers';
import { formOf, raised } from './qa-helpers';

beforeEach(resetData);
afterAll(closeDb);

describe('record_attendance', () => {
  it('creates a record for a going member, snapshots the RSVP and writes a `record` audit row', async () => {
    const { organizerId, memberIds, session, communityId } = await confirmedSession(2, 2);
    const before = Date.now();

    const record = await recordAttendance(organizerId, session.id, memberIds[0], 'present');

    expect(record).toMatchObject({
      session_id: session.id,
      community_id: communityId,
      user_id: memberIds[0],
      status: 'present',
      recorded_by: organizerId,
      had_rsvp_going: true,
      is_walk_in: false,
    });
    expect(record.recorded_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const audit = await auditOf(session.id);
    expect(audit).toEqual([
      expect.objectContaining({
        user_id: memberIds[0],
        community_id: communityId,
        changed_by: organizerId,
        old_status: 'unrecorded',
        new_status: 'present',
        action: 'record',
        reason: null,
      }),
    ]);
    expect(audit[0].changed_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('a change before finalization is a `correct` with old and new status; repeating a status writes nothing', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1);
    const m = memberIds[0];

    await recordAttendance(organizerId, session.id, m, 'present');
    const again = await recordAttendance(organizerId, session.id, m, 'present');
    expect(again.status).toBe('present');
    expect(await auditOf(session.id)).toHaveLength(1);

    const corrected = await recordAttendance(organizerId, session.id, m, 'absent', '  Left before warm-up  ');
    expect(corrected.status).toBe('absent');
    expect(corrected.id).toBe(again.id);
    expect(corrected.updated_at.getTime()).toBeGreaterThanOrEqual(again.updated_at.getTime());

    const audit = await auditOf(session.id);
    expect(audit.map((a) => [a.action, a.old_status, a.new_status, a.reason])).toEqual([
      ['record', 'unrecorded', 'present', null],
      ['correct', 'present', 'absent', 'Left before warm-up'],
    ]);
    expect(await countRows('attendance_records', 'session_id = $1', [session.id])).toBe(1);
  });

  it('setting unrecorded clears a mark (audited), and is not the same as absent', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(2, 2);
    await recordAttendance(organizerId, session.id, memberIds[0], 'absent');
    const cleared = await recordAttendance(organizerId, session.id, memberIds[0], 'unrecorded');
    expect(cleared.status).toBe('unrecorded');

    // A member who was never marked is unrecorded too, and creating that row is not a change.
    const untouched = await recordAttendance(organizerId, session.id, memberIds[1], 'unrecorded');
    expect(untouched).toMatchObject({ status: 'unrecorded', had_rsvp_going: true });

    const audit = await auditOf(session.id);
    expect(audit.map((a) => [a.user_id, a.old_status, a.new_status, a.action])).toEqual([
      [memberIds[0], 'unrecorded', 'absent', 'record'],
      [memberIds[0], 'absent', 'unrecorded', 'correct'],
    ]);
    expect(await countRows('attendance_records', "status = 'absent'")).toBe(0);
    expect(await countRows('attendance_records', "status = 'unrecorded'")).toBe(2);
  });

  it('first mark after clearing is still a correction (the member already has history)', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1);
    await recordAttendance(organizerId, session.id, memberIds[0], 'present');
    await recordAttendance(organizerId, session.id, memberIds[0], 'unrecorded');
    await recordAttendance(organizerId, session.id, memberIds[0], 'absent');
    expect((await auditOf(session.id)).map((a) => a.action)).toEqual(['record', 'correct', 'correct']);
  });

  it('rejects a member without a going RSVP (they are added as walk-ins) and writes nothing', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(3, 1);
    // memberIds[1] never answered; memberIds[2] said no (RSVPs are closed now, so arrange it).
    await admin.query(
      "insert into public.training_rsvps (session_id, community_id, user_id, response) values ($1, $2, $3, 'not_going')",
      [session.id, session.community_id, memberIds[2]],
    );
    for (const m of [memberIds[1], memberIds[2]]) {
      await expect(recordAttendance(organizerId, session.id, m, 'present')).rejects.toMatchObject(
        raised('no_going_rsvp'),
      );
    }
    expect(await recordsOf(session.id)).toEqual([]);
    expect(await auditOf(session.id)).toEqual([]);
  });

  it('rejects null and malformed input', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1);
    await expect(recordAttendance(organizerId, session.id, memberIds[0], null as never)).rejects.toMatchObject(
      raised('validation_failed:status'),
    );
    await expect(recordAttendance(organizerId, session.id, null as never, 'present')).rejects.toMatchObject(
      raised('validation_failed:user_id'),
    );
    await expect(
      recordAttendance(organizerId, session.id, memberIds[0], 'present', 'x'.repeat(201)),
    ).rejects.toMatchObject(raised('validation_failed:reason'));
    await expect(recordAttendance(organizerId, session.id, memberIds[0], 'late' as never)).rejects.toMatchObject({
      code: '22P02',
    });
    // A blank reason is stored as null.
    await recordAttendance(organizerId, session.id, memberIds[0], 'present', '   ');
    expect((await auditOf(session.id))[0].reason).toBeNull();
    await expect(
      recordAttendance(organizerId, '00000000-0000-4000-8000-000000000000', memberIds[0], 'present'),
    ).rejects.toMatchObject(raised('not_found'));
  });

  it('rejects an attendee who is not a member, and one who is a member of another community', async () => {
    const { organizerId, session } = await confirmedSession(1, 1);
    const other = await createPack(1);
    const stranger = other.memberIds[0];
    await expect(recordAttendance(organizerId, session.id, stranger, 'present')).rejects.toMatchObject(
      raised('attendee_not_a_member'),
    );
    await expect(
      recordAttendance(organizerId, session.id, '00000000-0000-4000-8000-000000000000', 'present'),
    ).rejects.toMatchObject(raised('attendee_not_a_member'));
    expect(await recordsOf(session.id)).toEqual([]);
  });

  it('an organizer can record their own attendance when they RSVP\'d going', async () => {
    const { organizerId, session } = await confirmedSession(0, 0);
    const record = await recordAttendance(organizerId, session.id, organizerId, 'present');
    expect(record).toMatchObject({ user_id: organizerId, recorded_by: organizerId, had_rsvp_going: true });
  });
});

describe('when attendance can be taken', () => {
  it('not before the session has ended, by the server clock (ends_at, else starts_at)', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1, { ended: false });
    const m = memberIds[0];
    const notEnded = raised('session_not_ended');

    await expect(recordAttendance(organizerId, session.id, m, 'present')).rejects.toMatchObject(notEnded);
    await expect(addWalkIn(organizerId, session.id, organizerId)).rejects.toMatchObject(notEnded);
    await expect(finalizeAttendance(organizerId, session.id)).rejects.toMatchObject(notEnded);

    // Started but not ended yet.
    await admin.query(
      `update public.training_sessions set rsvp_deadline = now() - interval '2 hours',
         starts_at = now() - interval '1 hour', ends_at = now() + interval '1 hour' where id = $1`,
      [session.id],
    );
    await expect(recordAttendance(organizerId, session.id, m, 'present')).rejects.toMatchObject(notEnded);
    await expect(finalizeAttendance(organizerId, session.id)).rejects.toMatchObject(notEnded);

    // No end time: the start counts.
    await admin.query(
      `update public.training_sessions set ends_at = null, starts_at = now() + interval '10 minutes',
         rsvp_deadline = now() - interval '2 hours' where id = $1`,
      [session.id],
    );
    await expect(recordAttendance(organizerId, session.id, m, 'present')).rejects.toMatchObject(notEnded);
    await makeEnded(session.id, { withEnd: false });
    expect((await recordAttendance(organizerId, session.id, m, 'present')).status).toBe('present');

    expect(await countRows('attendance_audit_log')).toBe(1);
    expect((await getSession(session.id)).status).toBe('confirmed');
  });

  it('never on a scheduled or cancelled session, even after its end', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const scheduled = await createTraining(organizerId, communityId, { min_participants: 1 });
    await setRsvp(memberIds[0], scheduled.id, 'going');
    await makeEnded(scheduled.id); // finalizer never ran: still `scheduled`

    const cancelled = await createTraining(organizerId, communityId, { min_participants: 1 });
    await setRsvp(memberIds[0], cancelled.id, 'going');
    await cancelTraining(organizerId, cancelled.id);
    await makeEnded(cancelled.id);

    for (const session of [scheduled, cancelled]) {
      const notConfirmed = raised('session_not_confirmed');
      await expect(recordAttendance(organizerId, session.id, memberIds[0], 'present')).rejects.toMatchObject(notConfirmed);
      await expect(addWalkIn(organizerId, session.id, organizerId)).rejects.toMatchObject(notConfirmed);
      await expect(finalizeAttendance(organizerId, session.id)).rejects.toMatchObject(notConfirmed);
    }
    expect(await countRows('attendance_records')).toBe(0);
    expect(await countRows('attendance_audit_log')).toBe(0);
    expect((await getSession(cancelled.id)).status).toBe('cancelled');
    expect((await getSession(scheduled.id)).status).toBe('scheduled');
  });

  it('a session cancelled for insufficient participation cannot take attendance', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const session = await createTraining(organizerId, communityId, { min_participants: 2 });
    await setRsvp(memberIds[0], session.id, 'going');
    await admin.query("update public.training_sessions set rsvp_deadline = now() - interval '1 second' where id = $1", [session.id]);
    await admin.query('select public.finalize_due_sessions()');
    expect((await getSession(session.id)).cancel_reason).toBe('insufficient_participation');
    await makeEnded(session.id);
    await expect(recordAttendance(organizerId, session.id, memberIds[0], 'present')).rejects.toMatchObject(
      raised('session_not_confirmed'),
    );
  });

  it('a confirmed session that has ended stays confirmed until an organizer finalizes', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1);
    await recordAttendance(organizerId, session.id, memberIds[0], 'present');
    await admin.query('select public.finalize_due_sessions()');
    expect(await getSession(session.id)).toMatchObject({
      status: 'confirmed',
      attendance_finalized_at: null,
      attendance_finalized_by: null,
    });
  });
});

describe('add_walk_in_attendee', () => {
  it('adds an active member without a going RSVP as present, walk-in, audited as walk_in_add', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(2, 1);
    const walkIn = memberIds[1];

    const record = await addWalkIn(organizerId, session.id, walkIn);
    expect(record).toMatchObject({
      user_id: walkIn,
      status: 'present',
      is_walk_in: true,
      had_rsvp_going: false,
      recorded_by: organizerId,
    });
    expect(await auditOf(session.id)).toEqual([
      expect.objectContaining({
        user_id: walkIn,
        changed_by: organizerId,
        old_status: 'unrecorded',
        new_status: 'present',
        action: 'walk_in_add',
      }),
    ]);
  });

  it('returns an existing record unchanged and writes nothing', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(2, 1);
    const first = await addWalkIn(organizerId, session.id, memberIds[1]);
    await recordAttendance(organizerId, session.id, memberIds[1], 'absent');
    const again = await addWalkIn(organizerId, session.id, memberIds[1]);
    expect(again).toMatchObject({ id: first.id, status: 'absent', is_walk_in: true });

    // Also for a going member who already has a record.
    const going = await recordAttendance(organizerId, session.id, memberIds[0], 'absent');
    expect(await addWalkIn(organizerId, session.id, memberIds[0])).toEqual(going);

    expect((await auditOf(session.id)).map((a) => a.action)).toEqual(['walk_in_add', 'correct', 'record']);
  });

  it('refuses a member with a going RSVP and no record, and non-members', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1);
    await expect(addWalkIn(organizerId, session.id, memberIds[0])).rejects.toMatchObject(
      raised('attendee_has_going_rsvp'),
    );
    const outsider = (await createPack(1)).memberIds[0];
    await expect(addWalkIn(organizerId, session.id, outsider)).rejects.toMatchObject(raised('attendee_not_a_member'));
    await expect(addWalkIn(organizerId, session.id, null as never)).rejects.toMatchObject(
      raised('validation_failed:user_id'),
    );
    expect(await countRows('attendance_records')).toBe(0);
  });

  it('a walk-in can be corrected like any record', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(2, 1);
    await addWalkIn(organizerId, session.id, memberIds[1]);
    const fixed = await recordAttendance(organizerId, session.id, memberIds[1], 'unrecorded', 'Wrong person');
    expect(fixed).toMatchObject({ status: 'unrecorded', is_walk_in: true });
  });
});

describe('finalize_attendance', () => {
  it('completes the session, stamps who and when, and lists every going member (unrecorded stays unrecorded)', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(4, 3);
    const [present, absent, unmarked, walkIn] = memberIds;
    await recordAttendance(organizerId, session.id, present, 'present');
    await recordAttendance(organizerId, session.id, absent, 'absent');
    await addWalkIn(organizerId, session.id, walkIn);
    const auditBefore = await auditOf(session.id);
    const confirmedRow = await getSession(session.id);
    const before = Date.now();

    const finalized = await finalizeAttendance(organizerId, session.id);

    expect(finalized).toMatchObject({ id: session.id, status: 'completed', attendance_finalized_by: organizerId });
    expect(finalized.attendance_finalized_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const records = new Map((await recordsOf(session.id)).map((r) => [r.user_id, r]));
    expect(records.size).toBe(4);
    expect(records.get(present)!.status).toBe('present');
    expect(records.get(absent)!.status).toBe('absent');
    expect(records.get(unmarked)).toMatchObject({ status: 'unrecorded', had_rsvp_going: true, is_walk_in: false, recorded_by: organizerId });
    expect(records.get(walkIn)).toMatchObject({ status: 'present', is_walk_in: true });
    // Placeholder rows are not changes.
    expect(await auditOf(session.id)).toEqual(auditBefore);
    // Other session fields are untouched.
    const row = await getSession(session.id);
    expect(row).toMatchObject({ going_count: 3, cancel_reason: null, decided_at: confirmedRow.decided_at });
  });

  it('is idempotent: a second call returns the completed session unchanged and adds nothing', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(2, 2);
    const second = await addMember(session.community_id, { role: 'organizer', name: 'Second Organizer' });
    const first = await finalizeAttendance(organizerId, session.id);
    const records = await recordsOf(session.id);

    const again = await finalizeAttendance(second, session.id);
    expect(again).toEqual(first);
    expect(await recordsOf(session.id)).toEqual(records);
    expect(records.map((r) => r.user_id).sort()).toEqual([...memberIds].sort());
  });

  it('does not create rows for going members who were removed, and keeps rows already there', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(2, 2);
    await recordAttendance(organizerId, session.id, memberIds[0], 'present');
    await admin.query("update public.memberships set status = 'removed' where user_id = any($1)", [memberIds]);
    await finalizeAttendance(organizerId, session.id);
    const records = await recordsOf(session.id);
    expect(records.map((r) => [r.user_id, r.status])).toEqual([[memberIds[0], 'present']]);
  });

  it('a completed session can be neither edited nor cancelled', async () => {
    const { organizerId, session } = await confirmedSession(1, 1);
    const completed = await finalizeAttendance(organizerId, session.id);
    await expect(updateTraining(organizerId, session.id, formOf(completed, { title: 'Renamed' }))).rejects.toMatchObject(
      raised('session_not_editable'),
    );
    await expect(cancelTraining(organizerId, session.id)).rejects.toMatchObject(raised('session_not_cancellable'));
    expect(await getSession(session.id)).toEqual(completed);
  });

  it('the finalizer job leaves a completed session alone', async () => {
    const { organizerId, session } = await confirmedSession(1, 1);
    const completed = await finalizeAttendance(organizerId, session.id);
    await admin.query('select public.finalize_due_sessions()');
    expect(await getSession(session.id)).toEqual(completed);
  });

  it('completed always carries attendance_finalized_at (table check)', async () => {
    const { session } = await confirmedSession(1, 1);
    await expect(
      admin.query("update public.training_sessions set status = 'completed' where id = $1", [session.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query('update public.training_sessions set attendance_finalized_at = now() where id = $1', [session.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('corrections after finalization', () => {
  it('are allowed and audited with who, when, old and new status', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(3, 2);
    const second = await addMember(session.community_id, { role: 'organizer', name: 'Second Organizer' });
    await recordAttendance(organizerId, session.id, memberIds[0], 'present');
    await finalizeAttendance(organizerId, session.id);
    const before = Date.now();

    await recordAttendance(second, session.id, memberIds[0], 'absent', 'Checked the photos');
    await recordAttendance(second, session.id, memberIds[1], 'present'); // placeholder row
    await addWalkIn(second, session.id, memberIds[2]);
    // Repeating a status after finalization is still a no-op.
    await recordAttendance(second, session.id, memberIds[1], 'present');

    const after = (await auditOf(session.id)).slice(1);
    expect(after.map((a) => [a.user_id, a.changed_by, a.old_status, a.new_status, a.action, a.reason])).toEqual([
      [memberIds[0], second, 'present', 'absent', 'correct', 'Checked the photos'],
      [memberIds[1], second, 'unrecorded', 'present', 'correct', null],
      [memberIds[2], second, 'unrecorded', 'present', 'walk_in_add', null],
    ]);
    for (const a of after) expect(a.changed_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect((await getSession(session.id)).status).toBe('completed');
  });
});

describe('removed members', () => {
  it('keep their records and audit rows; existing records stay correctable; no new records', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(3, 3);
    const [marked, unmarked, walkInCandidate] = memberIds;
    await recordAttendance(organizerId, session.id, marked, 'present');
    await admin.query("update public.memberships set status = 'removed' where user_id = any($1)", [memberIds]);

    expect(await recordsOf(session.id)).toHaveLength(1);
    expect(await auditOf(session.id)).toHaveLength(1);

    const corrected = await recordAttendance(organizerId, session.id, marked, 'absent');
    expect(corrected.status).toBe('absent');
    await expect(recordAttendance(organizerId, session.id, unmarked, 'present')).rejects.toMatchObject(
      raised('attendee_not_a_member'),
    );
    await expect(addWalkIn(organizerId, session.id, walkInCandidate)).rejects.toMatchObject(
      raised('attendee_not_a_member'),
    );
    // add_walk_in on the removed member's existing record returns it (idempotent), unchanged.
    expect(await addWalkIn(organizerId, session.id, marked)).toEqual(corrected);
    expect((await auditOf(session.id)).map((a) => a.action)).toEqual(['record', 'correct']);
  });

  it('a removed member sees nothing, a re-activated member sees their history again', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1);
    await recordAttendance(organizerId, session.id, memberIds[0], 'present');
    const visible = () =>
      asUser(memberIds[0], async (db) => (await db.query('select id from public.attendance_records')).rows.length);
    expect(await visible()).toBe(1);
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [memberIds[0]]);
    expect(await visible()).toBe(0);
    await admin.query("update public.memberships set status = 'active' where user_id = $1", [memberIds[0]]);
    expect(await visible()).toBe(1);
  });
});

describe('database guarantees', () => {
  it('a member has at most one record per session (unique constraint)', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1);
    const record = await recordAttendance(organizerId, session.id, memberIds[0], 'present');
    await expect(
      admin.query(
        `insert into public.attendance_records (session_id, community_id, user_id, status, had_rsvp_going)
         values ($1, $2, $3, 'absent', true)`,
        [session.id, record.community_id, memberIds[0]],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('community_id must be the session\'s community; a record is either going or walk-in', async () => {
    const { memberIds, session } = await confirmedSession(1, 1);
    const other = await createPack();
    await expect(
      admin.query(
        `insert into public.attendance_records (session_id, community_id, user_id, had_rsvp_going) values ($1, $2, $3, true)`,
        [session.id, other.communityId, memberIds[0]],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      admin.query(
        `insert into public.attendance_audit_log (session_id, community_id, user_id, old_status, new_status, action)
         values ($1, $2, $3, 'unrecorded', 'present', 'record')`,
        [session.id, other.communityId, memberIds[0]],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    for (const [going, walkIn] of [
      [true, true],
      [false, false],
    ]) {
      await expect(
        admin.query(
          `insert into public.attendance_records (session_id, community_id, user_id, had_rsvp_going, is_walk_in)
           values ($1, $2, $3, $4, $5)`,
          [session.id, session.community_id, memberIds[0], going, walkIn],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('audit rows are real changes with a known action', async () => {
    const { memberIds, session } = await confirmedSession(1, 1);
    const insert = (oldStatus: string, newStatus: string, action: string) =>
      admin.query(
        `insert into public.attendance_audit_log (session_id, community_id, user_id, old_status, new_status, action)
         values ($1, $2, $3, $4, $5, $6)`,
        [session.id, session.community_id, memberIds[0], oldStatus, newStatus, action],
      );
    await expect(insert('present', 'present', 'correct')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('present', 'absent', 'unfinalize')).rejects.toMatchObject({ code: '23514' });
  });

  it('deleting accounts: the attendee\'s rows go, the organizer\'s authorship becomes null', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(2, 2);
    await recordAttendance(organizerId, session.id, memberIds[0], 'present');
    await recordAttendance(organizerId, session.id, memberIds[1], 'absent');
    await finalizeAttendance(organizerId, session.id);

    await admin.query('delete from auth.users where id = $1', [memberIds[0]]);
    expect((await recordsOf(session.id)).map((r) => r.user_id)).toEqual([memberIds[1]]);
    expect((await auditOf(session.id)).map((a) => a.user_id)).toEqual([memberIds[1]]);

    await admin.query('delete from auth.users where id = $1', [organizerId]);
    expect((await recordsOf(session.id))[0]).toMatchObject({ recorded_by: null, status: 'absent' });
    expect((await auditOf(session.id))[0]).toMatchObject({ changed_by: null });
    expect(await getSession(session.id)).toMatchObject({ status: 'completed', attendance_finalized_by: null });
  });
});

describe('get_attendance_sheet', () => {
  it('lists going members and everyone with a record, with RSVP, attendance and walk-in flags', async () => {
    const { communityId, organizerId, memberIds, session } = await confirmedSession(4, 2);
    await admin.query('update public.profiles set display_name = $2 where id = $1', [memberIds[0], 'Bianca']);
    await admin.query('update public.profiles set display_name = $2 where id = $1', [memberIds[1], 'Andrei']);
    await admin.query('update public.profiles set display_name = $2 where id = $1', [memberIds[2], 'Cezar']);
    await recordAttendance(organizerId, session.id, memberIds[0], 'present');
    await addWalkIn(organizerId, session.id, memberIds[2]);
    // memberIds[3] has no RSVP and no record: not on the sheet.

    const sheet = await attendanceSheet(organizerId, session.id);
    expect(sheet).toMatchObject({
      session_id: session.id,
      status: 'confirmed',
      ended: true,
      attendance_finalized_at: null,
      attendance_finalized_by: null,
    });
    expect(sheet.entries.map((e) => [e.display_name, e.rsvp_response, e.attendance_status, e.has_record, e.is_walk_in, e.had_rsvp_going, e.membership_status])).toEqual([
      ['Andrei', 'going', 'unrecorded', false, false, null, 'active'],
      ['Bianca', 'going', 'present', true, false, true, 'active'],
      ['Cezar', 'no_response', 'present', true, true, false, 'active'],
    ]);
    expect(sheet.entries[0].user_id).toBe(memberIds[1]);
    expect(communityId).toBe(session.community_id);
  });

  it('shows removed members only when they have a record, and reflects finalization', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(2, 2);
    await recordAttendance(organizerId, session.id, memberIds[0], 'absent');
    await admin.query("update public.memberships set status = 'removed' where user_id = any($1)", [memberIds]);
    await finalizeAttendance(organizerId, session.id);

    const sheet = await attendanceSheet(organizerId, session.id);
    expect(sheet.status).toBe('completed');
    expect(sheet.attendance_finalized_by).toBe(organizerId);
    expect(sheet.entries.map((e) => [e.user_id, e.membership_status, e.attendance_status])).toEqual([
      [memberIds[0], 'removed', 'absent'],
    ]);
  });

  it('works before the session ended (read only) and for cancelled sessions', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1, { ended: false });
    const sheet = await attendanceSheet(organizerId, session.id);
    expect(sheet.ended).toBe(false);
    expect(sheet.entries.map((e) => e.user_id)).toEqual([memberIds[0]]);
    await cancelTraining(organizerId, session.id);
    expect((await attendanceSheet(organizerId, session.id)).status).toBe('cancelled');
  });
});
