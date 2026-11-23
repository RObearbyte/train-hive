import { randomUUID } from 'node:crypto';

import { addWalkIn, finalizeAttendance, makeEnded, recordAttendance } from './attendance-helpers';
import { createWithCode, issueCode } from './creator-codes-helpers';
import {
  addMember,
  admin,
  asUser,
  createPack,
  createTraining,
  createUser,
  finalize,
  makeDue,
  rpc,
  rpcRow,
  setRsvp,
  type Session,
} from './helpers';
import { createAnnouncement, registerToken } from './notifications-helpers';

/**
 * Helpers for the GDPR G2 suites (member roles, data export, account deletion). Not a test file.
 */

export interface MembershipRow {
  id: string;
  community_id: string;
  user_id: string;
  role: 'organizer' | 'member';
  status: 'active' | 'removed';
  joined_at: Date;
}

export function setMemberRole(
  callerId: string,
  communityId: string | null,
  userId: string | null,
  role: string | null,
): Promise<MembershipRow> {
  return asUser(callerId, (db) => rpcRow<MembershipRow>(db, 'set_member_role', [communityId, userId, role]));
}

export function removeMember(callerId: string, communityId: string | null, userId: string | null): Promise<MembershipRow> {
  return asUser(callerId, (db) => rpcRow<MembershipRow>(db, 'remove_member', [communityId, userId]));
}

export interface LeaveResult {
  community_id: string;
  membership_id: string;
  status: 'removed';
  changed: boolean;
  invitations_revoked: number;
}

export function leaveCommunity(callerId: string, communityId: string | null): Promise<LeaveResult> {
  return asUser(callerId, (db) => rpc<LeaveResult>(db, 'leave_community', [communityId]));
}

export type DataExport = Record<string, unknown> & {
  format_version: number;
  generated_at: string;
  README: string;
  account: { user_id: string; created_at: string; is_anonymous: boolean } | null;
  profile: { display_name: string; created_at: string; updated_at: string } | null;
  memberships: Record<string, unknown>[];
  rsvps: Record<string, unknown>[];
  attendance: Record<string, unknown>[];
  attendance_changes: Record<string, unknown>[];
  invitation_redemptions: Record<string, unknown>[];
  creator_code_redemptions: Record<string, unknown>[];
  consents: Record<string, unknown>[];
  notification_preferences: Record<string, unknown> | null;
  notifications: Record<string, unknown>[];
  announcement_reads: Record<string, unknown>[];
  push_devices: Record<string, unknown>[];
  authored: {
    announcements: Record<string, unknown>[];
    events_organized: Record<string, unknown>[];
    invitation_codes: Record<string, unknown>[];
    events_cancelled: number;
    events_attendance_finalized: number;
    attendance_records_created_for_others: number;
    attendance_changes_made_for_others: number;
  };
  technical: { invitation_attempts: Record<string, unknown>[]; data_export_requests: Record<string, unknown>[] };
  extensions: Record<string, unknown>;
  truncated: Record<string, boolean>;
};

export function exportMyData(userId: string): Promise<DataExport> {
  return asUser(userId, (db) => rpc<DataExport>(db, 'export_my_data'));
}

export interface DeletionSummary {
  user_id: string;
  communities_deleted: string[];
  memberships_deleted: number;
  rsvps_deleted: number;
  attendance_records_anonymized: number;
  attendance_changes_anonymized: number;
  notifications_deleted: number;
}

export function deleteMyAccount(userId: string): Promise<DeletionSummary> {
  return asUser(userId, (db) => rpc<DeletionSummary>(db, 'delete_my_account'));
}

export interface DeletionBlockers {
  can_delete: boolean;
  last_organizer: { community_id: string; name: string; active_members: number }[];
  deleted_with_account: { community_id: string; name: string }[];
}

export function myDeletionBlockers(userId: string): Promise<DeletionBlockers> {
  return asUser(userId, (db) => rpc<DeletionBlockers>(db, 'my_deletion_blockers'));
}

// Reference scanner -------------------------------------------------------------------------------

interface ScannedColumn {
  schema: string;
  table: string;
  column: string;
  kind: 'uuid' | 'uuid[]' | 'text';
}

/**
 * Every column of every table in public, private and auth that could hold a user id: uuid and
 * uuid[] columns (compared for equality) and text / varchar / json / jsonb columns (searched for
 * the id as a substring). This is a superset of both the foreign keys to auth.users / profiles and
 * the columns named like user_id / author_id / created_by / changed_by / organizer_id / recorded_by,
 * so it also finds unconstrained columns such as notifications.user_id.
 */
export async function scannedColumns(): Promise<ScannedColumn[]> {
  const { rows } = await admin.query<ScannedColumn>(
    `select n.nspname as schema, c.relname as table, a.attname as column,
            case when a.atttypid = 'uuid'::regtype then 'uuid'
                 when a.atttypid = 'uuid[]'::regtype then 'uuid[]'
                 else 'text' end as kind
     from pg_attribute a
     join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'private', 'auth')
       and c.relkind in ('r', 'p')
       and a.attnum > 0
       and not a.attisdropped
       and a.atttypid in ('uuid'::regtype, 'uuid[]'::regtype, 'text'::regtype, 'character varying'::regtype,
                          'json'::regtype, 'jsonb'::regtype)
     order by 1, 2, 3`,
  );
  return rows;
}

/** The single-column foreign keys that point at auth.users(id) or public.profiles(id). */
export async function userForeignKeys(): Promise<string[]> {
  const { rows } = await admin.query<{ ref: string }>(
    `select n.nspname || '.' || c.relname || '.' || a.attname as ref
     from pg_constraint k
     join pg_class c on c.oid = k.conrelid
     join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
     where k.contype = 'f'
       and array_length(k.conkey, 1) = 1
       and k.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)
     order by 1`,
  );
  return rows.map((r) => r.ref);
}

/** Columns whose name says they hold a person: the list from the G2 task, plus every `*_by`. */
export async function userNamedColumns(): Promise<string[]> {
  const { rows } = await admin.query<{ ref: string }>(
    `select n.nspname || '.' || c.relname || '.' || a.attname as ref
     from pg_attribute a
     join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'private', 'auth')
       and c.relkind in ('r', 'p')
       and a.attnum > 0 and not a.attisdropped
       and a.atttypid = 'uuid'::regtype
       and (a.attname like '%user_id%' or a.attname like '%author_id%' or a.attname like '%created_by%'
            or a.attname like '%changed_by%' or a.attname like '%organizer_id%'
            or a.attname like '%recorded_by%' or a.attname like '%\\_by')
     order by 1`,
  );
  return rows.map((r) => r.ref);
}

/** `schema.table.column` -> number of rows that refer to `userId` (only columns with matches). */
export async function referencesTo(userId: string): Promise<Record<string, number>> {
  const found: Record<string, number> = {};
  for (const col of await scannedColumns()) {
    const target = `"${col.schema}"."${col.table}"`;
    const column = `"${col.column}"`;
    const predicate =
      col.kind === 'uuid'
        ? `${column} = $1::uuid`
        : col.kind === 'uuid[]'
          ? `$1::uuid = any (${column})`
          : `strpos(${column}::text, $1::text) > 0`;
    const { rows } = await admin.query<{ n: number }>(
      `select count(*)::int as n from ${target} where ${predicate}`,
      [userId],
    );
    if (rows[0].n > 0) found[`${col.schema}.${col.table}.${col.column}`] = rows[0].n;
  }
  return found;
}

// Snapshots of everything else ---------------------------------------------------------------------

/** Every row of every table in public (and private.data_export_log) as JSON text, keyed by table. */
export async function snapshotTables(): Promise<Map<string, string[]>> {
  const { rows: tables } = await admin.query<{ name: string }>(
    `select n.nspname || '.' || c.relname as name
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p')
       and (n.nspname = 'public' or (n.nspname = 'private' and c.relname = 'data_export_log'))
     order by 1`,
  );
  const result = new Map<string, string[]>();
  for (const { name } of tables) {
    const [schema, table] = name.split('.');
    const { rows } = await admin.query<{ row: string }>(
      `select to_jsonb(t)::text as row from "${schema}"."${table}" t order by 1`,
    );
    result.set(name, rows.map((r) => r.row));
  }
  return result;
}

// The "full life" fixture -------------------------------------------------------------------------

export interface FullLife {
  victim: string;
  alpha: { communityId: string; organizerId: string; memberIds: string[] };
  beta: { communityId: string; organizerId: string; memberIds: string[] };
  /** The victim was removed from gamma. */
  gamma: { communityId: string; organizerId: string };
  /** Created by the victim with a creator code; the victim is its only member. */
  delta: { communityId: string };
  /** Created by the victim with a creator code; epsilonOrganizer joined and was promoted. */
  epsilon: { communityId: string; organizerId: string };
  sessions: Record<'s1' | 's2' | 's3' | 's4' | 's5' | 's6' | 's7' | 's8' | 's9' | 's10', Session>;
  announcements: { published: string; scheduled: string; readByVictim: string };
  invitationCreatedByVictim: string;
}

async function joinWithCode(organizerId: string, communityId: string, userId: string, name: string): Promise<void> {
  const code = await asUser(organizerId, (db) =>
    rpcRow<{ code: string }>(db, 'create_invitation', [communityId]),
  );
  const result = await asUser(userId, (db) =>
    rpc<{ ok: boolean; error?: string }>(db, 'redeem_invitation', [code.code, name]),
  );
  if (!result.ok) throw new Error(`fixture join failed: ${result.error}`);
}

/** A training that went through the real lifecycle up to `confirmed` and ended. */
async function pastConfirmed(organizerId: string, communityId: string, going: string[]): Promise<Session> {
  const session = await createTraining(organizerId, communityId, { min_participants: 1 });
  for (const userId of going) await setRsvp(userId, session.id, 'going');
  await makeDue(session.id);
  await finalize();
  await makeEnded(session.id);
  return session;
}

/**
 * A member with a full history: organizer in alpha (next to another organizer), member in beta,
 * removed from gamma, sole member (and creator) of delta, creator of epsilon (whose other member is
 * now an organizer too). RSVPs going / not going on open and decided sessions, attendance present /
 * absent / walk-in / unrecorded with audit rows (as subject and as author), announcements authored
 * (published and scheduled) and read, notifications with push jobs, two push tokens, preferences,
 * consents granted and withdrawn, invitation and creator-code redemptions, an invitation code the
 * victim created, a failed code attempt and organized / cancelled / finalized sessions.
 */
export async function buildFullLife(): Promise<FullLife> {
  const victim = await createUser();

  const alpha = await createPack(2);
  await joinWithCode(alpha.organizerId, alpha.communityId, victim, 'Victor Victim');
  await setMemberRole(alpha.organizerId, alpha.communityId, victim, 'organizer');

  const beta = await createPack(1);
  await joinWithCode(beta.organizerId, beta.communityId, victim, 'Victor Victim');

  const gammaPack = await createPack(0);
  await joinWithCode(gammaPack.organizerId, gammaPack.communityId, victim, 'Victor Victim');
  await removeMember(gammaPack.organizerId, gammaPack.communityId, victim);

  const deltaCode = await issueCode();
  const delta = await createWithCode(victim, deltaCode.code, {
    name: 'Delta Solo',
    displayName: 'Victor Victim',
    requestId: randomUUID(),
  });
  if (!delta.ok) throw new Error(`fixture delta failed: ${delta.error}`);

  const epsilonCode = await issueCode();
  const epsilon = await createWithCode(victim, epsilonCode.code, {
    name: 'Epsilon Pack',
    displayName: 'Victor Victim',
    requestId: randomUUID(),
  });
  if (!epsilon.ok) throw new Error(`fixture epsilon failed: ${epsilon.error}`);
  const epsilonOrganizer = await createUser();
  await joinWithCode(victim, epsilon.community_id!, epsilonOrganizer, 'Erin Epsilon');
  await setMemberRole(victim, epsilon.community_id!, epsilonOrganizer, 'organizer');

  const [o1, [m1, m2]] = [alpha.organizerId, alpha.memberIds];

  // s1: organized by the victim; victim present after a correction, the victim marked m1 and m2.
  const s1 = await pastConfirmed(victim, alpha.communityId, [victim, m1, m2]);
  await recordAttendance(o1, s1.id, victim, 'absent');
  await recordAttendance(o1, s1.id, victim, 'present', 'Arrived late');
  await recordAttendance(victim, s1.id, m1, 'present');
  await recordAttendance(victim, s1.id, m2, 'absent');
  await finalizeAttendance(victim, s1.id);

  // s2: the victim was a walk-in.
  const s2 = await pastConfirmed(o1, alpha.communityId, [m1]);
  await addWalkIn(o1, s2.id, victim);
  await recordAttendance(o1, s2.id, m1, 'present');
  await finalizeAttendance(o1, s2.id);

  // s3: the victim was absent.
  const s3 = await pastConfirmed(o1, alpha.communityId, [victim, m2]);
  await recordAttendance(o1, s3.id, victim, 'absent');
  await recordAttendance(o1, s3.id, m2, 'present');
  await finalizeAttendance(o1, s3.id);

  // s4: the victim was going and never marked (finalization adds an unrecorded row).
  const s4 = await pastConfirmed(o1, alpha.communityId, [victim, m1]);
  await recordAttendance(o1, s4.id, m1, 'present');
  await finalizeAttendance(o1, s4.id);

  // s5 / s6: open sessions, going and not going.
  const s5 = await createTraining(o1, alpha.communityId);
  await setRsvp(victim, s5.id, 'going');
  await setRsvp(m1, s5.id, 'going');
  const s6 = await createTraining(o1, alpha.communityId);
  await setRsvp(victim, s6.id, 'not_going');

  // s7: decided (confirmed), not ended; the victim's going counts.
  const s7 = await createTraining(o1, alpha.communityId, { min_participants: 1 });
  await setRsvp(victim, s7.id, 'going');
  await setRsvp(m2, s7.id, 'going');
  await makeDue(s7.id);
  await finalize();

  // s8: cancelled by the victim.
  const s8 = await createTraining(o1, alpha.communityId);
  await asUser(victim, (db) => rpcRow(db, 'cancel_training', [s8.id]));

  // beta: s9 completed with the victim present; s10 open, victim going.
  const [o2, [m3]] = [beta.organizerId, beta.memberIds];
  const s9 = await pastConfirmed(o2, beta.communityId, [victim, m3]);
  await recordAttendance(o2, s9.id, victim, 'present');
  await recordAttendance(o2, s9.id, m3, 'present');
  await finalizeAttendance(o2, s9.id);
  const s10 = await createTraining(o2, beta.communityId);
  await setRsvp(victim, s10.id, 'going');

  // Announcements: one published and one scheduled by the victim; one by o1, read by the victim.
  const published = await createAnnouncement(victim, alpha.communityId, { title: 'Victim news' });
  const scheduled = await createAnnouncement(victim, alpha.communityId, {
    title: 'Victim later',
    scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const readByVictim = await createAnnouncement(o1, alpha.communityId, { title: 'Organizer news' });
  await asUser(victim, (db) => rpcRow(db, 'mark_announcement_read', [readByVictim.id]));

  // Push, preferences, consents, a failed code attempt, an invitation code.
  await registerToken(victim, 'ExponentPushToken[victim-phone]', 'android', 'Phone');
  await registerToken(victim, 'ExponentPushToken[victim-tablet]', 'ios', 'Tablet');
  await asUser(victim, (db) => rpcRow(db, 'set_notification_preferences', [true, false, true, true]));
  await asUser(victim, (db) => rpc(db, 'record_consent', ['workout_logs']));
  await asUser(victim, (db) => rpc(db, 'withdraw_consent', ['workout_logs']));
  // P3: About you (emergency contact with its consent, T-shirt size).
  await asUser(victim, (db) => rpc(db, 'record_consent', ['emergency_contact']));
  await asUser(victim, (db) =>
    rpc(db, 'save_my_about_you', [
      JSON.stringify({
        emergency_contact_name: 'Contact Person',
        emergency_contact_phone: '+40 700 000 000',
        tshirt_size: 'L',
      }),
    ]),
  );
  await asUser(victim, (db) => rpc(db, 'preview_invitation', ['ZZZZZZZZ']));
  const invitation = await asUser(victim, (db) =>
    rpcRow<{ id: string }>(db, 'create_invitation', [alpha.communityId]),
  );

  // Everybody joined "a month ago", so the past sessions are in every member's eligible set and
  // the per-member statistics have something to show.
  await admin.query(
    "update public.memberships set joined_at = now() - interval '30 days' where community_id = any($1::uuid[])",
    [[alpha.communityId, beta.communityId, gammaPack.communityId, delta.community_id, epsilon.community_id]],
  );

  return {
    victim,
    alpha: { communityId: alpha.communityId, organizerId: o1, memberIds: [m1, m2] },
    beta: { communityId: beta.communityId, organizerId: o2, memberIds: [m3] },
    gamma: { communityId: gammaPack.communityId, organizerId: gammaPack.organizerId },
    delta: { communityId: delta.community_id! },
    epsilon: { communityId: epsilon.community_id!, organizerId: epsilonOrganizer },
    sessions: { s1, s2, s3, s4, s5, s6, s7, s8, s9, s10 },
    announcements: { published: published.id, scheduled: scheduled.id, readByVictim: readByVictim.id },
    invitationCreatedByVictim: invitation.id,
  };
}

/** A small community: an organizer, a second organizer and `members` members (direct inserts). */
export async function packWithTwoOrganizers(members = 1): Promise<{
  communityId: string;
  organizerId: string;
  secondOrganizerId: string;
  memberIds: string[];
}> {
  const pack = await createPack(members);
  const secondOrganizerId = await addMember(pack.communityId, { role: 'organizer', name: 'Second Organizer' });
  return { ...pack, secondOrganizerId };
}

/** going_count rows that disagree with the real number of going RSVPs (should be none). */
export async function goingCountMismatches(): Promise<string[]> {
  const { rows } = await admin.query<{ id: string }>(
    `select s.id from public.training_sessions s
     where s.going_count <> (select count(*) from public.training_rsvps r
                             where r.session_id = s.id and r.response = 'going')`,
  );
  return rows.map((r) => r.id);
}
