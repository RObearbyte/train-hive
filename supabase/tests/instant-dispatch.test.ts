import type { PoolClient } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { addMember, admin, closeDb, createCommunity, createTraining, resetData } from './helpers';
import { createAnnouncement } from './notifications-helpers';

/**
 * Instant dispatch (migration 20261121000100): a statement-level AFTER INSERT trigger on
 * notification_delivery_jobs calls the dispatch-notifications Edge Function through pg_net.
 *
 * The local database has no `net` schema and no Vault. Tests that need them create STUBS inside
 * a transaction that is always rolled back, so nothing leaks into other tests (stub DDL is
 * invisible to other connections until commit, and is never committed).
 */

beforeEach(resetData);
afterAll(closeDb);

const SECRET = 'S3CRET-dispatch-value';
const URL_BASE = 'https://project.example.test';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeout: number;
}

interface Stubbed {
  client: PoolClient;
  notices: string[];
  calls: () => Promise<Call[]>;
  asUser: (userId: string, sql: string, params: unknown[]) => Promise<void>;
}

async function withStubs(options: { secrets?: boolean }, fn: (s: Stubbed) => Promise<void>): Promise<void> {
  const client = await admin.connect();
  const notices: string[] = [];
  client.on('notice', (n) => notices.push(`${n.severity}: ${n.message}`));
  try {
    await client.query('begin');
    await client.query(`
      create schema net;
      create table net.calls (url text, headers jsonb, body jsonb, timeout integer, at timestamptz default clock_timestamp());
      create table net.mode (fail boolean);
      insert into net.mode values (false);
      create function net.http_post(
        url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds integer default 5000
      ) returns bigint language plpgsql as $f$
      begin
        if (select fail from net.mode) then
          raise exception 'http_post exploded for %', headers ->> 'x-dispatch-secret';
        end if;
        insert into net.calls (url, headers, body, timeout) values (url, headers, body, timeout_milliseconds);
        return 1;
      end $f$;
      create schema vault;
    `);
    await client.query(
      options.secrets === false
        ? 'create view vault.decrypted_secrets as select null::text as name, null::text as decrypted_secret where false'
        : `create view vault.decrypted_secrets as
             select 'project_url'::text as name, '${URL_BASE}'::text as decrypted_secret
             union all select 'dispatch_secret', '${SECRET}'`,
    );
    await fn({
      client,
      notices,
      calls: async () => {
        const { rows } = await client.query('select url, headers, body, timeout from net.calls order by at');
        return rows as Call[];
      },
      asUser: async (userId, sql, params) => {
        await client.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: userId, role: 'authenticated' }),
        ]);
        await client.query('set local role authenticated');
        try {
          await client.query(sql, params);
        } finally {
          await client.query('reset role');
        }
      },
    });
  } finally {
    try {
      await client.query('rollback');
    } finally {
      client.removeAllListeners('notice');
      client.release();
    }
  }
}

async function fixture(members: number) {
  const { communityId } = await createCommunity();
  const organizerId = await addMember(communityId, { role: 'organizer' });
  const memberIds: string[] = [];
  for (let i = 0; i < members; i++) memberIds.push(await addMember(communityId));
  return { communityId, organizerId, memberIds };
}

const CREATE_ANNOUNCEMENT = 'select id from public.create_announcement($1, $2, $3, null)';

async function jobCount(db: Pick<PoolClient, 'query'>): Promise<number> {
  const { rows } = await db.query('select count(*)::int as n from public.notification_delivery_jobs');
  return rows[0].n as number;
}

async function pingIsNever(db: Pick<PoolClient, 'query'>): Promise<boolean> {
  const { rows } = await db.query("select last_called = '-infinity' as never from private.dispatch_ping");
  expect(rows).toHaveLength(1);
  return rows[0].never as boolean;
}

describe('instant dispatch: trigger definition', () => {
  it('is a statement-level AFTER INSERT trigger on notification_delivery_jobs with a transition table', async () => {
    const { rows } = await admin.query(
      `select t.tgname, n.nspname as rel_schema, p.proname, pn.nspname as fn_schema,
              (t.tgtype & 1) as is_row, (t.tgtype & 2) as is_before, (t.tgtype & 4) as on_insert,
              (t.tgtype & 8) as on_delete, (t.tgtype & 16) as on_update, (t.tgtype & 32) as on_truncate,
              t.tgenabled, t.tgnewtable, t.tgoldtable
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_proc p on p.oid = t.tgfoid
       join pg_namespace pn on pn.oid = p.pronamespace
       where not t.tgisinternal and c.relname = 'notification_delivery_jobs'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tgname: 'notification_delivery_jobs_instant_dispatch',
      rel_schema: 'public',
      proname: 'trigger_instant_dispatch',
      fn_schema: 'private',
      is_row: 0,
      is_before: 0,
      on_insert: 4,
      on_delete: 0,
      on_update: 0,
      on_truncate: 0,
      tgenabled: 'O',
      tgnewtable: 'new_rows',
      tgoldtable: null,
    });
  });

  it('the function is private, security definer, pinned, owned like the table, and not executable by any API role', async () => {
    const { rows } = await admin.query(
      `select p.prosecdef, p.proconfig, p.proowner = c.relowner as same_owner,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
              has_function_privilege('service_role', p.oid, 'execute') as service_role,
              has_function_privilege('public', p.oid, 'execute') as everyone,
              p.prosrc
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       cross join pg_class c
       where n.nspname = 'private' and p.proname = 'trigger_instant_dispatch'
         and c.oid = 'public.notification_delivery_jobs'::regclass`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      prosecdef: true,
      same_owner: true,
      anon: false,
      authenticated: false,
      service_role: false,
      everyone: false,
    });
    expect(rows[0].proconfig).toContain('search_path=""');
    // Dynamic SQL is constant text with bind parameters: no value is concatenated into SQL.
    expect(rows[0].prosrc).toMatch(/using v_url, v_secret/);
    expect(rows[0].prosrc).not.toMatch(/format\s*\(|quote_literal|quote_ident/i);
  });

  it('API roles cannot touch the ping table or call the function', async () => {
    const { rows } = await admin.query(
      `select r.role, p.privilege
       from unnest(array['anon','authenticated','service_role']) as r(role),
            unnest(array['select','insert','update','delete']) as p(privilege)
       where has_table_privilege(r.role, 'private.dispatch_ping', p.privilege)`,
    );
    expect(rows).toEqual([]);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const client = await admin.connect();
      try {
        await client.query(`set role ${role}`);
        await expect(client.query('select private.trigger_instant_dispatch()')).rejects.toMatchObject({
          code: '42501',
        });
      } finally {
        await client.query('rollback');
        await client.query('reset role');
        client.release();
      }
    }
  });
});

describe('instant dispatch: where pg_net and Vault are missing (local database)', () => {
  it('announcements and trainings still work, jobs are queued, the debounce slot is untouched', async () => {
    const { rows: pre } = await admin.query(
      "select to_regnamespace('net') as n, to_regclass('vault.decrypted_secrets') as v",
    );
    expect(pre[0]).toEqual({ n: null, v: null });
    const { communityId, organizerId, memberIds } = await fixture(3);
    await createAnnouncement(organizerId, communityId);
    await createTraining(organizerId, communityId);
    expect(await jobCount(admin)).toBe(memberIds.length * 2);
    expect(await pingIsNever(admin)).toBe(true);
  });
});

describe('instant dispatch: with stubbed pg_net and Vault', () => {
  it('a fan-out to many recipients calls the function once, with the cron job call shape', async () => {
    const { communityId, organizerId, memberIds } = await fixture(6);
    await withStubs({}, async (s) => {
      await s.asUser(organizerId, CREATE_ANNOUNCEMENT, [communityId, 'Big news', 'Hello all']);
      expect(await jobCount(s.client)).toBe(memberIds.length);
      const calls = await s.calls();
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${URL_BASE}/functions/v1/dispatch-notifications`);
      expect(calls[0].headers).toEqual({ 'content-type': 'application/json', 'x-dispatch-secret': SECRET });
      expect(calls[0].body).toEqual({});
      expect(calls[0].timeout).toBe(120000);
      expect(s.notices.filter((n) => n.startsWith('WARNING'))).toEqual([]);
    });
  });

  it('debounces: inserts within 2 s add no call, one after 2 s does', async () => {
    const { communityId, organizerId } = await fixture(2);
    await withStubs({}, async (s) => {
      await s.asUser(organizerId, CREATE_ANNOUNCEMENT, [communityId, 'One', 'b']);
      await s.asUser(organizerId, CREATE_ANNOUNCEMENT, [communityId, 'Two', 'b']);
      await s.asUser(organizerId, CREATE_ANNOUNCEMENT, [communityId, 'Three', 'b']);
      expect(await s.calls()).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 2100));
      await s.asUser(organizerId, CREATE_ANNOUNCEMENT, [communityId, 'Four', 'b']);
      expect(await s.calls()).toHaveLength(2);
      expect(await jobCount(s.client)).toBe(8);
    });
  });

  it('an error thrown by http_post does not abort the creating transaction and leaks no secret', async () => {
    const { communityId, organizerId, memberIds } = await fixture(3);
    await withStubs({}, async (s) => {
      await s.client.query('update net.mode set fail = true');
      await s.asUser(organizerId, CREATE_ANNOUNCEMENT, [communityId, 'Still works', 'b']);
      expect(await jobCount(s.client)).toBe(memberIds.length);
      const warnings = s.notices.filter((n) => n.startsWith('WARNING'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('sqlstate P0001');
      const all = s.notices.join('\n');
      expect(all).not.toContain(SECRET);
      expect(all).not.toContain('exploded');
      expect(all).not.toContain(URL_BASE);
      // The failed attempt did not consume the debounce slot: the next insert tries again.
      expect(await pingIsNever(s.client)).toBe(true);
      await s.client.query('update net.mode set fail = false');
      await s.asUser(organizerId, CREATE_ANNOUNCEMENT, [communityId, 'Again', 'b']);
      expect(await s.calls()).toHaveLength(1);
    });
  });

  it('a rolled-back transaction records no call and leaves the debounce slot free', async () => {
    const { communityId, organizerId } = await fixture(2);
    await withStubs({}, async (s) => {
      await s.client.query('savepoint before_announcement');
      await s.asUser(organizerId, CREATE_ANNOUNCEMENT, [communityId, 'Doomed', 'b']);
      expect(await s.calls()).toHaveLength(1);
      await s.client.query('rollback to savepoint before_announcement');
      expect(await s.calls()).toHaveLength(0);
      expect(await pingIsNever(s.client)).toBe(true);
      expect(await jobCount(s.client)).toBe(0);
    });
  });

  it('does nothing while a secret is missing', async () => {
    const { communityId, organizerId } = await fixture(2);
    await withStubs({ secrets: false }, async (s) => {
      await s.asUser(organizerId, CREATE_ANNOUNCEMENT, [communityId, 'No secrets', 'b']);
      expect(await jobCount(s.client)).toBe(2);
      expect(await s.calls()).toHaveLength(0);
      expect(s.notices.filter((n) => n.startsWith('WARNING'))).toEqual([]);
    });
  });

  it('calls nothing for jobs scheduled for later (left to the cron safety net)', async () => {
    const { communityId, organizerId, memberIds } = await fixture(1);
    const announcement = await createAnnouncement(organizerId, communityId);
    await withStubs({}, async (s) => {
      const insertNotification = async (key: string) => {
        const { rows } = await s.client.query(
          `insert into public.notifications (user_id, community_id, kind, title, body, deep_link, dedupe_key, related_announcement_id)
           values ($1, $2, 'announcement_published', 't', 'b', '/activity', $3, $4) returning id`,
          [memberIds[0], communityId, key, announcement.id],
        );
        return rows[0].id as string;
      };
      await s.client.query(
        `insert into public.notification_delivery_jobs (notification_id, user_id, expires_at, next_attempt_at)
         values ($1, $2, now() + interval '1 day', now() + interval '1 hour')`,
        [await insertNotification('later'), memberIds[0]],
      );
      expect(await s.calls()).toHaveLength(0);
      await s.client.query(
        `insert into public.notification_delivery_jobs (notification_id, user_id, expires_at)
         values ($1, $2, now() + interval '1 day')`,
        [await insertNotification('now'), memberIds[0]],
      );
      expect(await s.calls()).toHaveLength(1);
    });
  });

  it('a concurrent holder of the debounce row never blocks the creating transaction', async () => {
    const { communityId, organizerId } = await fixture(2);
    const holder = await admin.connect();
    try {
      await holder.query('begin');
      await holder.query("update private.dispatch_ping set last_called = '-infinity'");
      await withStubs({}, async (s) => {
        const started = Date.now();
        await s.asUser(organizerId, CREATE_ANNOUNCEMENT, [communityId, 'No wait', 'b']);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(await jobCount(s.client)).toBe(2);
        expect(await s.calls()).toHaveLength(0);
      });
    } finally {
      await holder.query('rollback');
      holder.release();
    }
  });
});
