import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { mapCreatorError } from '@/features/communities/domain/creatorErrors';
import { communityNameSchema, isCommunityTimeZone } from '@/features/communities/domain/communityForm';
import { FALLBACK_TIME_ZONES, listTimeZones } from '@/features/communities/domain/timezones';
import { buildSwitcherItems } from '@/features/communities/domain/switcher';
import { remainingUses } from '@/features/invitations/domain/invitation';
import { buildInvitationMessage } from '@/features/invitations/domain/invitationMessage';
import { parseMyCommunities } from '@/features/community/domain/activeCommunity';
import { appErrorFromResult } from '@/lib/errors';

import {
  addMember,
  admin,
  asUser,
  closeDb,
  createCommunity,
  createTraining,
  createUser,
  insertInvitation,
  resetData,
  setRsvp,
} from './helpers';
import { createWithCode, type CreatorResult, issueCode, listMyCommunities, previewCode } from './creator-codes-helpers';

/**
 * C-Q1: the app's pure community logic against the REAL database answers (no mocked backend):
 * every error the server can give for the creator flow, the zone list against the server's own
 * rules, the invitation message against dates computed by Postgres, and the community list.
 */

beforeEach(resetData);
afterAll(closeDb);

/** The server's own pattern, read from the migration text so this test follows it. */
function serverZonePattern(): RegExp {
  const sql = readFileSync(path.resolve(__dirname, '../migrations/20261114000200_invitations_and_onboarding.sql'), 'utf8');
  const match = /p_timezone ~ '([^']+)'/.exec(sql);
  if (!match) throw new Error('the zone pattern moved in the migration; update this test');
  return new RegExp(match[1]);
}

describe('creator flow errors: every real server answer maps to a friendly place on the form', () => {
  it('gives a field or banner message, never the raw code, for each answer the server returns', async () => {
    const answers = new Map<string, CreatorResult>();
    const keep = (result: CreatorResult) => answers.set(String(result.error), result);

    const { code } = await issueCode({ maxUses: 10 });
    const user = await createUser();
    keep(await createWithCode(user, code, { name: '' }));
    keep(await createWithCode(user, code, { timezone: 'EST' }));
    keep(await createWithCode(user, code, { displayName: 'A' }));
    keep(await createWithCode(user, code, { requestId: null }));
    keep(await createWithCode(user, 'ZZZZZZZZ'));
    const expired = await issueCode();
    await admin.query("update public.community_creator_codes set expires_at = now() - interval '1 second' where code = $1", [expired.code]);
    keep(await createWithCode(user, expired.code));
    const revoked = await issueCode();
    await admin.query('update public.community_creator_codes set revoked_at = now() where code = $1', [revoked.code]);
    keep(await createWithCode(user, revoked.code));
    const used = await issueCode({ maxUses: 1 });
    await createWithCode(await createUser(), used.code);
    keep(await createWithCode(user, used.code));
    // The limiter now holds 4 failures (invalid, expired, revoked, exhausted): one more, then limited.
    keep(await previewCode(user, 'YYYYYYYY'));
    keep(await createWithCode(user, code));

    // community_limit_reached: five creations arranged directly for a fresh user.
    const heavy = await createUser();
    const codeId = (await admin.query<{ id: string }>('select id from public.community_creator_codes where code = $1', [code])).rows[0].id;
    await admin.query("insert into public.profiles (id, display_name) values ($1, 'Heavy Creator')", [heavy]);
    for (let i = 0; i < 5; i += 1) {
      const community = (await admin.query<{ id: string }>("insert into public.communities (name, timezone) values ($1, 'UTC') returning id", [`H${i}`])).rows[0].id;
      const membership = (await admin.query<{ id: string }>("insert into public.memberships (community_id, user_id, role) values ($1, $2, 'organizer') returning id", [community, heavy])).rows[0].id;
      await admin.query('insert into public.community_creator_redemptions (code_id, user_id, community_id, membership_id, request_id) values ($1, $2, $3, $4, $5)', [codeId, heavy, community, membership, randomUUID()]);
    }
    keep(await createWithCode(heavy, code));

    expect([...answers.keys()].sort()).toEqual(
      [
        'community_limit_reached', 'exhausted', 'expired', 'invalid_code', 'rate_limited', 'revoked',
        'validation_failed:display_name', 'validation_failed:name', 'validation_failed:request_id', 'validation_failed:timezone',
      ].sort(),
    );
    for (const [error, result] of answers) {
      expect(result.ok).toBe(false);
      const mapped = mapCreatorError(appErrorFromResult(error));
      expect(mapped.message, error).toBeTruthy();
      expect(mapped.message, error).not.toMatch(/validation_failed|_|invalid_code|P0001/);
      if (error.startsWith('validation_failed:')) {
        const field = error.split(':')[1];
        const expectedTarget = { name: 'name', timezone: 'timezone', display_name: 'displayName', request_id: 'banner' }[field];
        expect(mapped.target, error).toBe(expectedTarget);
      }
      if (['invalid_code', 'expired', 'revoked', 'exhausted'].includes(error)) {
        expect(mapped.target).toBe('code');
        expect(mapped.codeProblem).toBe(true);
      }
    }
    expect(mapCreatorError(appErrorFromResult('rate_limited')).tone).toBe('warning');
    expect(mapCreatorError(appErrorFromResult('community_limit_reached')).target).toBe('banner');
  }, 120_000);

  it('the client accepts one name the server refuses (invisible characters); the server answer lands on the name field', async () => {
    const parsed = communityNameSchema.safeParse('​​');
    expect(parsed.success).toBe(true); // the form lets it through ...
    const { code } = await issueCode();
    const result = await createWithCode(await createUser(), code, { name: '​​' });
    expect(result).toEqual({ ok: false, error: 'validation_failed:name' }); // ... the server is the authority
    expect(mapCreatorError(appErrorFromResult(result.error)).target).toBe('name');
  });
});

describe('time zones offered by the app against the server', () => {
  it('every zone of the picker (runtime list and built-in fallback) is a zone this database knows and its pattern accepts', async () => {
    const pattern = serverZonePattern();
    const { rows } = await admin.query<{ name: string }>('select name from pg_timezone_names');
    const known = new Set(rows.map((r) => r.name));
    const offered = [...new Set([...listTimeZones(), ...FALLBACK_TIME_ZONES])];
    expect(offered.length).toBeGreaterThan(300);
    const unknownToServer = offered.filter((zone) => zone !== 'UTC' && !(known.has(zone) && pattern.test(zone) && !/^(posix|right)\//.test(zone)));
    expect(unknownToServer).toEqual([]);
    for (const zone of offered) expect(isCommunityTimeZone(zone), zone).toBe(true);
  });

  it('a sample of picker zones goes through the real validation function', async () => {
    const offered = listTimeZones();
    const sample = offered.filter((_, i) => i % 40 === 0).concat(['UTC', 'Europe/Bucharest', 'Asia/Kathmandu', 'Pacific/Chatham']);
    const { rows } = await admin.query<{ p: string; ok: boolean }>('select p, private.is_valid_timezone(p) as ok from unnest($1::text[]) as p', [sample]);
    expect(rows.filter((r) => !r.ok).map((r) => r.p)).toEqual([]);
  }, 60_000);
});

describe('invitation message against real rows and Postgres dates', () => {
  it('shows the expiry date Postgres computes in the community zone, for zones on both sides of the date line and across DST', async () => {
    const instants = ['2026-11-20T23:30:00Z', '2026-03-29T00:59:59Z', '2026-03-29T01:00:00Z', '2026-10-25T00:30:00Z', '2026-12-31T22:30:00Z', '2028-02-29T23:59:59Z', '2026-06-30T21:59:59Z'];
    const zones = ['Europe/Bucharest', 'America/New_York', 'Pacific/Kiritimati', 'Etc/GMT+12', 'Asia/Kathmandu', 'Australia/Lord_Howe', 'Pacific/Chatham', 'UTC'];
    const rows = await admin.query<{ iso: string; zone: string; expected: string }>(
      `select i as iso, z as zone, to_char(i::timestamptz at time zone z, 'FMDD Mon YYYY') as expected
       from unnest($1::text[]) as i, unnest($2::text[]) as z`,
      [instants, zones],
    );
    expect(rows.rows).toHaveLength(instants.length * zones.length);
    for (const { iso, zone, expected } of rows.rows) {
      const message = buildInvitationMessage({
        communityName: 'Bears', code: 'abcd2345', expiresAt: iso, maxRedemptions: null, appLink: null,
        now: new Date('2026-11-16T10:00:00Z'), timeZone: zone,
      });
      expect(message, `${iso} in ${zone}`).toContain(`(The code works until ${expected}.)`);
    }
  });

  it('is built from the real invitation row: name, code, remaining uses and expiry', async () => {
    const community = await createCommunity('Făget Trail \u{1F43B}', 'Europe/Bucharest');
    const organizer = await addMember(community.communityId, { role: 'organizer', name: 'Olga Organizer' });
    await insertInvitation(community.communityId, 'KMNP3456', { maxRedemptions: 3, expiresAt: '2030-05-17T12:00:00Z' });
    const { rows } = await asUser(organizer, (db) =>
      db.query<{ code: string; expires_at: Date; max_redemptions: number | null; redemption_count: number }>(
        "select code, expires_at, max_redemptions, redemption_count from public.invitation_codes where code = 'KMNP3456'",
      ),
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    const message = buildInvitationMessage({
      communityName: 'Făget Trail \u{1F43B}', code: row.code, expiresAt: row.expires_at.toISOString(),
      maxRedemptions: row.max_redemptions, remainingUses: remainingUses({ max_redemptions: row.max_redemptions, redemption_count: row.redemption_count }),
      appLink: 'https://example.com/app', now: new Date('2026-11-16T10:00:00Z'), timeZone: 'Europe/Bucharest',
    });
    expect(message).toContain('join Făget Trail \u{1F43B} on TrainHive.');
    expect(message).toContain('KMNP-3456');
    expect(message).toContain('(The code works until 17 May 2030 and works for up to 3 people.)');
    expect(message).toContain('1. Get the app: https://example.com/app');
  });
});

describe('the community list and what the app reads', () => {
  it('list_my_communities parses with the app parser, equals the plain table read under RLS, and orders oldest first', async () => {
    const a = await createCommunity('Alpha', 'Europe/Bucharest');
    const b = await createCommunity('Beta', 'America/New_York');
    const c = await createCommunity('Gamma', 'UTC');
    const user = await addMember(a.communityId, { role: 'organizer', name: 'Uma Multi' });
    for (const [community, role, status] of [[b.communityId, 'member', 'active'], [c.communityId, 'member', 'removed']] as const) {
      await admin.query('insert into public.memberships (community_id, user_id, role, status) values ($1, $2, $3, $4)', [community, user, role, status]);
    }
    const listed = await listMyCommunities(user);
    expect(parseMyCommunities(listed)).toHaveLength(2);
    const table = await asUser(user, (db) =>
      db.query<{ community_id: string; role: string }>(
        `select m.community_id, m.role from public.memberships m
         join public.communities c on c.id = m.community_id
         where m.user_id = $1 and m.status = 'active' order by m.joined_at, m.id`,
        [user],
      ),
    );
    expect(table.rows.map((r) => [r.community_id, r.role])).toEqual(listed.map((r) => [r.community_id, r.role]));
    const items = buildSwitcherItems(listed, listed[1].community_id, new Date('2026-11-16T10:00:00Z'));
    expect(items.map((i) => [i.name, i.roleLabel, i.isActive])).toEqual([['Alpha', 'Organizer', false], ['Beta', 'Member', true]]);
    expect(items[1].timezoneLabel).toBe('New York, 05:00 (UTC-05:00)');
  });

  it('"my answers" read across communities cannot mix: one row per session, co-members only inside my communities, nothing after removal', async () => {
    const a = await createCommunity('Alpha', 'Europe/Bucharest');
    const b = await createCommunity('Beta', 'Europe/Berlin');
    const organizerA = await addMember(a.communityId, { role: 'organizer', name: 'Org A' });
    const organizerB = await addMember(b.communityId, { role: 'organizer', name: 'Org B' });
    const user = await addMember(a.communityId, { name: 'Uma Multi' });
    await admin.query("insert into public.memberships (community_id, user_id, role) values ($1, $2, 'member')", [b.communityId, user]);
    const other = await addMember(a.communityId, { name: 'Other Member' });
    const sessionA = await createTraining(organizerA, a.communityId);
    const sessionB = await createTraining(organizerB, b.communityId, { timezone: 'Europe/Berlin' });
    await setRsvp(user, sessionA.id, 'going');
    await setRsvp(user, sessionB.id, 'not_going');
    await setRsvp(other, sessionA.id, 'going');

    const read = () => asUser(user, (db) => db.query<{ session_id: string; response: string }>('select session_id, response from public.training_rsvps where user_id = $1', [user]));
    const mine = (await read()).rows;
    expect(mine.map((r) => r.session_id).sort()).toEqual([sessionA.id, sessionB.id].sort());
    expect(new Map(mine.map((r) => [r.session_id, r.response]))).toEqual(new Map([[sessionA.id, 'going'], [sessionB.id, 'not_going']]));
    // Co-members' answers are visible (the participant list) but only for sessions of communities I belong to.
    const otherB = await addMember(b.communityId, { name: 'Other In B' });
    await setRsvp(otherB, sessionB.id, 'going');
    const theirs = await asUser(user, (db) => db.query<{ session_id: string }>('select session_id from public.training_rsvps where user_id = $1', [other]));
    expect(theirs.rows.map((r) => r.session_id)).toEqual([sessionA.id]);
    // Removed from B: the member no longer sees B's sessions or anyone's answers there.
    await admin.query("update public.memberships set status = 'removed' where community_id = $1 and user_id = $2", [b.communityId, user]);
    expect((await asUser(user, (db) => db.query('select id from public.training_sessions where community_id = $1', [b.communityId]))).rows).toEqual([]);
    expect((await asUser(user, (db) => db.query('select * from public.training_rsvps where user_id = $1', [otherB]))).rows).toEqual([]);
    // Own answers of a community I was removed from disappear with the membership (RLS), so the map never carries them.
    expect((await read()).rows.map((r) => r.session_id)).toEqual([sessionA.id]);
  });
});
