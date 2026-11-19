import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  admin,
  asAnon,
  asService,
  asUser,
  closeDb,
  countRows,
  createUser,
  INSUFFICIENT_PRIVILEGE,
  RAISED,
  resetData,
  rpc,
} from './helpers';

/**
 * GDPR G1: the consent ledger (`consent_records`), the legal versions (`legal_documents`) and the
 * RPCs record_consent / withdraw_consent / my_consents / admin_set_legal_version.
 * The join gate and the push-token gate are in consent-gates.test.ts.
 */

type ConsentEvent = {
  purpose: string;
  granted: boolean;
  document_version: string | null;
  at: string | null;
  changed: boolean;
};

type PurposeState = { granted: boolean; current: boolean; document_version: string | null; at: string | null };

type MyConsents = {
  terms_version: string;
  terms_effective_at: string;
  privacy_version: string;
  privacy_effective_at: string;
  terms_privacy_version: string;
  needs_terms_acceptance: boolean;
  consents: Record<string, PurposeState>;
};

const PURPOSES = [
  'terms_privacy',
  'age_16',
  'profile_demographics',
  'emergency_contact',
  'workout_logs',
  'push_notifications',
];

const denied = { code: INSUFFICIENT_PRIVILEGE };
const raised = (message: string) => ({ code: RAISED, message });

const record = (userId: string, purpose: string | null, version: string | null = null) =>
  asUser(userId, (db) => rpc<ConsentEvent>(db, 'record_consent', [purpose, version]));
const withdraw = (userId: string, purpose: string | null) =>
  asUser(userId, (db) => rpc<ConsentEvent>(db, 'withdraw_consent', [purpose]));
const mine = (userId: string) => asUser(userId, (db) => rpc<MyConsents>(db, 'my_consents'));
const setVersion = (document: string, version: string) =>
  asService((db) =>
    rpc<{ document: string; version: string; changed: boolean }>(db, 'admin_set_legal_version', [document, version]),
  );

async function ledger(userId: string): Promise<{ purpose: string; granted: boolean; document_version: string | null }[]> {
  const { rows } = await admin.query(
    'select purpose, granted, document_version from public.consent_records where user_id = $1 order by created_at, purpose',
    [userId],
  );
  return rows;
}

/** A user who has accepted nothing yet (first launch). */
const freshUser = () => createUser({ consent: false });

beforeEach(resetData);
afterAll(closeDb);

describe('legal versions', () => {
  it('are seeded at 1 for terms and privacy and readable by any signed-in user', async () => {
    const user = await freshUser();
    const { rows } = await asUser(user, (db) =>
      db.query('select document, version from public.legal_documents order by document'),
    );
    expect(rows).toEqual([
      { document: 'privacy', version: '1' },
      { document: 'terms', version: '1' },
    ]);
  });

  it('cannot be written by clients; anon cannot read them', async () => {
    const user = await freshUser();
    await expect(
      asUser(user, (db) => db.query("update public.legal_documents set version = '9' where document = 'terms'")),
    ).rejects.toMatchObject(denied);
    await expect(
      asUser(user, (db) => db.query("insert into public.legal_documents (document, version) values ('cookies', '1')")),
    ).rejects.toMatchObject(denied);
    await expect(asAnon((db) => db.query('select * from public.legal_documents'))).rejects.toMatchObject(denied);
    await expect(
      asService((db) => db.query("update public.legal_documents set version = '9' where document = 'terms'")),
    ).rejects.toMatchObject(denied);
  });

  it('admin_set_legal_version bumps a version (service_role), idempotently, and validates input', async () => {
    const before = await admin.query("select effective_at from public.legal_documents where document = 'privacy'");
    const bumped = await setVersion('privacy', ' 2 ');
    expect(bumped).toMatchObject({ document: 'privacy', version: '2', changed: true });
    const again = await setVersion('privacy', '2');
    expect(again).toMatchObject({ version: '2', changed: false });
    const after = await admin.query("select effective_at from public.legal_documents where document = 'privacy'");
    expect(after.rows[0].effective_at.getTime()).toBeGreaterThan(before.rows[0].effective_at.getTime());

    for (const [doc, version, error] of [
      ['cookies', '1', 'validation_failed:document'],
      [null, '1', 'validation_failed:document'],
      ['terms', '', 'validation_failed:version'],
      ['terms', null, 'validation_failed:version'],
      ['terms', 'a|b', 'validation_failed:version'],
      ['terms', 'x'.repeat(21), 'validation_failed:version'],
    ] as const) {
      await expect(
        asService((db) => rpc(db, 'admin_set_legal_version', [doc, version])),
        `${doc} ${version}`,
      ).rejects.toMatchObject(raised(error));
    }
    // The SQL editor runs as postgres (the owner).
    const { rows } = await admin.query("select public.admin_set_legal_version('terms', '3') as r");
    expect(rows[0].r).toMatchObject({ document: 'terms', version: '3', changed: true });
  });
});

describe('record_consent / withdraw_consent / my_consents', () => {
  it('a fresh user has no consent and needs to accept the terms', async () => {
    const user = await freshUser();
    const state = await mine(user);
    expect(state).toMatchObject({
      terms_version: '1',
      privacy_version: '1',
      terms_privacy_version: 'terms:1|privacy:1',
      needs_terms_acceptance: true,
    });
    expect(Object.keys(state.consents).sort()).toEqual([...PURPOSES].sort());
    for (const purpose of PURPOSES) {
      expect(state.consents[purpose], purpose).toEqual({ granted: false, current: false, document_version: null, at: null });
    }
  });

  it('terms_privacy needs the exact current combined version; age_16 completes the acceptance', async () => {
    const user = await freshUser();
    for (const version of [null, '1', 'terms:1', 'terms:1|privacy:2', 'terms:0|privacy:1']) {
      await expect(record(user, 'terms_privacy', version), String(version)).rejects.toMatchObject(
        raised('validation_failed:document_version'),
      );
    }
    const terms = await record(user, 'terms_privacy', 'terms:1|privacy:1');
    expect(terms).toMatchObject({ purpose: 'terms_privacy', granted: true, document_version: 'terms:1|privacy:1', changed: true });
    expect((await mine(user)).needs_terms_acceptance).toBe(true);

    const age = await record(user, 'age_16');
    expect(age).toMatchObject({ purpose: 'age_16', granted: true, document_version: '1', changed: true });
    const state = await mine(user);
    expect(state.needs_terms_acceptance).toBe(false);
    expect(state.consents.terms_privacy).toMatchObject({ granted: true, current: true, document_version: 'terms:1|privacy:1' });
    expect(state.consents.age_16).toMatchObject({ granted: true, current: true, document_version: '1' });
  });

  it('optional purposes record the privacy version; a wrong explicit version is refused', async () => {
    const user = await freshUser();
    await expect(record(user, 'workout_logs', '2')).rejects.toMatchObject(raised('validation_failed:document_version'));
    expect(await record(user, 'workout_logs', '1')).toMatchObject({ granted: true, document_version: '1', changed: true });
    expect(await record(user, 'emergency_contact')).toMatchObject({ granted: true, document_version: '1', changed: true });
  });

  it('rejects unknown or null purposes', async () => {
    const user = await freshUser();
    for (const purpose of [null, '', 'marketing', 'AGE_16', ' age_16']) {
      await expect(record(user, purpose), String(purpose)).rejects.toMatchObject(raised('validation_failed:purpose'));
      await expect(withdraw(user, purpose), String(purpose)).rejects.toMatchObject(raised('validation_failed:purpose'));
    }
    expect(await countRows('consent_records')).toBe(0);
  });

  it('is idempotent: granting what is already granted writes nothing', async () => {
    const user = await freshUser();
    await record(user, 'push_notifications');
    const again = await record(user, 'push_notifications');
    expect(again).toMatchObject({ granted: true, changed: false });
    await record(user, 'terms_privacy', 'terms:1|privacy:1');
    expect(await record(user, 'terms_privacy', 'terms:1|privacy:1')).toMatchObject({ changed: false });
    expect(await ledger(user)).toHaveLength(2);
  });

  it('withdrawing appends a false event; latest event wins; withdrawing again is a no-op', async () => {
    const user = await freshUser();
    // Never granted: nothing to withdraw.
    expect(await withdraw(user, 'workout_logs')).toMatchObject({ granted: false, changed: false, at: null });
    await record(user, 'workout_logs');
    const w = await withdraw(user, 'workout_logs');
    expect(w).toMatchObject({ purpose: 'workout_logs', granted: false, document_version: '1', changed: true });
    expect(await withdraw(user, 'workout_logs')).toMatchObject({ granted: false, changed: false });
    expect((await mine(user)).consents.workout_logs).toMatchObject({ granted: false, current: false });
    await record(user, 'workout_logs');
    expect((await mine(user)).consents.workout_logs).toMatchObject({ granted: true, current: true });
    expect(await ledger(user)).toEqual([
      { purpose: 'workout_logs', granted: true, document_version: '1' },
      { purpose: 'workout_logs', granted: false, document_version: '1' },
      { purpose: 'workout_logs', granted: true, document_version: '1' },
    ]);
    const { rows } = await admin.query(
      "select private.has_consent($1, 'workout_logs') as yes, private.has_consent($1, 'emergency_contact') as no",
      [user],
    );
    expect(rows[0]).toEqual({ yes: true, no: false });
  });

  it('terms_privacy and age_16 cannot be withdrawn', async () => {
    const user = await createUser();
    await expect(withdraw(user, 'terms_privacy')).rejects.toMatchObject(raised('not_withdrawable'));
    await expect(withdraw(user, 'age_16')).rejects.toMatchObject(raised('not_withdrawable'));
    expect((await mine(user)).needs_terms_acceptance).toBe(false);
  });

  it('a version bump makes needs_terms_acceptance true again until the new version is accepted', async () => {
    const user = await createUser();
    await record(user, 'push_notifications');
    expect((await mine(user)).needs_terms_acceptance).toBe(false);

    await setVersion('privacy', '2');
    const stale = await mine(user);
    expect(stale.needs_terms_acceptance).toBe(true);
    expect(stale.terms_privacy_version).toBe('terms:1|privacy:2');
    expect(stale.consents.terms_privacy).toMatchObject({ granted: true, current: false, document_version: 'terms:1|privacy:1' });
    // Optional consents are not reset by a new notice version.
    expect(stale.consents.push_notifications).toMatchObject({ granted: true, current: true });

    await expect(record(user, 'terms_privacy', 'terms:1|privacy:1')).rejects.toMatchObject(
      raised('validation_failed:document_version'),
    );
    expect(await record(user, 'terms_privacy', 'terms:1|privacy:2')).toMatchObject({ changed: true });
    expect((await mine(user)).needs_terms_acceptance).toBe(false);

    await setVersion('terms', '2');
    expect((await mine(user)).needs_terms_acceptance).toBe(true);
    // A grant of an optional purpose after the bump records the new privacy version.
    await record(user, 'workout_logs');
    expect((await ledger(user)).at(-1)).toEqual({ purpose: 'workout_logs', granted: true, document_version: '2' });
  });

  it('an existing member with no records (before G1) needs to accept, without any backfill', async () => {
    const user = await createUser({ consent: false });
    await admin.query('insert into public.profiles (id, display_name) values ($1, $2)', [user, 'Old Timer']);
    expect(await countRows('consent_records')).toBe(0);
    expect((await mine(user)).needs_terms_acceptance).toBe(true);
  });

  it('grants are rate limited at 30 ledger events per user per hour; withdrawals are never limited', async () => {
    const user = await freshUser();
    const other = await freshUser();
    for (let i = 0; i < 14; i += 1) {
      await record(user, 'workout_logs');
      await withdraw(user, 'workout_logs');
    }
    await record(user, 'workout_logs');
    await record(user, 'emergency_contact');
    expect(await countRows('consent_records', 'user_id = $1', [user])).toBe(30);
    await expect(record(user, 'push_notifications')).rejects.toMatchObject(raised('rate_limited'));
    // An idempotent grant writes nothing and still answers.
    expect(await record(user, 'workout_logs')).toMatchObject({ changed: false });
    // Withdrawing stays possible past the cap.
    expect(await withdraw(user, 'workout_logs')).toMatchObject({ changed: true });
    expect(await countRows('consent_records', 'user_id = $1', [user])).toBe(31);
    // Other users are unaffected.
    expect(await record(other, 'workout_logs')).toMatchObject({ changed: true });

    // Time travel: the ledger refuses updates even from the owner, so the guard is switched off
    // for this fixture change only.
    await admin.query('alter table public.consent_records disable trigger consent_records_append_only');
    try {
      await admin.query(
        "update public.consent_records set created_at = created_at - interval '61 minutes' where user_id = $1",
        [user],
      );
    } finally {
      await admin.query('alter table public.consent_records enable trigger consent_records_append_only');
    }
    expect(await record(user, 'push_notifications')).toMatchObject({ changed: true });
  });

  it('isolation: a user sees only their own ledger rows; my_consents reports only the caller', async () => {
    const ana = await createUser();
    const bob = await freshUser();
    await record(ana, 'workout_logs');
    const { rows: anaSees } = await asUser(ana, (db) => db.query('select user_id from public.consent_records'));
    expect(anaSees.length).toBe(3);
    expect(new Set(anaSees.map((r) => r.user_id))).toEqual(new Set([ana]));
    const { rows: bobSees } = await asUser(bob, (db) => db.query('select * from public.consent_records'));
    expect(bobSees).toEqual([]);
    expect((await mine(bob)).consents.workout_logs.granted).toBe(false);
  });

  it('anon, service_role and callers without a user are refused', async () => {
    const user = await freshUser();
    await expect(asAnon((db) => rpc(db, 'record_consent', ['age_16', null]))).rejects.toMatchObject(denied);
    await expect(asAnon((db) => rpc(db, 'withdraw_consent', ['workout_logs']))).rejects.toMatchObject(denied);
    await expect(asAnon((db) => rpc(db, 'my_consents'))).rejects.toMatchObject(denied);
    await expect(asAnon((db) => db.query('select * from public.consent_records'))).rejects.toMatchObject(denied);
    await expect(asService((db) => rpc(db, 'record_consent', ['age_16', null]))).rejects.toMatchObject(denied);
    await expect(asService((db) => db.query('select * from public.consent_records'))).rejects.toMatchObject(denied);
    await expect(asAnon((db) => rpc(db, 'admin_set_legal_version', ['terms', '2']))).rejects.toMatchObject(denied);
    await expect(asUser(user, (db) => rpc(db, 'admin_set_legal_version', ['terms', '2']))).rejects.toMatchObject(denied);
    // A JWT whose user was deleted.
    await admin.query('delete from auth.users where id = $1', [user]);
    await expect(record(user, 'age_16')).rejects.toMatchObject(raised('not_authenticated'));
    await expect(withdraw(user, 'workout_logs')).rejects.toMatchObject(raised('not_authenticated'));
    expect(await countRows('consent_records')).toBe(0);
  });
});

describe('append-only ledger', () => {
  it('clients cannot insert, update or delete ledger rows directly', async () => {
    const user = await createUser();
    await expect(
      asUser(user, (db) =>
        db.query(
          "insert into public.consent_records (user_id, purpose, document_version, granted) values ($1, 'workout_logs', '1', true)",
          [user],
        ),
      ),
    ).rejects.toMatchObject(denied);
    await expect(
      asUser(user, (db) => db.query('update public.consent_records set granted = false where user_id = $1', [user])),
    ).rejects.toMatchObject(denied);
    await expect(
      asUser(user, (db) => db.query('delete from public.consent_records where user_id = $1', [user])),
    ).rejects.toMatchObject(denied);
    await expect(
      asService((db) => db.query('delete from public.consent_records where user_id = $1', [user])),
    ).rejects.toMatchObject(denied);
    await expect(asUser(user, (db) => db.query('truncate public.consent_records'))).rejects.toMatchObject(denied);
    expect(await countRows('consent_records', 'user_id = $1', [user])).toBe(2);
  });

  it('the trigger blocks UPDATE and DELETE even for the table owner', async () => {
    const user = await createUser();
    await expect(
      admin.query('update public.consent_records set granted = false where user_id = $1', [user]),
    ).rejects.toMatchObject(raised('consent_ledger_append_only'));
    await expect(
      admin.query('delete from public.consent_records where user_id = $1', [user]),
    ).rejects.toMatchObject(raised('consent_ledger_append_only'));
    expect(await ledger(user)).toEqual([
      { purpose: 'terms_privacy', granted: true, document_version: 'terms:1|privacy:1' },
      { purpose: 'age_16', granted: true, document_version: '1' },
    ]);
  });

  it('deleting the account (auth user) cascades its ledger rows and nobody else’s', async () => {
    const ana = await createUser();
    const bob = await createUser();
    await record(ana, 'workout_logs');
    await admin.query('delete from auth.users where id = $1', [ana]);
    expect(await countRows('consent_records', 'user_id = $1', [ana])).toBe(0);
    expect(await countRows('consent_records', 'user_id = $1', [bob])).toBe(2);
  });

  it('the guard function and the trigger are wired as documented', async () => {
    const { rows } = await admin.query(
      `select t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) as def
       from pg_trigger t where t.tgrelid = 'public.consent_records'::regclass and not t.tgisinternal`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tgenabled).toBe('O');
    expect(rows[0].def).toMatch(/BEFORE DELETE OR UPDATE ON public\.consent_records FOR EACH ROW EXECUTE FUNCTION private\.guard_consent_ledger\(\)/);
  });
});

describe('concurrency', () => {
  it('parallel grants and withdrawals leave one consistent latest state per purpose', async () => {
    const user = await freshUser();
    let before = 0;
    // Two rounds of 12 stay under the 30-events-per-hour cap.
    for (let round = 0; round < 2; round += 1) {
      const ops = Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0 ? record(user, 'push_notifications') : withdraw(user, 'push_notifications'),
      );
      const results = await Promise.all(ops);
      const rows = await ledger(user);
      // Serialized per user: events strictly alternate (no duplicate grant or withdrawal in a row).
      expect(rows[0].granted).toBe(true);
      for (let i = 1; i < rows.length; i += 1) expect(rows[i].granted, `row ${i}`).not.toBe(rows[i - 1].granted);
      // Exactly the calls that reported a change wrote a row.
      expect(results.filter((r) => r.changed).length, `round ${round}`).toBe(rows.length - before);
      before = rows.length;
      expect((await mine(user)).consents.push_notifications.granted).toBe(rows.at(-1)!.granted);
    }
  });

  it('parallel identical grants write exactly one row', async () => {
    const user = await freshUser();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => record(user, 'terms_privacy', 'terms:1|privacy:1')),
    );
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(await countRows('consent_records', 'user_id = $1', [user])).toBe(1);
  });

  it('a version bump racing a terms grant: the grant either carries the new version or is refused', async () => {
    for (let round = 0; round < 5; round += 1) {
      await resetData();
      const user = await freshUser();
      const [grant] = await Promise.allSettled([
        record(user, 'terms_privacy', 'terms:1|privacy:1'),
        setVersion('privacy', '2'),
      ]);
      const state = await mine(user);
      if (grant.status === 'fulfilled') {
        // Committed before the bump: the grant is of version 1 and now stale.
        expect(state.consents.terms_privacy).toMatchObject({ granted: true, current: false });
      } else {
        expect(grant.reason).toMatchObject(raised('validation_failed:document_version'));
        expect(state.consents.terms_privacy.granted).toBe(false);
      }
      expect(state.needs_terms_acceptance).toBe(true);
    }
  });
});
