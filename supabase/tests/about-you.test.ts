import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { deleteMyAccount, exportMyData } from './account-deletion-helpers';
import {
  addMember,
  admin,
  asAnon,
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
 * P3 "About you": the member's own details, consent gating, withdrawal, organizer access to
 * emergency contact / T-shirt size, and the suppressed demographics. Contract: docs/API_CONTRACT.md
 * ("About you (P3)").
 */

type AboutYou = {
  has_data: boolean;
  birth_year: number | null;
  gender: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  tshirt_size: string | null;
  updated_at: string | null;
  birth_year_min: number;
  birth_year_max: number;
  consents: { profile_demographics: boolean; emergency_contact: boolean };
  cleared?: boolean;
};

type EmergencyInfo = {
  community_id?: string;
  user_id: string;
  display_name: string;
  role: string;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  tshirt_size: string | null;
  has_emergency_contact: boolean;
  updated_at: string | null;
};

type Cell = { key: string; count: number | null; suppressed: boolean };
type Demographics = {
  community_id: string;
  min_group_size: number;
  min_members_with_data: number;
  rounded_to: number;
  member_count: number;
  reference_year: number;
  insufficient_data: { age_bands: boolean; genders: boolean };
  age_bands: Cell[];
  genders: Cell[];
};

const raised = (message: string) => ({ code: RAISED, message });
const denied = { code: INSUFFICIENT_PRIVILEGE };

const save = (userId: string, input: unknown) =>
  asUser(userId, (db) => rpc<AboutYou>(db, 'save_my_about_you', [input === null ? null : JSON.stringify(input)]));
const getMine = (userId: string) => asUser(userId, (db) => rpc<AboutYou>(db, 'get_my_about_you'));
const clearMine = (userId: string) => asUser(userId, (db) => rpc<AboutYou>(db, 'clear_my_about_you'));
const withdraw = (userId: string, purpose: string) =>
  asUser(userId, (db) => rpc<{ changed: boolean }>(db, 'withdraw_consent', [purpose]));
const emergencyOf = (callerId: string, communityId: string | null, userId: string | null) =>
  asUser(callerId, (db) => rpc<EmergencyInfo>(db, 'get_member_emergency_info', [communityId, userId]));
const emergencyList = (callerId: string, communityId: string | null) =>
  asUser(callerId, (db) =>
    rpc<{ community_id: string; members: EmergencyInfo[]; truncated: boolean }>(db, 'list_community_emergency_info', [
      communityId,
    ]),
  );
const demographics = (callerId: string, communityId: string | null) =>
  asUser(callerId, (db) => rpc<Demographics>(db, 'get_community_demographics', [communityId]));

const BOTH = ['profile_demographics', 'emergency_contact'] as const;

async function serverYear(): Promise<number> {
  const { rows } = await admin.query<{ y: number }>("select extract(year from (now() at time zone 'UTC'))::int as y");
  return rows[0].y;
}

/** The stored row (superuser), or undefined. */
async function storedRow(userId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await admin.query('select * from private.member_about_you where user_id = $1', [userId]);
  return rows[0];
}

const CONTACT = {
  emergency_contact_name: 'Contact Person',
  emergency_contact_phone: '+40 700 000 000',
  emergency_contact_relationship: 'Sibling',
};

beforeEach(resetData);
afterAll(closeDb);

describe('own data: get / save / clear', () => {
  it('starts empty, with the birth-year range from the server clock', async () => {
    const { memberIds } = await createPack(1);
    const year = await serverYear();
    expect(await getMine(memberIds[0])).toEqual({
      has_data: false,
      birth_year: null,
      gender: null,
      emergency_contact_name: null,
      emergency_contact_phone: null,
      emergency_contact_relationship: null,
      tshirt_size: null,
      updated_at: null,
      birth_year_min: year - 100,
      birth_year_max: year - 16,
      consents: { profile_demographics: false, emergency_contact: false },
    });
  });

  it('saves every field with the consents and reads them back', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    const year = await serverYear();
    await grantConsents(m, BOTH);
    const saved = await save(m, { birth_year: year - 30, gender: 'woman', tshirt_size: 'M', ...CONTACT });
    expect(saved).toMatchObject({
      has_data: true,
      birth_year: year - 30,
      gender: 'woman',
      tshirt_size: 'M',
      ...CONTACT,
      consents: { profile_demographics: true, emergency_contact: true },
    });
    expect(await getMine(m)).toEqual(saved);
  });

  it('partial update: absent keys are unchanged, null clears a field, nothing left deletes the row', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    const year = await serverYear();
    await grantConsents(m, BOTH);
    await save(m, { birth_year: year - 40, gender: 'man', tshirt_size: 'L', ...CONTACT });

    expect(await save(m, { tshirt_size: 'xl ' })).toMatchObject({ birth_year: year - 40, gender: 'man', tshirt_size: 'XL', ...CONTACT });
    expect(await save(m, { gender: null })).toMatchObject({ birth_year: year - 40, gender: null, tshirt_size: 'XL' });
    expect(await save(m, { emergency_contact_relationship: null })).toMatchObject({
      emergency_contact_name: CONTACT.emergency_contact_name,
      emergency_contact_relationship: null,
    });
    // An empty object changes nothing.
    const before = await getMine(m);
    expect(await save(m, {})).toEqual(before);

    await save(m, {
      birth_year: null,
      tshirt_size: null,
      emergency_contact_name: null,
      emergency_contact_phone: null,
    });
    expect(await storedRow(m)).toBeUndefined();
    expect((await getMine(m)).has_data).toBe(false);
  });

  it('clear_my_about_you deletes the row and keeps the consents', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, BOTH);
    await save(m, { gender: 'other', tshirt_size: 'S', ...CONTACT });
    const cleared = await clearMine(m);
    expect(cleared).toMatchObject({ cleared: true, has_data: false, gender: null, tshirt_size: null });
    expect(cleared.consents).toEqual({ profile_demographics: true, emergency_contact: true });
    expect(await storedRow(m)).toBeUndefined();
    expect((await clearMine(m)).cleared).toBe(false);
  });

  it('a user without a profile (never joined) cannot save: not_a_member', async () => {
    const user = await createUser();
    await grantConsents(user, BOTH);
    await expect(save(user, { tshirt_size: 'M' })).rejects.toMatchObject(raised('not_a_member'));
    expect((await getMine(user)).has_data).toBe(false);
  });

  it('anon cannot call any About-you function; the table is unreachable for every API role', async () => {
    const { communityId, memberIds } = await createPack(1);
    const calls: [string, unknown[]][] = [
      ['select public.get_my_about_you()', []],
      ['select public.save_my_about_you($1)', ['{}']],
      ['select public.clear_my_about_you()', []],
      ['select public.get_member_emergency_info($1, $2)', [communityId, memberIds[0]]],
      ['select public.list_community_emergency_info($1)', [communityId]],
      ['select public.get_community_demographics($1)', [communityId]],
    ];
    for (const [sql, params] of calls) {
      await expect(asAnon((db) => db.query(sql, params)), sql).rejects.toMatchObject(denied);
      await expect(asService((db) => db.query(sql, params)), sql).rejects.toMatchObject(denied);
    }
    await expect(
      asUser(memberIds[0], (db) => db.query('select * from private.member_about_you')),
    ).rejects.toMatchObject(denied);
    await expect(
      asUser(memberIds[0], (db) =>
        db.query("insert into private.member_about_you (user_id, tshirt_size) values ($1, 'M')", [memberIds[0]]),
      ),
    ).rejects.toMatchObject(denied);
  });
});

describe('consent gating', () => {
  it('demographics need profile_demographics; the contact and the T-shirt size need emergency_contact', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    const year = await serverYear();

    await expect(save(m, { birth_year: year - 30 })).rejects.toMatchObject(raised('consent_required:profile_demographics'));
    await expect(save(m, { gender: 'man' })).rejects.toMatchObject(raised('consent_required:profile_demographics'));
    await expect(save(m, CONTACT)).rejects.toMatchObject(raised('consent_required:emergency_contact'));
    await expect(save(m, { emergency_contact_relationship: 'Friend' })).rejects.toMatchObject(
      raised('consent_required:emergency_contact'),
    );
    // Nothing was written by the refused calls.
    expect(await storedRow(m)).toBeUndefined();

    await expect(save(m, { tshirt_size: 'XS' })).rejects.toMatchObject(raised('consent_required:emergency_contact'));
    // Nothing was written by the refused calls.
    expect(await storedRow(m)).toBeUndefined();
    // Clearing never needs a consent.
    expect(
      await save(m, { birth_year: null, gender: null, emergency_contact_name: null, tshirt_size: null }),
    ).toMatchObject({ has_data: false });

    await grantConsents(m, ['emergency_contact']);
    await expect(save(m, { gender: 'man', ...CONTACT })).rejects.toMatchObject(
      raised('consent_required:profile_demographics'),
    );
    expect(await save(m, { tshirt_size: 'XS', ...CONTACT })).toMatchObject({ tshirt_size: 'XS', ...CONTACT });

    // Clearing the T-shirt size after the consent is gone (stray data written around the RPCs).
    await admin.query(
      "insert into public.consent_records (user_id, purpose, document_version, granted) values ($1, 'emergency_contact', '1', false)",
      [m],
    );
    await admin.query("update private.member_about_you set tshirt_size = 'M' where user_id = $1", [m]);
    expect((await save(m, { tshirt_size: null })).tshirt_size).toBeNull();
  });

  it('a consent granted through record_consent unlocks the save', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await asUser(m, (db) => rpc(db, 'record_consent', ['profile_demographics']));
    expect(await save(m, { gender: 'prefer_not_to_say' })).toMatchObject({ gender: 'prefer_not_to_say' });
  });
});

describe('validation and text hygiene', () => {
  it('rejects bad input shapes and unknown keys', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    for (const input of [null, [], 'x', 5, { nickname: 'x' }, { tshirt_size: 'M', birthyear: 1990 }]) {
      await expect(save(m, input), JSON.stringify(input)).rejects.toMatchObject(raised('validation_failed:input'));
    }
  });

  it('birth year: an integer between server year - 100 and server year - 16', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, BOTH);
    const year = await serverYear();
    for (const bad of [year - 15, year - 101, year, `${year - 30}`, year - 30.5, 1e20, -1, true]) {
      await expect(save(m, { birth_year: bad }), String(bad)).rejects.toMatchObject(raised('validation_failed:birth_year'));
    }
    expect((await save(m, { birth_year: year - 16 })).birth_year).toBe(year - 16);
    expect((await save(m, { birth_year: year - 100 })).birth_year).toBe(year - 100);
  });

  it('gender and T-shirt size: fixed lists (T-shirt case-insensitive, stored upper case)', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, BOTH);
    for (const bad of ['female', 'Woman', '', 1]) {
      await expect(save(m, { gender: bad })).rejects.toMatchObject(raised('validation_failed:gender'));
    }
    for (const bad of ['XXXL', 'medium', '', 2]) {
      await expect(save(m, { tshirt_size: bad })).rejects.toMatchObject(raised('validation_failed:tshirt_size'));
    }
    for (const size of ['XS', 'S', 'M', 'L', 'XL', 'XXL']) {
      expect((await save(m, { tshirt_size: size.toLowerCase() })).tshirt_size).toBe(size);
    }
    for (const gender of ['woman', 'man', 'other', 'prefer_not_to_say']) {
      expect((await save(m, { gender })).gender).toBe(gender);
    }
  });

  it('contact texts go through the shared hygiene (controls, bidi, invisible-only, length)', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, BOTH);
    const saved = await save(m, {
      emergency_contact_name: '  Contact‮  \u0007Person⁦ ',
      emergency_contact_phone: ' +40\t700 000\u0001 000 ',
      emergency_contact_relationship: 'Partner\n',
    });
    expect(saved).toMatchObject({
      emergency_contact_name: 'Contact Person',
      emergency_contact_phone: '+40 700 000 000',
      emergency_contact_relationship: 'Partner',
    });

    const bad: [string, unknown][] = [
      ['emergency_contact_name', '​⁠'],
      ['emergency_contact_name', ''],
      ['emergency_contact_name', 'x'.repeat(81)],
      ['emergency_contact_name', 7],
      ['emergency_contact_relationship', '   '],
      ['emergency_contact_relationship', 'y'.repeat(41)],
      ['emergency_contact_phone', 'call me'],
      ['emergency_contact_phone', '12345'],
      ['emergency_contact_phone', '1'.repeat(21)],
      ['emergency_contact_phone', '+40 700 000 000 ext 5'],
      ['emergency_contact_phone', '9'.repeat(31)],
    ];
    for (const [field, value] of bad) {
      await expect(save(m, { [field]: value }), `${field}=${String(value)}`).rejects.toMatchObject(
        raised(`validation_failed:${field}`),
      );
    }
    expect((await save(m, { emergency_contact_name: 'x'.repeat(80) })).emergency_contact_name).toHaveLength(80);
    expect((await save(m, { emergency_contact_phone: '(0700) 000-000' })).emergency_contact_phone).toBe('(0700) 000-000');
  });

  it('an emergency contact needs a name and a phone after the merge', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, BOTH);
    await expect(save(m, { emergency_contact_name: 'Contact Person' })).rejects.toMatchObject(
      raised('validation_failed:emergency_contact_phone'),
    );
    await expect(save(m, { emergency_contact_relationship: 'Friend' })).rejects.toMatchObject(
      raised('validation_failed:emergency_contact_name'),
    );
    await save(m, CONTACT);
    // Clearing only the phone would leave half a contact.
    await expect(save(m, { emergency_contact_phone: null })).rejects.toMatchObject(
      raised('validation_failed:emergency_contact_phone'),
    );
    expect(await storedRow(m)).toMatchObject({ emergency_contact_phone: CONTACT.emergency_contact_phone });
  });
});

describe('withdrawing a consent deletes the data it covered', () => {
  it('profile_demographics removes birth year and gender only', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    const year = await serverYear();
    await grantConsents(m, BOTH);
    await save(m, { birth_year: year - 25, gender: 'woman', tshirt_size: 'S', ...CONTACT });

    expect((await withdraw(m, 'profile_demographics')).changed).toBe(true);
    expect(await getMine(m)).toMatchObject({
      birth_year: null,
      gender: null,
      tshirt_size: 'S',
      ...CONTACT,
      consents: { profile_demographics: false, emergency_contact: true },
    });
    await expect(save(m, { gender: 'woman' })).rejects.toMatchObject(raised('consent_required:profile_demographics'));
  });

  it('emergency_contact removes the contact and the T-shirt size; a row left empty is deleted', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, BOTH);
    await save(m, { tshirt_size: 'M', ...CONTACT });
    expect((await withdraw(m, 'emergency_contact')).changed).toBe(true);
    expect(await storedRow(m)).toBeUndefined();

    // T-shirt size alone goes too.
    await grantConsents(m, ['emergency_contact']);
    await save(m, { tshirt_size: 'L' });
    await withdraw(m, 'emergency_contact');
    expect(await storedRow(m)).toBeUndefined();
    await expect(save(m, { tshirt_size: 'L' })).rejects.toMatchObject(raised('consent_required:emergency_contact'));

    const year = await serverYear();
    await grantConsents(m, ['emergency_contact']);
    await save(m, { birth_year: year - 50, tshirt_size: 'S', ...CONTACT });
    await withdraw(m, 'emergency_contact');
    expect(await storedRow(m)).toMatchObject({
      birth_year: year - 50,
      emergency_contact_name: null,
      emergency_contact_phone: null,
      emergency_contact_relationship: null,
      tshirt_size: null,
    });
    await withdraw(m, 'profile_demographics');
    expect(await storedRow(m)).toBeUndefined();
  });

  it('deletes stray data even when no grant is on record (nothing written to the ledger)', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await admin.query(
      `insert into private.member_about_you (user_id, birth_year, gender, emergency_contact_name, emergency_contact_phone, tshirt_size)
       values ($1, 1990, 'man', 'Contact Person', '+40 700 000 000', 'M')`,
      [m],
    );
    expect((await withdraw(m, 'profile_demographics')).changed).toBe(false);
    expect(await storedRow(m)).toMatchObject({ birth_year: null, gender: null, tshirt_size: 'M' });
    expect((await withdraw(m, 'emergency_contact')).changed).toBe(false);
    expect(await storedRow(m)).toBeUndefined();
    const { rows } = await admin.query('select count(*)::int as n from public.consent_records where user_id = $1 and not granted', [m]);
    expect(rows[0].n).toBe(0);
  });

  it('a save racing a withdrawal never leaves data without a current consent', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    const year = await serverYear();
    for (let round = 0; round < 12; round += 1) {
      await grantConsents(m, BOTH);
      const results = await Promise.allSettled([
        save(m, { birth_year: year - 30, gender: 'woman', tshirt_size: 'M', ...CONTACT }),
        withdraw(m, round % 2 === 0 ? 'profile_demographics' : 'emergency_contact'),
        save(m, { gender: 'man', emergency_contact_relationship: 'Friend' }),
      ]);
      for (const r of results) {
        if (r.status === 'rejected') {
          expect(String((r.reason as Error).message)).toMatch(/^consent_required:|^validation_failed:emergency_contact_name$/);
        }
      }
      const { rows } = await admin.query<{ bad: boolean }>(
        `select (a.birth_year is not null or a.gender is not null) and not private.has_consent(a.user_id, 'profile_demographics')
                or (a.emergency_contact_name is not null or a.tshirt_size is not null)
                   and not private.has_consent(a.user_id, 'emergency_contact') as bad
         from private.member_about_you a where a.user_id = $1`,
        [m],
      );
      expect(rows.every((r) => !r.bad)).toBe(true);
    }
  });

  it('withdrawing another purpose touches nothing', async () => {
    const { memberIds } = await createPack(1);
    const [m] = memberIds;
    await grantConsents(m, [...BOTH, 'workout_logs']);
    await save(m, { gender: 'other', ...CONTACT });
    await withdraw(m, 'workout_logs');
    await withdraw(m, 'push_notifications');
    expect(await storedRow(m)).toMatchObject({ gender: 'other', ...CONTACT });
  });
});

describe('organizer access to emergency contact and T-shirt size', () => {
  it('authorization matrix for get_member_emergency_info', async () => {
    const pack = await createPack(2);
    const other = await createPack(1);
    const [m, m2] = pack.memberIds;
    const removedOrganizer = await addMember(pack.communityId, { role: 'organizer', status: 'removed' });
    const removedMember = await addMember(pack.communityId, { status: 'removed' });
    await grantConsents(m, BOTH);
    const year = await serverYear();
    await save(m, { birth_year: year - 33, gender: 'woman', tshirt_size: 'M', ...CONTACT });

    const info = await emergencyOf(pack.organizerId, pack.communityId, m);
    expect(info).toEqual({
      community_id: pack.communityId,
      user_id: m,
      display_name: 'Member 1',
      role: 'member',
      ...CONTACT,
      tshirt_size: 'M',
      has_emergency_contact: true,
      updated_at: expect.any(String),
    });
    // Age and gender never reach an organizer per person.
    expect(JSON.stringify(info)).not.toMatch(/birth|gender|woman/);

    // A member without data: fields null.
    expect(await emergencyOf(pack.organizerId, pack.communityId, m2)).toMatchObject({
      user_id: m2,
      emergency_contact_name: null,
      tshirt_size: null,
      has_emergency_contact: false,
      updated_at: null,
    });

    const forbidden = raised('forbidden');
    await expect(emergencyOf(m2, pack.communityId, m)).rejects.toMatchObject(forbidden);
    await expect(emergencyOf(m, pack.communityId, m)).rejects.toMatchObject(forbidden);
    await expect(emergencyOf(other.organizerId, pack.communityId, m)).rejects.toMatchObject(forbidden);
    await expect(emergencyOf(removedOrganizer, pack.communityId, m)).rejects.toMatchObject(forbidden);
    await expect(emergencyOf(pack.organizerId, null, m)).rejects.toMatchObject(forbidden);
    await expect(
      emergencyOf(pack.organizerId, '00000000-0000-0000-0000-000000000000', m),
    ).rejects.toMatchObject(forbidden);
    // The other community's organizer asking through their own community: not a member there.
    await expect(emergencyOf(other.organizerId, other.communityId, m)).rejects.toMatchObject(raised('not_found'));

    await expect(emergencyOf(pack.organizerId, pack.communityId, null)).rejects.toMatchObject(
      raised('validation_failed:user_id'),
    );
    await expect(emergencyOf(pack.organizerId, pack.communityId, removedMember)).rejects.toMatchObject(raised('not_found'));
    await expect(
      emergencyOf(pack.organizerId, pack.communityId, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject(raised('not_found'));
  });

  it('leaving or being removed ends the organizers’ access at once; other communities keep it', async () => {
    const a = await createPack(1);
    const b = await createPack(0);
    const [m] = a.memberIds;
    await admin.query("insert into public.memberships (community_id, user_id, role) values ($1, $2, 'member')", [
      b.communityId,
      m,
    ]);
    await grantConsents(m, BOTH);
    await save(m, { tshirt_size: 'L', ...CONTACT });

    expect((await emergencyOf(a.organizerId, a.communityId, m)).has_emergency_contact).toBe(true);
    expect((await emergencyList(a.organizerId, a.communityId)).members.map((x) => x.user_id)).toEqual([m]);

    await asUser(m, (db) => rpc(db, 'leave_community', [a.communityId]));
    await expect(emergencyOf(a.organizerId, a.communityId, m)).rejects.toMatchObject(raised('not_found'));
    expect((await emergencyList(a.organizerId, a.communityId)).members).toEqual([]);
    // Still an active member of b.
    expect(await emergencyOf(b.organizerId, b.communityId, m)).toMatchObject({ tshirt_size: 'L', ...CONTACT });

    await asUser(b.organizerId, (db) => rpc(db, 'remove_member', [b.communityId, m]));
    await expect(emergencyOf(b.organizerId, b.communityId, m)).rejects.toMatchObject(raised('not_found'));
    expect((await emergencyList(b.organizerId, b.communityId)).members).toEqual([]);
  });

  it('an organizer who stepped down loses access', async () => {
    const pack = await createPack(1);
    const second = await addMember(pack.communityId, { role: 'organizer', name: 'Second Organizer' });
    const [m] = pack.memberIds;
    await grantConsents(m, ['emergency_contact']);
    await save(m, { tshirt_size: 'S' });
    expect((await emergencyOf(second, pack.communityId, m)).tshirt_size).toBe('S');
    await asUser(pack.organizerId, (db) => rpc(db, 'set_member_role', [pack.communityId, second, 'member']));
    await expect(emergencyOf(second, pack.communityId, m)).rejects.toMatchObject(raised('forbidden'));
    await expect(emergencyList(second, pack.communityId)).rejects.toMatchObject(raised('forbidden'));
  });

  it('a contact or T-shirt size stored without a current consent is never shown (defence in depth)', async () => {
    const pack = await createPack(1);
    const [m] = pack.memberIds;
    await admin.query(
      `insert into private.member_about_you (user_id, emergency_contact_name, emergency_contact_phone, tshirt_size)
       values ($1, 'Contact Person', '+40 700 000 000', 'XL')`,
      [m],
    );
    expect(await emergencyOf(pack.organizerId, pack.communityId, m)).toMatchObject({
      emergency_contact_name: null,
      emergency_contact_phone: null,
      emergency_contact_relationship: null,
      has_emergency_contact: false,
      tshirt_size: null,
    });
    expect((await emergencyList(pack.organizerId, pack.communityId)).members).toEqual([]);
  });

  it('list_community_emergency_info: active members with data, by name; members are refused', async () => {
    const pack = await createPack(0);
    const zed = await addMember(pack.communityId, { name: 'Zed Runner' });
    const amy = await addMember(pack.communityId, { name: 'Amy Runner' });
    const noData = await addMember(pack.communityId, { name: 'Bob Runner' });
    const demographicsOnly = await addMember(pack.communityId, { name: 'Cid Runner' });
    const gone = await addMember(pack.communityId, { name: 'Dan Runner' });
    await grantConsents(zed, BOTH);
    await grantConsents(demographicsOnly, BOTH);
    for (const id of [amy, pack.organizerId, gone]) await grantConsents(id, ['emergency_contact']);
    await save(zed, CONTACT);
    await save(amy, { tshirt_size: 'XXL' });
    await save(pack.organizerId, { tshirt_size: 'M' });
    await save(demographicsOnly, { gender: 'man' });
    await save(gone, { tshirt_size: 'S' });
    await admin.query("update public.memberships set status = 'removed' where user_id = $1", [gone]);

    const list = await emergencyList(pack.organizerId, pack.communityId);
    expect(list.truncated).toBe(false);
    expect(list.members.map((x) => [x.display_name, x.tshirt_size, x.has_emergency_contact])).toEqual([
      ['Amy Runner', 'XXL', false],
      ['Olga Organizer', 'M', false],
      ['Zed Runner', null, true],
    ]);
    expect(list.members.map((x) => x.user_id)).not.toContain(noData);
    expect(JSON.stringify(list)).not.toMatch(/birth|gender/);

    await expect(emergencyList(amy, pack.communityId)).rejects.toMatchObject(raised('forbidden'));
    await expect(emergencyList(pack.organizerId, null)).rejects.toMatchObject(raised('forbidden'));
    const other = await createPack(0);
    await expect(emergencyList(other.organizerId, pack.communityId)).rejects.toMatchObject(raised('forbidden'));
  });

  it('list_community_emergency_info is capped at 500', async () => {
    const pack = await createPack(0);
    await admin.query(
      `with u as (
         insert into auth.users (is_anonymous) select true from generate_series(1, 501) returning id
       ),
       p as (
         insert into public.profiles (id, display_name)
         select id, 'Bulk ' || lpad(row_number() over (order by id)::text, 3, '0') from u returning id
       ),
       m as (
         insert into public.memberships (community_id, user_id, role) select $1, id, 'member' from p returning user_id
       ),
       c as (
         insert into public.consent_records (user_id, purpose, document_version, granted)
         select user_id, 'emergency_contact', private.privacy_version(), true from m
       )
       insert into private.member_about_you (user_id, tshirt_size) select user_id, 'M' from m`,
      [pack.communityId],
    );
    const list = await emergencyList(pack.organizerId, pack.communityId);
    expect(list.members).toHaveLength(500);
    expect(list.truncated).toBe(true);
    expect(list.members[0].display_name).toBe('Bulk 001');
    expect(list.members[499].display_name).toBe('Bulk 500');
  });
});

describe('demographics: rounded aggregates only, small cells suppressed', () => {
  /** Adds active members with the given details (consents granted, saved through the RPC). */
  async function addPeople(
    communityId: string,
    people: { age?: number; gender?: string }[],
  ): Promise<string[]> {
    const year = await serverYear();
    const ids: string[] = [];
    for (const person of people) {
      const id = await addMember(communityId);
      await grantConsents(id, ['profile_demographics']);
      const input: Record<string, unknown> = {};
      if (person.age !== undefined) input.birth_year = year - person.age;
      if (person.gender !== undefined) input.gender = person.gender;
      if (Object.keys(input).length > 0) await save(id, input);
      ids.push(id);
    }
    return ids;
  }

  const cells = (list: Cell[]) => Object.fromEntries(list.map((c) => [c.key, c.suppressed ? 'x' : c.count]));

  /** What one response guarantees: shown cells are multiples of 5 (so at least 5), hidden ones have no number and are never alone. */
  function expectSafe(list: Cell[]) {
    const shown = list.filter((c) => !c.suppressed);
    const hidden = list.filter((c) => c.suppressed);
    for (const c of shown) {
      expect(c.count).toBeGreaterThanOrEqual(5);
      expect((c.count ?? 1) % 5).toBe(0);
    }
    for (const c of hidden) expect(c.count).toBeNull();
    if (hidden.length > 0 && shown.length > 0) expect(hidden.length).toBeGreaterThanOrEqual(2);
  }

  it('authorization: organizers of the community only', async () => {
    const pack = await createPack(1);
    const other = await createPack(0);
    const removedOrganizer = await addMember(pack.communityId, { role: 'organizer', status: 'removed' });
    await expect(demographics(pack.memberIds[0], pack.communityId)).rejects.toMatchObject(raised('forbidden'));
    await expect(demographics(other.organizerId, pack.communityId)).rejects.toMatchObject(raised('forbidden'));
    await expect(demographics(removedOrganizer, pack.communityId)).rejects.toMatchObject(raised('forbidden'));
    await expect(demographics(pack.organizerId, null)).rejects.toMatchObject(raised('forbidden'));
    expect((await demographics(pack.organizerId, pack.communityId)).member_count).toBe(2);
  });

  it('a small community gets nothing but suppressed cells (insufficient data)', async () => {
    const pack = await createPack(0);
    await addPeople(pack.communityId, [
      { age: 30, gender: 'woman' },
      { age: 30, gender: 'woman' },
      { age: 31, gender: 'woman' },
    ]);
    const d = await demographics(pack.organizerId, pack.communityId);
    expect(d.member_count).toBe(4);
    expect(d.min_group_size).toBe(5);
    expect(d.min_members_with_data).toBe(20);
    expect(d.rounded_to).toBe(5);
    expect(d.reference_year).toBe(await serverYear());
    expect(d.insufficient_data).toEqual({ age_bands: true, genders: true });
    expect(d.age_bands.every((c) => c.suppressed && c.count === null)).toBe(true);
    expect(d.genders.every((c) => c.suppressed && c.count === null)).toBe(true);
    expect(d.age_bands.map((c) => c.key)).toEqual(['under_18', '18_29', '30_39', '40_49', '50_59', '60_plus', 'not_provided']);
    expect(d.genders.map((c) => c.key)).toEqual(['woman', 'man', 'other', 'prefer_not_to_say', 'not_provided']);
  });

  it('a dimension needs 20 members with a value; the other dimension is judged on its own', async () => {
    const pack = await createPack(0);
    // 19 with gender and age, plus 6 with gender only: genders 25 with data, ages 19.
    await addPeople(pack.communityId, Array.from({ length: 19 }, () => ({ age: 35, gender: 'man' })));
    await addPeople(pack.communityId, Array.from({ length: 6 }, () => ({ gender: 'woman' })));
    let d = await demographics(pack.organizerId, pack.communityId);
    expect(d.member_count).toBe(26);
    // not_provided does not count as data, however large it is.
    expect(d.insufficient_data).toEqual({ age_bands: true, genders: false });
    expect(d.age_bands.every((c) => c.suppressed && c.count === null)).toBe(true);
    // man 19 -> 20, woman 6 -> 5; other 0, prefer_not_to_say 0, not_provided 1 (sum 1) -> the
    // smallest shown cell (woman) is hidden with them.
    expect(cells(d.genders)).toEqual({ woman: 'x', man: 20, other: 'x', prefer_not_to_say: 'x', not_provided: 'x' });

    // The 20th age makes the age dimension appear.
    await addPeople(pack.communityId, [{ age: 36 }]);
    d = await demographics(pack.organizerId, pack.communityId);
    expect(d.insufficient_data).toEqual({ age_bands: false, genders: false });
    // 30_39 = 20; not_provided = 7 (6 women without age + the organizer) -> 5; the zero cells
    // add up to 0 with five cells, so the smallest shown one (not_provided) joins them.
    expect(cells(d.age_bands)).toEqual({
      under_18: 'x', '18_29': 'x', '30_39': 20, '40_49': 'x', '50_59': 'x', '60_plus': 'x', not_provided: 'x',
    });
    expectSafe(d.age_bands);
    expectSafe(d.genders);
  });

  it('age bands from the server year; complementary suppression, then rounding', async () => {
    const pack = await createPack(0); // the organizer: no data -> not_provided
    await addPeople(pack.communityId, [
      ...Array.from({ length: 11 }, () => ({ age: 25, gender: 'woman' })),
      ...Array.from({ length: 12 }, () => ({ age: 35, gender: 'man' })),
      { age: 17, gender: 'other' },
    ]);
    const d = await demographics(pack.organizerId, pack.communityId);
    expect(d.member_count).toBe(25);
    expect(d.insufficient_data).toEqual({ age_bands: false, genders: false });
    // under_18 = 1, 18_29 = 11, 30_39 = 12, not_provided = 1, rest 0. The small cells add up to 2,
    // so the smallest shown cell (18_29) is suppressed too; 30_39 = 12 is shown as 10.
    expect(cells(d.age_bands)).toEqual({
      under_18: 'x', '18_29': 'x', '30_39': 10, '40_49': 'x', '50_59': 'x', '60_plus': 'x', not_provided: 'x',
    });
    expect(cells(d.genders)).toEqual({ woman: 'x', man: 10, other: 'x', prefer_not_to_say: 'x', not_provided: 'x' });
    expectSafe(d.age_bands);
    expectSafe(d.genders);
  });

  it('a lone small cell is never left derivable from the total', async () => {
    const pack = await createPack(0);
    // 21 women + the organizer (not provided): gender would be woman 21, not_provided 1.
    await addPeople(pack.communityId, Array.from({ length: 21 }, () => ({ gender: 'woman' })));
    let d = await demographics(pack.organizerId, pack.communityId);
    // Enough data, but showing woman would reveal "everyone but one is a woman": all suppressed.
    expect(d.insufficient_data.genders).toBe(false);
    expect(d.genders.every((c) => c.suppressed)).toBe(true);
    // Five more, five other: woman 21, other 5, not_provided 1 -> the cells below 5 add up to 1,
    // so the smallest shown cell (other) is suppressed too; woman 21 is shown as 20.
    await addPeople(pack.communityId, Array.from({ length: 5 }, () => ({ gender: 'other' })));
    d = await demographics(pack.organizerId, pack.communityId);
    expect(cells(d.genders)).toEqual({ woman: 20, man: 'x', other: 'x', prefer_not_to_say: 'x', not_provided: 'x' });
    expectSafe(d.genders);
  });

  it('counts only active members and only fields with a current consent', async () => {
    const pack = await createPack(0);
    const people = await addPeople(pack.communityId, Array.from({ length: 16 }, () => ({ age: 45, gender: 'man' })));
    await addPeople(pack.communityId, Array.from({ length: 8 }, () => ({ age: 25, gender: 'woman' })));
    let d = await demographics(pack.organizerId, pack.communityId);
    expect(d.member_count).toBe(25);
    expect(cells(d.genders).man).toBe(15); // 16
    expect(cells(d.age_bands)['40_49']).toBe(15); // 16

    await admin.query("update public.memberships set status = 'removed' where user_id = any($1::uuid[])", [
      people.slice(0, 2),
    ]);
    await withdraw(people[2], 'profile_demographics');
    // Data without a consent on record (written around the RPCs) does not count either.
    await admin.query(
      "insert into public.consent_records (user_id, purpose, document_version, granted) values ($1, 'profile_demographics', '1', false)",
      [people[3]],
    );
    d = await demographics(pack.organizerId, pack.communityId);
    // 23 active: men 12, women 8, not provided 3 (the organizer, the withdrawal, the stray row);
    // 20 with data, just enough.
    expect(d.member_count).toBe(23);
    expect(d.insufficient_data).toEqual({ age_bands: false, genders: false });
    expect(cells(d.genders)).toMatchObject({ man: 10, woman: 'x' }); // 12
    expect(cells(d.age_bands)).toMatchObject({ '40_49': 10, '18_29': 'x' }); // 12
    expectSafe(d.genders);
    expectSafe(d.age_bands);

    // One more member out: 19 with data, nothing is shown.
    await withdraw(people[4], 'profile_demographics');
    d = await demographics(pack.organizerId, pack.communityId);
    expect(d.insufficient_data).toEqual({ age_bands: true, genders: true });
    expect([...d.genders, ...d.age_bands].every((c) => c.suppressed)).toBe(true);
  });

  it('publication rule holds for many random distributions', async () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'not_provided'];
    for (let run = 0; run < 300; run += 1) {
      const n = 2 + Math.floor(random() * 6);
      const runKeys = [...keys.slice(0, n - 1), 'not_provided'];
      const counts = Array.from({ length: n }, () => Math.floor(random() * (random() < 0.5 ? 8 : 40)));
      const { rows } = await admin.query<{ r: { insufficient_data: boolean; cells: Cell[] } }>(
        'select private.publish_demographic_cells($1, $2, 5, 20, 5) as r',
        [runKeys, counts],
      );
      const { insufficient_data: insufficient, cells: result } = rows[0].r;
      expect(result.map((c) => c.key)).toEqual(runKeys);
      const withData = counts.slice(0, n - 1).reduce((s, c) => s + c, 0);
      expect(insufficient).toBe(withData < 20);
      if (insufficient) {
        expect(result.every((c) => c.suppressed && c.count === null)).toBe(true);
        continue;
      }
      expectSafe(result);
      const hidden = result.filter((c) => c.suppressed);
      if (hidden.length > 0 && hidden.length < n) {
        // What subtraction from the exact total gives covers >= 5 real people.
        expect(counts.filter((_, i) => result[i].suppressed).reduce((s, c) => s + c, 0)).toBeGreaterThanOrEqual(5);
      }
      result.forEach((c, i) => {
        if (!c.suppressed) {
          expect(c.count).toBe(Math.round(counts[i] / 5) * 5);
          expect(Math.abs((c.count ?? 0) - counts[i])).toBeLessThanOrEqual(2);
        }
        // Cells below 5 are always suppressed.
        if (counts[i] < 5) expect(c.suppressed).toBe(true);
      });
    }
  });
});

describe('GDPR: export and erasure', () => {
  it('export_my_data carries the caller’s About-you row (null when none), nothing of others', async () => {
    const pack = await createPack(2);
    const [m, m2] = pack.memberIds;
    const year = await serverYear();
    // P5 added extensions.workout_logs (empty here).
    expect((await exportMyData(m)).extensions).toEqual({ about_you: null, workout_logs: [] });

    await grantConsents(m, BOTH);
    await grantConsents(m2, BOTH);
    await save(m, { birth_year: year - 28, gender: 'woman', tshirt_size: 'S', ...CONTACT });
    await save(m2, { gender: 'man', emergency_contact_name: 'Other Contact', emergency_contact_phone: '+40 711 111 111' });
    const ex = await exportMyData(m);
    expect(ex.extensions).toEqual({
      about_you: {
        birth_year: year - 28,
        gender: 'woman',
        tshirt_size: 'S',
        ...CONTACT,
        created_at: expect.any(String),
        updated_at: expect.any(String),
      },
      workout_logs: [],
    });
    expect(JSON.stringify(ex)).not.toContain('Other Contact');
    expect(ex.README).toContain('extensions.about_you');
  });

  it('delete_my_account removes the row', async () => {
    const pack = await createPack(1);
    const [m] = pack.memberIds;
    await grantConsents(m, BOTH);
    await save(m, { gender: 'other', tshirt_size: 'M', ...CONTACT });
    await deleteMyAccount(m);
    expect(await storedRow(m)).toBeUndefined();
    const { rows } = await admin.query('select count(*)::int as n from private.member_about_you');
    expect(rows[0].n).toBe(0);
  });
});
