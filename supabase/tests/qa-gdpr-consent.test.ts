import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { confirmedSession, recordAttendance } from './attendance-helpers';
import { deleteMyAccount, removeMember } from './account-deletion-helpers';
import {
  addMember,
  admin,
  asService,
  asUser,
  closeDb,
  createCommunity,
  createPack,
  createTraining,
  createUser,
  insertInvitation,
  INSUFFICIENT_PRIVILEGE,
  resetData,
  rpc,
  rpcRow,
} from './helpers';
import { claimJobs, createAnnouncement, expoToken } from './notifications-helpers';
import { raised } from './qa-helpers';

/**
 * QA review of GDPR G1 (consents) and the retention / notice promises of G2 (Q7).
 * Tests marked DEFECT Q7-n are `it.fails`: they state the expected behaviour, fail today, and turn
 * red when the defect is fixed (remove `.fails` then). All names and values are obviously fake.
 */

beforeEach(resetData);
afterAll(closeDb);

const setVersion = (document: string, version: string) =>
  asService((db) => rpc(db, 'admin_set_legal_version', [document, version]));
const mine = (userId: string) =>
  asUser(userId, (db) =>
    rpc<{ needs_terms_acceptance: boolean; terms_privacy_version: string; consents: Record<string, { granted: boolean; current: boolean }> }>(
      db,
      'my_consents',
    ),
  );
const record = (userId: string, purpose: string, version: string | null = null) =>
  asUser(userId, (db) => rpc(db, 'record_consent', [purpose, version]));
const redeem = (userId: string, code: string) =>
  asUser(userId, (db) => rpc<{ ok: boolean; error?: string }>(db, 'redeem_invitation', [code, 'Zed Zebra']));

describe('ledger: append-only holds against every API role, documented gaps confirmed', () => {
  it('no API role can truncate, update or delete the ledger; the owner cannot update or delete either', async () => {
    const user = await createUser();
    for (const run of [
      (db: Parameters<Parameters<typeof asUser>[1]>[0]) => db.query('truncate public.consent_records'),
      (db: Parameters<Parameters<typeof asUser>[1]>[0]) => db.query("update public.consent_records set granted = false"),
      (db: Parameters<Parameters<typeof asUser>[1]>[0]) => db.query('delete from public.consent_records'),
    ]) {
      await expect(asUser(user, run)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(asService(run)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    }
    await expect(admin.query('update public.consent_records set granted = false')).rejects.toMatchObject(
      raised('consent_ledger_append_only'),
    );
    await expect(admin.query('delete from public.consent_records')).rejects.toMatchObject(
      raised('consent_ledger_append_only'),
    );
    const { rows } = await admin.query('select count(*)::int as n from public.consent_records where user_id = $1', [user]);
    expect(rows[0].n).toBe(2);
  });

  it('GAP (documented, owner only): session_replication_role = replica and TRUNCATE bypass the guard', async () => {
    const user = await createUser();
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query("set local session_replication_role = replica");
      await client.query('delete from public.consent_records where user_id = $1', [user]);
      await client.query('commit');
    } finally {
      client.release();
    }
    const { rows } = await admin.query('select count(*)::int as n from public.consent_records where user_id = $1', [user]);
    expect(rows[0].n).toBe(0); // the guard was skipped: risk = anyone holding the database owner / superuser role
    await createUser();
    await admin.query('truncate public.consent_records');
  });
});

describe('versions and re-gating', () => {
  it('bumping only terms, or only privacy, makes the acceptance stale and gates joins; optional consents stay', async () => {
    const pack = await createPack(0);
    const user = await createUser();
    await record(user, 'push_notifications');
    for (const document of ['terms', 'privacy']) {
      await setVersion(document, '2');
      const state = await mine(user);
      expect(state.needs_terms_acceptance).toBe(true);
      expect(state.consents.push_notifications.current).toBe(true);
      const code = await insertInvitation(pack.communityId, (await admin.query<{ c: string }>('select private.generate_invitation_code() as c')).rows[0].c);
      expect(await redeem(user, code.code)).toEqual({ ok: false, error: 'consent_required' });
      // the stale combined string is refused, the new one accepted
      await expect(record(user, 'terms_privacy', 'terms:1|privacy:1')).rejects.toMatchObject(
        raised('validation_failed:document_version'),
      );
      await record(user, 'terms_privacy', state.terms_privacy_version);
      expect((await mine(user)).needs_terms_acceptance).toBe(false);
    }
  });

  it('OBSERVATION: rolling a version back makes old acceptances valid again', async () => {
    const user = await createUser();
    await setVersion('privacy', '2');
    expect((await mine(user)).needs_terms_acceptance).toBe(true);
    await setVersion('privacy', '1');
    expect((await mine(user)).needs_terms_acceptance).toBe(false);
  });

  it('version strings that could blur the combined value are refused', async () => {
    for (const bad of ['1|privacy:2', 'a b', '', 'x'.repeat(21), '1:2']) {
      await expect(setVersion('terms', bad)).rejects.toMatchObject({ code: 'P0001' });
    }
  });

  it('a client cannot reach the private helpers that would let it forge consent', async () => {
    const user = await createUser({ consent: false });
    await expect(
      asUser(user, (db) => db.query("select private.has_consent($1, 'age_16')", [user])),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      asUser(user, (db) =>
        db.query("insert into public.consent_records (user_id, purpose, granted) values ($1, 'age_16', true)", [user]),
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });
});

describe('deleted-user token', () => {
  it('my_consents answers a default document (no error, no data) and push registration says not_a_member', async () => {
    const user = await createUser();
    await asUser(user, async () => undefined);
    const claims = { sub: user, role: 'authenticated' };
    await deleteMyAccount(user).catch(() => undefined);
    const state = await mine(user);
    expect(state.needs_terms_acceptance).toBe(true);
    expect(Object.values(state.consents).every((c) => !c.granted)).toBe(true);
    await expect(
      asUser(claims.sub, (db) => rpcRow(db, 'register_push_token', [expoToken('ghost'), 'android', null])),
    ).rejects.toMatchObject(raised('not_a_member'));
  });
});

describe('push consent versus pre-G1 tokens', () => {
  async function memberWithLegacyToken() {
    const pack = await createPack(1);
    const [member] = pack.memberIds;
    // A token registered before G1 existed: no consent event, inserted as the old RPC would have.
    await admin.query(
      "insert into public.device_push_tokens (user_id, token, platform) values ($1, $2, 'android')",
      [member, expoToken('legacy')],
    );
    return { ...pack, member };
  }

  // DEFECT Q7-1: the dispatcher gate (claim_notification_jobs) never looks at push consent.
  it('FIXED Q7-1: a token without a recorded push consent is not handed to the dispatcher', async () => {
    const { organizerId, communityId, member } = await memberWithLegacyToken();
    await createAnnouncement(organizerId, communityId, { title: 'Qseven News' });
    const claimed = await claimJobs('qa-worker');
    const job = claimed.find((j) => j.user_id === member);
    expect(job).toBeDefined();
    expect(job?.tokens).toEqual([]);
  });

  // DEFECT Q7-2: a user whose token predates the ledger cannot remove it with the Privacy switch.
  it('FIXED Q7-2: withdraw_consent(push) removes tokens even when no grant event exists', async () => {
    const { member } = await memberWithLegacyToken();
    await asUser(member, (db) => rpc(db, 'withdraw_consent', ['push_notifications']));
    const { rows } = await admin.query('select count(*)::int as n from public.device_push_tokens where user_id = $1', [member]);
    expect(rows[0].n).toBe(0);
  });
});

describe('retention promises of the notice and the export README', () => {
  // DEFECT Q7-3: README says rate-limit records are kept for at most a day; only the same user's
  // next export prunes them, no purge job does.
  it('FIXED Q7-3: private.data_export_log rows older than a day are purged', async () => {
    const user = await createUser();
    await admin.query("insert into private.data_export_log (user_id, requested_at) values ($1, now() - interval '5 days')", [user]);
    await asService((db) => rpc(db, 'purge_old_notification_data'));
    const { rows } = await admin.query('select count(*)::int as n from private.data_export_log where user_id = $1', [user]);
    expect(rows[0].n).toBe(0);
  });

  // DEFECT Q7-4: the notice says push tokens are deleted "when the token stops working"; the
  // dispatcher only sets invalidated_at and nothing ever deletes the row (token value kept).
  it('FIXED Q7-4: an invalidated push token is eventually deleted', async () => {
    const pack = await createPack(1);
    const [member] = pack.memberIds;
    await admin.query(
      "insert into public.device_push_tokens (user_id, token, platform, invalidated_at) values ($1, $2, 'android', now() - interval '60 days')",
      [member, expoToken('dead')],
    );
    await asService((db) => rpc(db, 'purge_old_notification_data'));
    const { rows } = await admin.query('select count(*)::int as n from public.device_push_tokens where user_id = $1', [member]);
    expect(rows[0].n).toBe(0);
  });

  it('read notifications older than 90 days and unread older than 180 days are purged (notice, in-app notifications)', async () => {
    const pack = await createPack(1);
    const [member] = pack.memberIds;
    await createAnnouncement(pack.organizerId, pack.communityId);
    await createAnnouncement(pack.organizerId, pack.communityId, { title: 'Second' });
    await admin.query(
      `update public.notifications set created_at = now() - interval '100 days', read_at = now() where user_id = $1 and id = (select id from public.notifications where user_id = $1 order by id limit 1)`,
      [member],
    );
    await admin.query(
      `update public.notifications set created_at = now() - interval '200 days' where user_id = $1 and read_at is null`,
      [member],
    );
    await asService((db) => rpc(db, 'purge_old_notification_data'));
    const { rows } = await admin.query('select count(*)::int as n from public.notifications where user_id = $1', [member]);
    expect(rows[0].n).toBe(0);
  });
});

describe('removed members', () => {
  // FIXED Q7-5 (by text): the Terms now say removal is final for that account in this version. The
  // server enforces exactly that: a removed member's membership row blocks every code and no
  // reinstate function exists. This pins the behaviour the Terms promise.
  it('Q7-5: a removed member cannot rejoin with a new code (removal is final)', async () => {
    const pack = await createPack(1);
    const [member] = pack.memberIds;
    await removeMember(pack.organizerId, pack.communityId, member);
    const code = await asUser(pack.organizerId, (db) => rpcRow<{ code: string }>(db, 'create_invitation', [pack.communityId]));
    const result = await redeem(member, code.code);
    expect(result.ok).toBe(false);
  });

  it('a removed member gets no new notifications and sees no community rows beyond their own', async () => {
    const pack = await createPack(2);
    const [gone, stays] = pack.memberIds;
    await removeMember(pack.organizerId, pack.communityId, gone);
    await admin.query('delete from public.notifications where user_id = $1', [gone]);
    await createAnnouncement(pack.organizerId, pack.communityId, { title: 'Qseven after removal' });
    await createTraining(pack.organizerId, pack.communityId, { title: 'Qseven Run' });
    const forGone = await admin.query('select count(*)::int as n from public.notifications where user_id = $1', [gone]);
    const forStays = await admin.query('select count(*)::int as n from public.notifications where user_id = $1', [stays]);
    expect(forGone.rows[0].n).toBe(0);
    expect(forStays.rows[0].n).toBeGreaterThan(0);

    // Every table with a community_id column: the removed member sees only rows that are about themselves.
    const { rows: tables } = await admin.query<{ t: string; cols: string[] }>(
      `select c.relname as t, array_agg(a.attname::text) as cols
       from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       where c.relkind in ('r', 'p') and has_table_privilege('authenticated', c.oid, 'select')
       group by c.relname
       having bool_or(a.attname = 'community_id')`,
    );
    const leaks: string[] = [];
    for (const { t, cols } of tables) {
      const own = cols.includes('user_id') ? 'user_id' : null;
      const rows = await asUser(gone, (db) =>
        db.query(
          `select count(*)::int as n from public.${t} where community_id = $1 ${own ? `and ${own} is distinct from $2` : ''}`,
          own ? [pack.communityId, gone] : [pack.communityId],
        ),
      );
      if (rows.rows[0].n > 0) leaks.push(`${t}:${rows.rows[0].n}`);
    }
    expect(leaks).toEqual([]);
  });
});

describe('free text survives anonymization', () => {
  // DEFECT Q7-6: the plan promises audit entries "without name or id"; the organizer's free-text
  // reason stays on the anonymized audit row and can contain the person's name.
  it('FIXED Q7-6: attendance_audit_log.reason of an erased user is scrubbed', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(2, 2);
    const [victim] = memberIds;
    await recordAttendance(organizerId, session.id, victim, 'absent', 'Zed Zebra had the flu');
    await deleteMyAccount(victim);
    const { rows } = await admin.query(
      "select count(*)::int as n from public.attendance_audit_log where user_id is null and reason like '%Zebra%'",
    );
    expect(rows[0].n).toBe(0);
  });

  it('OBSERVATION: an authored announcement stays with its text (the plan said "choose: delete"; the notice says it stays)', async () => {
    const community = await createCommunity();
    const keeper = await addMember(community.communityId, { role: 'organizer', name: 'Olive Other' });
    const author = await addMember(community.communityId, { role: 'organizer', name: 'Zed Zebra' });
    const ann = await createAnnouncement(author, community.communityId, { title: 'Hi', body: 'Call Zed Zebra on 000-000-0000' });
    await deleteMyAccount(author);
    const { rows } = await admin.query('select author_id, body from public.announcements where id = $1', [ann.id]);
    expect(rows[0].author_id).toBeNull();
    expect(rows[0].body).toContain('Zed Zebra');
    expect(keeper).toBeTruthy();
  });

  it('OBSERVATION: in a community of two, the anonymous present row identifies the leaver to the organizer', async () => {
    const { organizerId, memberIds, session } = await confirmedSession(1, 1);
    const [leaver] = memberIds;
    await recordAttendance(organizerId, session.id, leaver, 'present');
    await deleteMyAccount(leaver);
    const sheet = await asUser(organizerId, (db) => rpc<{ former_members: { present: number } }>(db, 'get_attendance_sheet', [session.id]));
    expect(sheet.former_members.present).toBe(1);
  });
});

describe('transparency claims that can be checked in the schema', () => {
  it('every table in public has row level security enabled and forced to apply to API roles', async () => {
    const { rows } = await admin.query<{ t: string }>(
      "select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity",
    );
    expect(rows).toEqual([]);
  });

  it('tables published to Realtime keep the default replica identity (old values carry only the key)', async () => {
    const { rows } = await admin.query<{ t: string; ident: string }>(
      `select c.relname as t, c.relreplident as ident
       from pg_publication_tables p join pg_class c on c.relname = p.tablename
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = p.schemaname
       where p.pubname = 'supabase_realtime'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.ident !== 'd')).toEqual([]);
  });

  it('the export holds no invitation code values and no push token values', async () => {
    const pack = await createPack(0);
    const code = await asUser(pack.organizerId, (db) => rpcRow<{ code: string }>(db, 'create_invitation', [pack.communityId]));
    await admin.query("insert into public.device_push_tokens (user_id, token, platform) values ($1, $2, 'android')", [pack.organizerId, expoToken('secret')]);
    const doc = await asUser(pack.organizerId, (db) => rpc(db, 'export_my_data'));
    const text = JSON.stringify(doc);
    expect(text).not.toContain(code.code);
    expect(text).not.toContain('test-secret');
  });
});
