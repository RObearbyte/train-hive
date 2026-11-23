import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addMember,
  admin,
  asAnon,
  asRole,
  asService,
  asUser,
  closeDb,
  countRows,
  createCommunity,
  createUser,
  INSUFFICIENT_PRIVILEGE,
  RAISED,
  resetData,
  rpc,
} from './helpers';

/**
 * O1: create_invitation computes the expiry on the SERVER from p_expires_in_hours
 * (0 = never, 1..2160). The legacy p_expires_at of old apps is still accepted but checked against
 * the server clock (future, at most 90 days ahead). Calls are made by NAME, as PostgREST does.
 */

beforeEach(resetData);
afterAll(closeDb);

type Invitation = { id: string; code: string; expires_at: Date | null; max_redemptions: number | null; role: string };

const raised = (message: string) => ({ code: RAISED, message });
const HOUR = 3_600_000;

/** create_invitation with named arguments (only the given ones), like a PostgREST call. */
function createNamed(userId: string, args: Record<string, unknown>): Promise<Invitation> {
  const names = Object.keys(args);
  const list = names.map((name, i) => `${name} => $${i + 1}`).join(', ');
  return asUser(userId, async (db) => {
    const { rows } = await db.query<Invitation>(`select * from public.create_invitation(${list})`, Object.values(args));
    return rows[0];
  });
}

async function organizerPack(): Promise<{ communityId: string; organizerId: string }> {
  const { communityId } = await createCommunity();
  const organizerId = await addMember(communityId, { role: 'organizer' });
  return { communityId, organizerId };
}

/** The database clock now (the reference for every expiry check). */
async function dbNow(): Promise<number> {
  const { rows } = await admin.query<{ now: Date }>('select clock_timestamp() as now');
  return rows[0].now.getTime();
}

const redeem = (userId: string, code: string) =>
  asUser(userId, (db) => rpc<{ ok: boolean; error?: string }>(db, 'redeem_invitation', [code, 'New Member']));

describe('p_expires_in_hours: the server computes the expiry', () => {
  it.each([1, 24, 7 * 24, 30 * 24, 90 * 24])('%i hours from the server clock', async (hours) => {
    const { communityId, organizerId } = await organizerPack();
    const before = await dbNow();
    const invitation = await createNamed(organizerId, {
      p_community_id: communityId,
      p_expires_at: null,
      p_max_redemptions: 1,
      p_expires_in_hours: hours,
    });
    const after = await dbNow();
    const expires = invitation.expires_at?.getTime() ?? NaN;
    expect(expires).toBeGreaterThanOrEqual(before + hours * HOUR);
    expect(expires).toBeLessThanOrEqual(after + hours * HOUR);
    expect(invitation).toMatchObject({ role: 'member', max_redemptions: 1 });
  });

  it('is independent of anything the client knows: no client time is sent at all', async () => {
    const { communityId, organizerId } = await organizerPack();
    // The request carries only a duration; the stored expiry follows the database clock.
    const invitation = await createNamed(organizerId, { p_community_id: communityId, p_expires_in_hours: 48 });
    const { rows } = await admin.query<{ off_by_ms: number }>(
      `select abs(extract(epoch from (expires_at - (created_at + interval '48 hours'))) * 1000)::float8 as off_by_ms
       from public.invitation_codes where id = $1`,
      [invitation.id],
    );
    // created_at is now() (transaction start), the expiry clock_timestamp(): same request, < 1 s apart.
    expect(rows[0].off_by_ms).toBeLessThan(1000);
  });

  it('0 means never expires', async () => {
    const { communityId, organizerId } = await organizerPack();
    const invitation = await createNamed(organizerId, {
      p_community_id: communityId,
      p_expires_at: null,
      p_max_redemptions: null,
      p_expires_in_hours: 0,
    });
    expect(invitation.expires_at).toBeNull();
  });

  it.each([-1, 90 * 24 + 1, 100_000, -2_147_483_648, 2_147_483_647])('rejects %i hours', async (hours) => {
    const { communityId, organizerId } = await organizerPack();
    await expect(
      createNamed(organizerId, { p_community_id: communityId, p_expires_in_hours: hours }),
    ).rejects.toMatchObject(raised('validation_failed:expires_in_hours'));
    expect(await countRows('invitation_codes', 'created_by is not null')).toBe(0);
  });

  it('rejects a duration sent together with an absolute time', async () => {
    const { communityId, organizerId } = await organizerPack();
    const at = new Date(Date.now() + 2 * HOUR).toISOString();
    await expect(
      createNamed(organizerId, { p_community_id: communityId, p_expires_at: at, p_expires_in_hours: 24 }),
    ).rejects.toMatchObject(raised('validation_failed:expires_in_hours'));
    // ...also "never" (0) next to an absolute time: ambiguous.
    await expect(
      createNamed(organizerId, { p_community_id: communityId, p_expires_at: at, p_expires_in_hours: 0 }),
    ).rejects.toMatchObject(raised('validation_failed:expires_in_hours'));
    expect(await countRows('invitation_codes', 'created_by is not null')).toBe(0);
  });

  it('still checks the organizer first and max redemptions after the expiry', async () => {
    const { communityId, organizerId } = await organizerPack();
    const memberId = await addMember(communityId);
    await expect(
      createNamed(memberId, { p_community_id: communityId, p_expires_in_hours: 24 }),
    ).rejects.toMatchObject(raised('forbidden'));
    // A forbidden caller learns nothing about the bounds.
    await expect(
      createNamed(memberId, { p_community_id: communityId, p_expires_in_hours: -5 }),
    ).rejects.toMatchObject(raised('forbidden'));
    await expect(
      createNamed(organizerId, { p_community_id: communityId, p_expires_in_hours: 24, p_max_redemptions: 0 }),
    ).rejects.toMatchObject(raised('validation_failed:max_redemptions'));
    await expect(
      asRole('authenticated', { role: 'authenticated' }, (db) =>
        db.query('select public.create_invitation(p_community_id => $1, p_expires_in_hours => 24)', [communityId]),
      ),
    ).rejects.toMatchObject(raised('not_authenticated'));
    await expect(
      asAnon((db) => db.query('select public.create_invitation(p_community_id => $1, p_expires_in_hours => 24)', [communityId])),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      asService((db) => db.query('select public.create_invitation(p_community_id => $1, p_expires_in_hours => 24)', [communityId])),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    expect(await countRows('invitation_codes', 'created_by is not null')).toBe(0);
  });
});

describe('p_expires_at (old apps): accepted, validated against the server clock', () => {
  it('the old named-argument call shape still works and stores the given time', async () => {
    const { communityId, organizerId } = await organizerPack();
    const at = new Date(Date.now() + 7 * 24 * HOUR);
    const invitation = await createNamed(organizerId, {
      p_community_id: communityId,
      p_expires_at: at.toISOString(),
      p_max_redemptions: 3,
    });
    expect(invitation.expires_at?.getTime()).toBe(at.getTime());
    expect(invitation.max_redemptions).toBe(3);
  });

  it('old "Never" (p_expires_at null, no duration) and a bare call still mean no expiry', async () => {
    const { communityId, organizerId } = await organizerPack();
    const never = await createNamed(organizerId, { p_community_id: communityId, p_expires_at: null, p_max_redemptions: null });
    const bare = await createNamed(organizerId, { p_community_id: communityId });
    expect(never.expires_at).toBeNull();
    expect(bare.expires_at).toBeNull();
  });

  it('refuses a time in the past or exactly now by the SERVER clock (a phone whose clock is behind)', async () => {
    const { communityId, organizerId } = await organizerPack();
    // A phone 40 days behind computing "30 days from now".
    const behind = new Date((await dbNow()) - 10 * 24 * HOUR).toISOString();
    for (const at of [behind, new Date((await dbNow()) - 1000).toISOString()]) {
      await expect(
        createNamed(organizerId, { p_community_id: communityId, p_expires_at: at, p_max_redemptions: null }),
      ).rejects.toMatchObject(raised('validation_failed:expires_at'));
    }
    expect(await countRows('invitation_codes', 'created_by is not null')).toBe(0);
  });

  it('refuses more than 90 days ahead by the server clock (a phone whose clock is far ahead)', async () => {
    const { communityId, organizerId } = await organizerPack();
    const now = await dbNow();
    await expect(
      createNamed(organizerId, {
        p_community_id: communityId,
        p_expires_at: new Date(now + 90 * 24 * HOUR + 60_000).toISOString(),
      }),
    ).rejects.toMatchObject(raised('validation_failed:expires_at'));
    await expect(
      createNamed(organizerId, { p_community_id: communityId, p_expires_at: '9999-12-31T00:00:00Z' }),
    ).rejects.toMatchObject(raised('validation_failed:expires_at'));
    // Just inside the bound is fine.
    const ok = await createNamed(organizerId, {
      p_community_id: communityId,
      p_expires_at: new Date(now + 90 * 24 * HOUR - 60_000).toISOString(),
    });
    expect(ok.expires_at).not.toBeNull();
  });
});

describe('expiry is enforced at redemption', () => {
  it('a code redeems before its server-computed expiry and is refused after it', async () => {
    const { communityId, organizerId } = await organizerPack();
    const invitation = await createNamed(organizerId, { p_community_id: communityId, p_expires_in_hours: 1 });

    const early = await createUser();
    expect(await redeem(early, invitation.code)).toMatchObject({ ok: true });

    // One hour passes: move the stored expiry into the past (the clock cannot be moved).
    await admin.query("update public.invitation_codes set expires_at = clock_timestamp() - interval '1 second' where id = $1", [
      invitation.id,
    ]);
    const late = await createUser();
    expect(await redeem(late, invitation.code)).toEqual({ ok: false, error: 'expired' });
    expect(await countRows('memberships', 'user_id = $1', [late])).toBe(0);
    expect(
      await asUser(late, (db) => rpc<{ ok: boolean; error?: string }>(db, 'preview_invitation', [invitation.code])),
    ).toEqual({ ok: false, error: 'expired' });
  });
});

describe('signature', () => {
  it('one create_invitation, the duration last and defaulted, executable by authenticated only', async () => {
    const { rows } = await admin.query<{ args: string; authenticated: boolean; service_role: boolean; anon: boolean }>(
      `select pg_get_function_arguments(p.oid) as args,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
              has_function_privilege('service_role', p.oid, 'execute') as service_role,
              has_function_privilege('anon', p.oid, 'execute') as anon
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'create_invitation'`,
    );
    expect(rows).toEqual([
      {
        args:
          'p_community_id uuid, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, ' +
          'p_max_redemptions integer DEFAULT NULL::integer, p_expires_in_hours integer DEFAULT NULL::integer',
        authenticated: true,
        service_role: false,
        anon: false,
      },
    ]);
  });
});
