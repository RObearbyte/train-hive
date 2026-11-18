import { afterAll, describe, expect, it } from 'vitest';

import { admin, closeDb } from './helpers';

// Requests that reach the database through the Supabase API run with the pg-safeupdate extension:
// an UPDATE or DELETE without a WHERE clause fails with "UPDATE requires a WHERE clause"
// (SQLSTATE 21000). The embedded test database does not load that extension, so nothing else here
// would notice. This scans the final source of every function in the public and private schemas.
// (It found the instant-dispatch trigger, whose ping update failed live while the SQL editor and the
// local tests passed.)

afterAll(async () => {
  await closeDb();
});

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function unguardedStatements(source: string): string[] {
  // Blank out string literals (including dollar-quoted dynamic SQL is NOT blanked: it is real SQL).
  const text = stripComments(source).replace(/'(?:[^']|'')*'/g, "''");
  const found: string[] = [];
  for (const raw of text.split(';')) {
    const stmt = raw.replace(/\s+/g, ' ').trim();
    if (!stmt) continue;
    const isUpdate = /(^|[\s(])update\s+[\w."]+(\s+(as\s+)?\w+)?\s+set\b/i.test(stmt) && !/\bfor\s+update\b/i.test(stmt);
    const isDelete = /(^|[\s(])delete\s+from\s+[\w."]+/i.test(stmt);
    if (!isUpdate && !isDelete) continue;
    // ON CONFLICT ... DO UPDATE SET is an upsert, not a bare UPDATE.
    if (/\bdo\s+update\s+set\b/i.test(stmt) && !/(^|[\s(])update\s+[\w."]+(\s+(as\s+)?\w+)?\s+set\b/i.test(stmt.replace(/\bdo\s+update\s+set\b/gi, ''))) continue;
    if (/\bwhere\b/i.test(stmt)) continue;
    found.push(stmt.slice(0, 160));
  }
  return found;
}

describe('writes that the Supabase API layer would reject', () => {
  it('no function in public or private has an UPDATE or DELETE without WHERE', async () => {
    const { rows } = await admin.query<{ schema: string; name: string; src: string }>(
      `select n.nspname as schema, p.proname as name, p.prosrc as src
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and p.prokind = 'f'`,
    );
    expect(rows.length).toBeGreaterThan(50);
    const offenders = rows.flatMap((r) => unguardedStatements(r.src).map((s) => `${r.schema}.${r.name}: ${s}`));
    expect(offenders).toEqual([]);
  });

  it('the scanner itself recognizes the bad shapes and the good ones', () => {
    expect(unguardedStatements('update private.t set a = 1')).toHaveLength(1);
    expect(unguardedStatements('delete from public.t')).toHaveLength(1);
    expect(unguardedStatements('update private.t set a = 1 where id')).toHaveLength(0);
    expect(unguardedStatements('delete from public.t where at < now()')).toHaveLength(0);
    expect(unguardedStatements('perform 1 from private.t for update skip locked')).toHaveLength(0);
    expect(unguardedStatements("insert into t (a) values (1) on conflict (a) do update set a = 2")).toHaveLength(0);
    expect(unguardedStatements('update public.t x set a = 1 from public.u y where y.id = x.id')).toHaveLength(0);
  });
});
