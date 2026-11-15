import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { admin, asUser, closeDb, countRows, createPack, resetData, rpc, rpcRow } from './helpers';
import { createAnnouncement } from './notifications-helpers';
import { errorKey, waitForBlocked } from './qa-helpers';

/**
 * M4-B1 (small fix, 20261117000200): mark_announcement_read and mark_announcements_read lock the
 * caller's profile FOR KEY SHARE before writing announcement_reads, like their notification
 * siblings. Deterministic reproduction of the race: an account deletion has deleted the profile
 * but not committed; the call must wait for it and then answer with a contract error, never with
 * a foreign key violation (23503), which is what the M3 version raised.
 */

beforeEach(resetData);
afterAll(closeDb);

async function raceWithDeletion(call: (userId: string, announcementId: string, communityId: string) => Promise<unknown>) {
  const { communityId, organizerId, memberIds } = await createPack(1);
  const [me] = memberIds;
  const announcement = await createAnnouncement(organizerId, communityId);

  const deleting = await admin.connect();
  try {
    await deleting.query('begin');
    await deleting.query('delete from auth.users where id = $1', [me]);
    const pending = call(me, announcement.id, communityId).then(
      () => 'ok',
      (error: unknown) => errorKey(error),
    );
    await waitForBlocked('mark_announcement');
    await deleting.query('commit');
    return { outcome: await pending, me };
  } finally {
    deleting.release();
  }
}

describe('announcement reads racing an account deletion', () => {
  it('mark_announcement_read waits for the deletion and answers not_found', async () => {
    const { outcome, me } = await raceWithDeletion((userId, id) =>
      asUser(userId, (db) => rpcRow(db, 'mark_announcement_read', [id])),
    );
    expect(outcome).toBe('P0001:not_found');
    expect(await countRows('announcement_reads', 'user_id = $1', [me])).toBe(0);
  });

  it('mark_announcements_read waits for the deletion and answers not_a_member', async () => {
    const { outcome, me } = await raceWithDeletion((userId, _id, communityId) =>
      asUser(userId, (db) => rpc(db, 'mark_announcements_read', [communityId])),
    );
    expect(outcome).toBe('P0001:not_a_member');
    expect(await countRows('announcement_reads', 'user_id = $1', [me])).toBe(0);
  });

  it('without the lock (the M3 version) the same race ends in a foreign key violation', async () => {
    const signature = 'public.mark_announcement_read(uuid)';
    const lockLine = 'perform 1 from public.profiles p where p.id = v_uid for key share;';
    const { rows } = await admin.query<{ def: string }>('select pg_get_functiondef($1::regprocedure) as def', [signature]);
    const original = rows[0].def;
    expect(original).toContain(lockLine);
    // `perform 1` keeps FOUND true, so the function behaves exactly like the unlocked M3 one.
    await admin.query(original.replace(lockLine, 'perform 1;'));
    try {
      const { outcome } = await raceWithDeletion((userId, id) =>
        asUser(userId, (db) => rpcRow(db, 'mark_announcement_read', [id])),
      );
      expect(outcome).toMatch(/^23503:/);
    } finally {
      await admin.query(original);
    }
  });

  it('both still work normally and stay idempotent', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const [me] = memberIds;
    const first = await createAnnouncement(organizerId, communityId, { title: 'one' });
    await createAnnouncement(organizerId, communityId, { title: 'two' });
    const read = await asUser(me, (db) => rpcRow<{ read_at: Date }>(db, 'mark_announcement_read', [first.id]));
    const again = await asUser(me, (db) => rpcRow<{ read_at: Date }>(db, 'mark_announcement_read', [first.id]));
    expect(again.read_at).toEqual(read.read_at);
    expect(await asUser(me, (db) => rpc<number>(db, 'mark_announcements_read', [communityId]))).toBe(1);
    expect(await asUser(me, (db) => rpc<number>(db, 'mark_announcements_read', [communityId]))).toBe(0);
    expect(await countRows('notifications', 'user_id = $1 and read_at is null', [me])).toBe(0);
  });

  it('both lock the profile before writing (source check)', async () => {
    const { rows } = await admin.query<{ name: string; source: string }>(
      `select p.proname as name, p.prosrc as source from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('mark_announcement_read', 'mark_announcements_read') order by 1`,
    );
    expect(rows).toHaveLength(2);
    for (const { name, source } of rows) {
      const lock = source.indexOf('for key share');
      const insert = source.indexOf('insert into public.announcement_reads');
      expect(lock, name).toBeGreaterThan(0);
      expect(lock, name).toBeLessThan(insert);
    }
  });
});
