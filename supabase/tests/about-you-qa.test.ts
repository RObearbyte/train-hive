import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { cleanText, validateContactName, validatePhone, validateRelationship } from '../../src/features/aboutYou/domain/aboutYou';
import { deleteMyAccount, exportMyData } from './account-deletion-helpers';
import {
  addMember,
  admin,
  asService,
  asUser,
  closeDb,
  createPack,
  createUser,
  grantConsents,
  INSUFFICIENT_PRIVILEGE,
  RAISED,
  resetData,
  rpc,
} from './helpers';

/**
 * P3 "About you": independent QA review (adversarial). Complements about-you.test.ts.
 *
 * Tests named "DEFECT P3-QA-n" use `it.fails`: they assert the SAFE behaviour, currently do not
 * hold, and therefore pass only while the defect exists. When the owning role fixes the defect the
 * test starts failing with "expected to fail"; then remove `.fails`. Tests named "KNOWN LIMIT"
 * document behaviour that the contract accepts or that the product owner must decide.
 */

type AboutYou = {
  birth_year: number | null;
  gender: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  tshirt_size: string | null;
  consents: { profile_demographics: boolean; emergency_contact: boolean };
};
type Cell = { key: string; count: number | null; suppressed: boolean };
type Demographics = { member_count: number; age_bands: Cell[]; genders: Cell[] } & Record<string, unknown>;

const raised = (message: string) => ({ code: RAISED, message });
const denied = { code: INSUFFICIENT_PRIVILEGE };
const BOTH = ['profile_demographics', 'emergency_contact'] as const;

const save = (userId: string, input: unknown) =>
  asUser(userId, (db) => rpc<AboutYou>(db, 'save_my_about_you', [JSON.stringify(input)]));
const getMine = (userId: string) => asUser(userId, (db) => rpc<AboutYou>(db, 'get_my_about_you'));
const withdraw = (userId: string, purpose: string) =>
  asUser(userId, (db) => rpc<{ changed: boolean }>(db, 'withdraw_consent', [purpose]));
const emergencyOf = (callerId: string, communityId: string | null, userId: string | null) =>
  asUser(callerId, (db) => rpc<Record<string, unknown>>(db, 'get_member_emergency_info', [communityId, userId]));
const emergencyList = (callerId: string, communityId: string | null) =>
  asUser(callerId, (db) => rpc<{ members: Record<string, unknown>[] }>(db, 'list_community_emergency_info', [communityId]));
const demographics = (callerId: string, communityId: string | null) =>
  asUser(callerId, (db) => rpc<Demographics>(db, 'get_community_demographics', [communityId]));

async function serverYear(): Promise<number> {
  const { rows } = await admin.query<{ y: number }>("select extract(year from (now() at time zone 'UTC'))::int as y");
  return rows[0].y;
}
async function storedRow(userId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await admin.query('select * from private.member_about_you where user_id = $1', [userId]);
  return rows[0];
}

/** Adds active members with consent and the given gender (and age, when given). */
async function addPeople(communityId: string, people: { gender?: string; age?: number }[]): Promise<string[]> {
  const year = await serverYear();
  const ids: string[] = [];
  for (const person of people) {
    const id = await addMember(communityId);
    await grantConsents(id, ['profile_demographics']);
    const input: Record<string, unknown> = {};
    if (person.gender !== undefined) input.gender = person.gender;
    if (person.age !== undefined) input.birth_year = year - person.age;
    if (Object.keys(input).length > 0) await save(id, input);
    ids.push(id);
  }
  return ids;
}
const shownCells = (list: Cell[]) => Object.fromEntries(list.map((c) => [c.key, c.suppressed ? 'x' : c.count]));

beforeEach(resetData);
afterAll(closeDb);

describe('authorization and leakage (extra)', () => {
  it('a removed or departed organizer reads nothing: contact, list, demographics', async () => {
    const pack = await createPack(1);
    const [m] = pack.memberIds;
    await grantConsents(m, BOTH);
    await save(m, { tshirt_size: 'M', emergency_contact_name: 'C', emergency_contact_phone: '0700 000 000' });
    const second = await addMember(pack.communityId, { role: 'organizer' });
    expect((await emergencyOf(second, pack.communityId, m)).tshirt_size).toBe('M');

    // Removed by another organizer.
    await asUser(pack.organizerId, (db) => rpc(db, 'remove_member', [pack.communityId, second]));
    await expect(emergencyOf(second, pack.communityId, m)).rejects.toMatchObject(raised('forbidden'));
    await expect(emergencyList(second, pack.communityId)).rejects.toMatchObject(raised('forbidden'));
    await expect(demographics(second, pack.communityId)).rejects.toMatchObject(raised('forbidden'));

    // An organizer who left (the community keeps the other one).
    const third = await addMember(pack.communityId, { role: 'organizer' });
    await asUser(third, (db) => rpc(db, 'leave_community', [pack.communityId]));
    await expect(emergencyOf(third, pack.communityId, m)).rejects.toMatchObject(raised('forbidden'));
    await expect(emergencyList(third, pack.communityId)).rejects.toMatchObject(raised('forbidden'));
    await expect(demographics(third, pack.communityId)).rejects.toMatchObject(raised('forbidden'));
  });

  it('an organizer of community B cannot reach a member who is only in A, by either community id', async () => {
    const a = await createPack(1);
    const b = await createPack(0);
    const [m] = a.memberIds;
    await grantConsents(m, ['emergency_contact']);
    await save(m, { tshirt_size: 'XL' });
    await expect(emergencyOf(b.organizerId, a.communityId, m)).rejects.toMatchObject(raised('forbidden'));
    await expect(emergencyOf(b.organizerId, b.communityId, m)).rejects.toMatchObject(raised('not_found'));
    expect((await emergencyList(b.organizerId, b.communityId)).members).toEqual([]);
    // A plain member cannot read their own record through the organizer function either.
    await expect(emergencyOf(m, a.communityId, m)).rejects.toMatchObject(raised('forbidden'));
  });

  it('no organizer response carries birth year or gender, and the demographics name nobody', async () => {
    const pack = await createPack(0);
    const year = await serverYear();
    const people = await addPeople(pack.communityId, Array.from({ length: 12 }, () => ({ gender: 'woman', age: 33 })));
    for (const id of people) {
      await grantConsents(id, ['emergency_contact']);
      await save(id, { tshirt_size: 'S', emergency_contact_name: 'Secret Contact', emergency_contact_phone: '0700 111 222' });
    }
    const one = JSON.stringify(await emergencyOf(pack.organizerId, pack.communityId, people[0]));
    const list = JSON.stringify(await emergencyList(pack.organizerId, pack.communityId));
    for (const text of [one, list]) {
      expect(text).not.toMatch(/birth|gender|woman/);
      expect(text).not.toContain(String(year - 33));
    }
    const demo = JSON.stringify(await demographics(pack.organizerId, pack.communityId));
    expect(demo).not.toContain('Secret Contact');
    expect(demo).not.toContain('0700 111 222');
    for (const id of people) expect(demo).not.toContain(id);
    expect(demo).not.toMatch(/display_name|user_id|Member|Runner/);
  });

  it('the private helpers are not callable by any API role', async () => {
    const { memberIds } = await createPack(1);
    const calls = [
      "select private.suppress_small_cells(array['a'], array[1], 5)",
      'select * from private.about_you_population(gen_random_uuid(), 2026)',
      'select private.about_you_self_json(gen_random_uuid())',
      "select private.erase_about_you_purpose(gen_random_uuid(), 'emergency_contact')",
      'select private.about_you_year()',
    ];
    for (const sql of calls) {
      await expect(asUser(memberIds[0], (db) => db.query(sql)), sql).rejects.toMatchObject(denied);
      await expect(asService((db) => db.query(sql)), sql).rejects.toMatchObject(denied);
    }
  });
});

describe('consent and data lifecycle (extra)', () => {
  it('re-granting after a withdrawal does not bring the deleted data back', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, BOTH);
    await save(m, { birth_year: (await serverYear()) - 30, gender: 'man', tshirt_size: 'L', emergency_contact_name: 'C', emergency_contact_phone: '0700 000 000' });
    await withdraw(m, 'profile_demographics');
    await withdraw(m, 'emergency_contact');
    expect(await storedRow(m)).toBeUndefined();
    await asUser(m, (db) => rpc(db, 'record_consent', ['profile_demographics']));
    await asUser(m, (db) => rpc(db, 'record_consent', ['emergency_contact']));
    expect(await storedRow(m)).toBeUndefined();
    expect(await getMine(m)).toMatchObject({ birth_year: null, gender: null, tshirt_size: null, emergency_contact_name: null });
  });

  it('clearing (null) and an empty object need no consent; a member without consents can still delete data', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await expect(save(m, {})).resolves.toMatchObject({ birth_year: null });
    await expect(save(m, { birth_year: null, gender: null, tshirt_size: null, emergency_contact_name: null })).resolves.toBeTruthy();
    // Stray data without any consent on record (written around the RPCs) can be cleared by null.
    await admin.query("insert into private.member_about_you (user_id, tshirt_size) values ($1, 'M')", [m]);
    expect((await save(m, { tshirt_size: null })).tshirt_size).toBeNull();
    expect(await storedRow(m)).toBeUndefined();
  });

  it('concurrent partial saves of different fields never lose one (serialized by the consent lock)', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, BOTH);
    const year = await serverYear();
    for (let round = 0; round < 8; round += 1) {
      await admin.query('delete from private.member_about_you where user_id = $1', [m]);
      await Promise.all([
        save(m, { birth_year: year - 20 - round }),
        save(m, { gender: 'other' }),
        save(m, { tshirt_size: 'XS' }),
        save(m, { emergency_contact_name: 'Con', emergency_contact_phone: '0700 000 000' }),
      ]);
      expect(await storedRow(m)).toMatchObject({
        birth_year: year - 20 - round,
        gender: 'other',
        tshirt_size: 'XS',
        emergency_contact_name: 'Con',
        emergency_contact_phone: '0700 000 000',
      });
    }
  });

  it('a save racing clear_my_about_you ends either empty or complete, never half-written', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, BOTH);
    for (let round = 0; round < 10; round += 1) {
      await save(m, { gender: 'man' });
      await Promise.all([
        save(m, { tshirt_size: 'M', emergency_contact_name: 'Con', emergency_contact_phone: '0700 000 000' }),
        asUser(m, (db) => rpc(db, 'clear_my_about_you')),
      ]);
      const row = await storedRow(m);
      if (row !== undefined) {
        const contact = [row.emergency_contact_name, row.emergency_contact_phone];
        expect(contact.every((v) => v === null) || contact.every((v) => v !== null)).toBe(true);
      }
    }
  });

  it('a save racing delete_my_account leaves no row behind and fails only with a clean code', async () => {
    const pack = await createPack(0);
    for (let round = 0; round < 8; round += 1) {
      const [u] = await addPeople(pack.communityId, [{ gender: 'woman' }]);
      await grantConsents(u, BOTH);
      const results = await Promise.allSettled([
        save(u, { tshirt_size: 'M', emergency_contact_name: 'Con', emergency_contact_phone: '0700 000 000' }),
        deleteMyAccount(u),
        save(u, { gender: 'man' }),
      ]);
      for (const r of results) {
        if (r.status === 'rejected') {
          expect(String((r.reason as Error).message)).toMatch(/^(not_a_member|not_authenticated|consent_required:\w+)$/);
        }
      }
      expect(await storedRow(u)).toBeUndefined();
    }
  });

  it('a withdrawal racing an export: the export shows the data or null, never a half row', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    for (let round = 0; round < 6; round += 1) {
      await grantConsents(m, BOTH);
      await save(m, { tshirt_size: 'M', emergency_contact_name: 'Con', emergency_contact_phone: '0700 000 000', gender: 'woman' });
      const [exported] = await Promise.all([exportMyData(m), withdraw(m, 'emergency_contact')]);
      const about = (exported.extensions as { about_you: Record<string, unknown> | null }).about_you;
      if (about !== null) {
        expect(about.emergency_contact_name === null).toBe(about.emergency_contact_phone === null);
      }
      await withdraw(m, 'profile_demographics');
    }
  });

  it('KNOWN LIMIT: a grant is stamped with the privacy version in force, not the text the app showed', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    // The app records optional purposes without a version; a build that bundles privacy v2 while
    // the server still holds v1 therefore leaves a v1 stamp for a consent given on the v2 text.
    await expect(
      asUser(m, (db) => rpc(db, 'record_consent', ['profile_demographics', '2'])),
    ).rejects.toMatchObject(raised('validation_failed:document_version'));
    await asUser(m, (db) => rpc(db, 'record_consent', ['profile_demographics']));
    await asService((db) => rpc(db, 'admin_set_legal_version', ['privacy', '2']));
    const { rows } = await admin.query<{ document_version: string }>(
      "select document_version from public.consent_records where user_id = $1 and purpose = 'profile_demographics'",
      [m],
    );
    expect(rows.map((r) => r.document_version)).toEqual(['1']);
    // And it stays current after the bump: nobody is asked again for the new wording.
    const { rows: current } = await admin.query<{ ok: boolean }>("select private.has_consent($1, 'profile_demographics') as ok", [m]);
    expect(current[0].ok).toBe(true);
  });

  it('the export and the erasure also cover a row whose consent is gone (stray data)', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await admin.query("insert into private.member_about_you (user_id, birth_year) values ($1, 1990)", [m]);
    const exported = await exportMyData(m);
    expect((exported.extensions as { about_you: { birth_year: number } }).about_you.birth_year).toBe(1990);
    await deleteMyAccount(m);
    expect(await storedRow(m)).toBeUndefined();
  });
});

describe('input edge cases (extra)', () => {
  it('birth year: only a JSON number that is a whole in-range value', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['profile_demographics']);
    const year = await serverYear();
    for (const raw of ['"1990"', 'true', '[1990]', '{"a":1}', '1e400', '1990.5', '-1990', '1e3', '0']) {
      await expect(
        asUser(m, (db) => rpc(db, 'save_my_about_you', [`{"birth_year": ${raw}}`])),
        raw,
      ).rejects.toMatchObject(raised('validation_failed:birth_year'));
    }
    expect((await save(m, { birth_year: year - 16 })).birth_year).toBe(year - 16);
    await expect(save(m, { birth_year: year - 15 })).rejects.toMatchObject(raised('validation_failed:birth_year'));
    await expect(save(m, { birth_year: year - 101 })).rejects.toMatchObject(raised('validation_failed:birth_year'));
    expect((await asUser(m, (db) => rpc<AboutYou>(db, 'save_my_about_you', ['{"birth_year": 1990.0}']))).birth_year).toBe(1990);
  });

  it('phone numbers: look-alike digits, misplaced plus and separators-only are refused', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['emergency_contact']);
    const bad = [
      '１２３４５６７８９０', // full-width digits
      '٠٧٠٠٠٠٠٠٠٠', // Arabic-Indic digits
      '++40700000000',
      '+',
      '( ) . / - ( ) . / -',
      'tel:0700000000',
      '0700000000;ext=1',
      '0700000000,1',
      '0700#000000',
      '0700*000000',
    ];
    for (const phone of bad) {
      await expect(save(m, { emergency_contact_name: 'C', emergency_contact_phone: phone }), phone).rejects.toMatchObject(
        raised('validation_failed:emergency_contact_phone'),
      );
    }
  });

  it('names are counted in characters and stored as plain text (markup is data, not interpreted)', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['emergency_contact']);
    const phone = '0700 000 000';
    expect((await save(m, { emergency_contact_name: '😀'.repeat(80), emergency_contact_phone: phone })).emergency_contact_name).toBe('😀'.repeat(80));
    await expect(save(m, { emergency_contact_name: '😀'.repeat(81) })).rejects.toMatchObject(raised('validation_failed:emergency_contact_name'));
    const hostile = '<b>x</b> {{7*7}} ${1+1} \'); drop table--';
    expect((await save(m, { emergency_contact_name: hostile })).emergency_contact_name).toBe(hostile);
    expect(await storedRow(m)).toMatchObject({ emergency_contact_name: hostile });
  });

  it('a T-shirt size is one of six values in any case, with plain surrounding spaces only', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['emergency_contact']);
    expect((await save(m, { tshirt_size: ' xl ' })).tshirt_size).toBe('XL');
    for (const size of ['XXXL', 'xs\n', 'Ｍ', '', ' ', 'M M', 5]) {
      await expect(save(m, { tshirt_size: size }), String(size)).rejects.toMatchObject(raised('validation_failed:tshirt_size'));
    }
  });
});

describe('client and server agree on what a valid value is', () => {
  const phones = [
    '+40 700 000 000', '(0700) 000-000', '0700/000.000', '07 00 00 00 00 ', '00 40 700 000 000', '+(40) 700 000 000',
    '123456', '12345', '1'.repeat(20), '1'.repeat(21), '１２３４５６７８', 'call me', '0700000000;1', '+40-700-000-000',
    '( ) . / - 7 0 0 0 0 0 0', '7000000 000', '\t0700 000 000\n', '0700​000000',
  ];

  it('every phone the form accepts is accepted by the server, and what is sent is stored unchanged', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['emergency_contact']);
    for (const phone of phones) {
      const clean = cleanText(phone);
      const clientOk = clean !== '' && validatePhone(phone) === null;
      let stored: string | null = null;
      let serverOk = true;
      try {
        stored = (await save(m, { emergency_contact_name: 'C', emergency_contact_phone: clean })).emergency_contact_phone;
      } catch {
        serverOk = false;
      }
      if (clientOk) {
        expect(serverOk, JSON.stringify(phone)).toBe(true);
        expect(stored, JSON.stringify(phone)).toBe(clean);
      }
      if (serverOk) expect(validatePhone(clean), `server accepts ${JSON.stringify(phone)}`).toBeNull();
    }
  });

  // DEFECT P3-QA-5 (low): src/features/aboutYou/domain/aboutYou.ts validatePhone allows "+" anywhere
  // (regex /^[0-9 +()./-]+$/); the server requires it only as the first character. The form says
  // "valid", Save then fails with a generic server message.
  it.fails('DEFECT P3-QA-5: a plus sign inside the number is refused by the form too', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['emergency_contact']);
    for (const phone of ['12+345678', '0700 000+000', '++40700000000']) {
      let serverOk = true;
      try {
        await save(m, { emergency_contact_name: 'C', emergency_contact_phone: phone });
      } catch {
        serverOk = false;
      }
      expect(validatePhone(phone) === null, phone).toBe(serverOk);
    }
  });

  it('names and relationships: the cleaned value the form sends is stored as is, and limits match', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, ['emergency_contact']);
    const texts = [
      ' Ana  Maria ', 'A\tB', 'A B', 'A​B', 'A­B', '‮evil‬', 'x'.repeat(80), '😀'.repeat(40),
      'é'.repeat(40), '<script>alert(1)</script>', 'Ion    Pop', 'A B', 'A\u0085B',
    ];
    for (const text of texts) {
      const clean = cleanText(text);
      if (clean === '' || validateContactName(text) !== null) continue;
      const saved = await save(m, { emergency_contact_name: clean, emergency_contact_phone: '0700 000 000' });
      expect(saved.emergency_contact_name, JSON.stringify(text)).toBe(clean);
    }
    for (const [name, max, validate] of [
      ['emergency_contact_name', 80, validateContactName],
      ['emergency_contact_relationship', 40, validateRelationship],
    ] as const) {
      expect(validate('y'.repeat(max))).toBeNull();
      expect(validate('y'.repeat(max + 1))).not.toBeNull();
      expect((await save(m, { [name]: 'y'.repeat(max) }))[name]).toHaveLength(max);
      await expect(save(m, { [name]: 'y'.repeat(max + 1) })).rejects.toMatchObject(raised(`validation_failed:${name}`));
    }
  });
});

describe('suppression: exhaustive and attacker-aware', () => {
  /** Runs private.suppress_small_cells over every distribution and returns the number of broken invariants. */
  async function violations(cellCount: number, values: number[]): Promise<number> {
    const keys = Array.from({ length: cellCount }, (_, i) => `'k${i}'`).join(', ');
    const froms = Array.from({ length: cellCount }, (_, i) => `unnest($1::int[]) as v${i}(n)`).join(' cross join ');
    const arr = Array.from({ length: cellCount }, (_, i) => `v${i}.n`).join(', ');
    const { rows } = await admin.query<{ bad: string }>(
      `with combos as (select array[${arr}] as cnt from ${froms}),
            res as (select cnt, private.suppress_small_cells(array[${keys}], cnt, 5) as r from combos),
            cells as (
              select res.cnt, e.ord, (e.v ->> 'suppressed')::boolean as sup, (e.v ->> 'count')::int as shown, res.cnt[e.ord] as real
              from res, jsonb_array_elements(res.r) with ordinality as e(v, ord)
            ),
            agg as (
              select cnt,
                     count(*) filter (where sup) as k,
                     coalesce(sum(real) filter (where sup), 0) as s,
                     count(*) filter (where not sup) as n_shown,
                     bool_or(not sup and shown <> real) as wrong,
                     bool_or(not sup and shown < 5) as low,
                     bool_or(sup and shown is not null) as leaked,
                     bool_or(real < 5 and not sup) as small_shown
              from cells group by cnt
            )
       select count(*) as bad from agg
       where wrong or low or leaked or small_shown
          or (k > 0 and n_shown > 0 and (k < 2 or s < 5))`,
      [values],
    );
    return Number(rows[0].bad);
  }

  it('5 cells, every count 0..9: a shown cell is exact and at least 5; hidden cells are 2+ and add up to 5+', async () => {
    expect(await violations(5, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(0);
  }, 120_000);

  it('7 cells over a spread of values', async () => {
    expect(await violations(7, [0, 2, 4, 5, 9, 40])).toBe(0);
  }, 120_000);

  it('with the community size known, no single response pins a hidden group below 5 to one cell', async () => {
    // An attacker knows the total and the shown cells, so the hidden sum S and the number of hidden
    // cells k. A cell is "pinned" when every split of S over k cells gives it the same value: only
    // k = 1 or S = 0 can do that, and the rule forbids both whenever something is shown.
    const { rows } = await admin.query<{ bad: string }>(
      `with c as (select array[a, b, c, d, e] as cnt
                  from generate_series(0, 8) a, generate_series(0, 8) b, generate_series(0, 8) c,
                       generate_series(0, 8) d, generate_series(0, 8) e),
            r as (select cnt, private.suppress_small_cells(array['a','b','c','d','e'], cnt, 5) as j from c),
            h as (
              select cnt, count(*) filter (where (x.v ->> 'suppressed')::boolean) as k,
                     coalesce(sum(cnt[x.ord]) filter (where (x.v ->> 'suppressed')::boolean), 0) as s,
                     count(*) filter (where not (x.v ->> 'suppressed')::boolean) as shown
              from r, jsonb_array_elements(r.j) with ordinality as x(v, ord) group by cnt
            )
       select count(*) as bad from h where shown > 0 and k > 0 and (k = 1 or s = 0)`,
    );
    expect(Number(rows[0].bad)).toBe(0);
  }, 120_000);

  // DEFECT P3-QA-1 (medium, design): the 5-person rule does not protect against an organizer who
  // can add members. Organizers create invitation codes and anonymous accounts are free, so eight
  // accounts (four "woman", four "prefer_not_to_say") lift a hidden group of ONE woman to a shown 5;
  // 5 minus the 4 added reveals the real size. This test asserts the safe behaviour (the cell stays
  // hidden) and therefore passes only while the defect exists.
  it.fails('DEFECT P3-QA-1: sock-puppet accounts cannot lift a hidden group above the threshold', async () => {
    const pack = await createPack(0);
    await addPeople(pack.communityId, [...Array.from({ length: 12 }, () => ({ gender: 'man' })), { gender: 'woman' }]);
    const before = await demographics(pack.organizerId, pack.communityId);
    expect(before.genders.every((c) => c.suppressed)).toBe(true); // 12 / 1 / organizer 1: all hidden

    await addPeople(pack.communityId, [
      ...Array.from({ length: 4 }, () => ({ gender: 'woman' })),
      ...Array.from({ length: 4 }, () => ({ gender: 'prefer_not_to_say' })),
    ]);
    const after = await demographics(pack.organizerId, pack.communityId);
    // The organizer would now read woman = 5 and subtract the 4 accounts it added.
    expect(shownCells(after.genders).woman).toBe('x');
  });

  it('KNOWN LIMIT: removing one member shows the organizer which group that member was in', async () => {
    const pack = await createPack(0);
    const men = await addPeople(pack.communityId, Array.from({ length: 10 }, () => ({ gender: 'man' })));
    await addPeople(pack.communityId, Array.from({ length: 6 }, () => ({ gender: 'woman' })));
    expect(shownCells((await demographics(pack.organizerId, pack.communityId)).genders)).toMatchObject({ man: 10 });
    await asUser(pack.organizerId, (db) => rpc(db, 'remove_member', [pack.communityId, men[0]]));
    // 10 -> 9: the removed person was a man. Contract: differencing over time is not prevented.
    expect(shownCells((await demographics(pack.organizerId, pack.communityId)).genders)).toMatchObject({ man: 9 });
  });

  it('consent withdrawal moves a person to not_provided at once (no stale count)', async () => {
    const pack = await createPack(0);
    const people = await addPeople(pack.communityId, Array.from({ length: 12 }, () => ({ gender: 'woman', age: 41 })));
    await addPeople(pack.communityId, Array.from({ length: 8 }, () => ({ gender: 'man', age: 25 })));
    await withdraw(people[0], 'profile_demographics');
    const d = await demographics(pack.organizerId, pack.communityId);
    expect(shownCells(d.genders)).toMatchObject({ woman: 11, man: 'x' });
    expect(shownCells(d.age_bands)).toMatchObject({ '40_49': 11, '18_29': 'x' });
  });
});

describe('legal text and join gate (server side)', () => {
  it('a user who never accepted anything cannot save About-you details until the optional consent is recorded', async () => {
    const userId = await createUser({ consent: false });
    await admin.query('insert into public.profiles (id, display_name) values ($1, $2)', [userId, 'No Terms']);
    await expect(save(userId, { gender: 'man' })).rejects.toMatchObject(raised('consent_required:profile_demographics'));
  });
});
