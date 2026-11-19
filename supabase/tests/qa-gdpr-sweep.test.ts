import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { deleteMyAccount, removeMember, referencesTo, snapshotTables } from './account-deletion-helpers';
import {
  addMember,
  admin,
  asUser,
  closeDb,
  createCommunity,
  createTraining,
  resetData,
} from './helpers';
import { createAnnouncement } from './notifications-helpers';
import { errorKey } from './qa-helpers';

/**
 * QA review of GDPR G2 (Q7): every function the `authenticated` role can execute, generated from
 * pg_proc (not a hand-written list), called with the token of (a) a deleted account and (b) a
 * removed member, against a community full of recognizable fake data.
 */

beforeEach(resetData);
afterAll(closeDb);

const MARKERS = ['Qseven', 'Zed Zebra', 'Olive Other'];

interface Fn {
  name: string;
  args: string[];
  types: string[];
}

async function authenticatedFunctions(): Promise<Fn[]> {
  const { rows } = await admin.query<{ name: string; args: string[] | null; types: string[] }>(
    `select p.proname as name, p.proargnames as args,
            array(select format_type(t, null) from unnest(p.proargtypes::oid[]) t) as types
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and has_function_privilege('authenticated', p.oid, 'execute')
     order by 1`,
  );
  return rows.map((r) => ({ name: r.name, args: r.args ?? r.types.map((_, i) => `a${i}`), types: r.types }));
}

interface World {
  communityId: string;
  sessionId: string;
  announcementId: string;
  zed: string;
  olive: string;
  victim: string;
}

async function world(): Promise<World> {
  const { communityId } = await createCommunity('Qseven Alpha');
  const olive = await addMember(communityId, { role: 'organizer', name: 'Olive Other' });
  const victim = await addMember(communityId, { role: 'organizer', name: 'Vic Victim' });
  const zed = await addMember(communityId, { name: 'Zed Zebra' });
  const session = await createTraining(olive, communityId, { title: 'Qseven Run' });
  const ann = await createAnnouncement(olive, communityId, { title: 'Qseven News' });
  return { communityId, sessionId: session.id, announcementId: ann.id, zed, olive, victim };
}

function valueFor(fn: Fn, i: number, w: World): unknown {
  const name = fn.args[i] ?? '';
  const type = fn.types[i];
  if (type === 'uuid') {
    if (name.includes('community')) return w.communityId;
    if (name.includes('session')) return w.sessionId;
    if (name.includes('announcement')) return w.announcementId;
    if (name.includes('user') || name.includes('attendee')) return w.zed;
    return randomUUID();
  }
  if (type === 'text') {
    if (name.includes('purpose')) return 'age_16';
    if (name.includes('token')) return 'ExponentPushToken[ghost]';
    if (name.includes('platform')) return 'android';
    if (name.includes('code')) return 'AAAAAAAA';
    if (name.includes('timezone')) return 'UTC';
    return 'Ghost';
  }
  if (type === 'jsonb') return '{}';
  if (type === 'integer' || type === 'bigint') return 1;
  if (type === 'boolean') return true;
  if (type.startsWith('timestamp')) return new Date().toISOString();
  if (type.endsWith('membership_role')) return 'organizer';
  if (type.endsWith('rsvp_response')) return 'going';
  if (type.endsWith('attendance_status')) return 'absent';
  return null;
}

async function sweep(userId: string, w: World, live = false): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  // A live account must survive the sweep: skip the calls that end or leave it.
  const skip = live ? new Set(["delete_my_account", "leave_community"]) : new Set<string>();
  for (const fn of (await authenticatedFunctions()).filter((f) => !skip.has(f.name))) {
    const params = fn.types.map((_, i) => valueFor(fn, i, w));
    const placeholders = fn.types.map((t, i) => `$${i + 1}::${t}`).join(', ');
    out[fn.name] = await asUser(userId, (db) =>
      db.query(`select * from public.${fn.name}(${placeholders})`, params),
    ).then((r) => `ok:${JSON.stringify(r.rows)}`, errorKey);
  }
  return out;
}

describe('every authenticated function with the token of a deleted account', () => {
  it('returns no community data, writes nothing, and never raises a raw constraint or privilege error', async () => {
    const w = await world();
    await deleteMyAccount(w.victim);
    const before = await snapshotTables();
    const outcomes = await sweep(w.victim, w);
    const after = await snapshotTables();

    expect(Object.keys(outcomes).length).toBeGreaterThan(30);
    const raw = Object.entries(outcomes).filter(([, o]) => !/^(ok:|P0001:)/.test(o));
    expect(raw).toEqual([]);
    const leaks = Object.entries(outcomes).filter(([, o]) => o.startsWith('ok:') && MARKERS.some((m) => o.includes(m)));
    expect(leaks).toEqual([]);
    for (const [table, rows] of before) expect(after.get(table), table).toEqual(rows);
    expect(await referencesTo(w.victim)).toEqual({});
  });
});

describe('every authenticated function with the token of a removed member', () => {
  it('returns none of the community data it holds markers for', async () => {
    const w = await world();
    await removeMember(w.olive, w.communityId, w.victim);
    const outcomes = await sweep(w.victim, w, true);
    const raw = Object.entries(outcomes).filter(([, o]) => !/^(ok:|P0001:)/.test(o));
    expect(raw).toEqual([]);
    const leaks = Object.entries(outcomes)
      // export_my_data lists the caller's own former membership by community name: their own data.
      .filter(([name, o]) => name !== 'export_my_data' && o.startsWith('ok:') && MARKERS.some((m) => o.includes(m)))
      .map(([name]) => name);
    // Own-community listings are reported by name below, so a leak is visible in the diff.
    expect(leaks).toEqual([]);
  });
});

describe('the sweep is not blind', () => {
  it('the same calls as an active member do return community data', async () => {
    const w = await world();
    const outcomes = await sweep(w.olive, w, true);
    const hits = Object.entries(outcomes).filter(([, o]) => o.startsWith('ok:') && MARKERS.some((m) => o.includes(m)));
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });
});
