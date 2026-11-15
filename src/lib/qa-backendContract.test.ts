/**
 * QA (M1-Q1 part 2): the mobile data layer checked against the real
 * migrations, by reading both as text. No database is started and nothing is
 * mocked: every `.from()`, `.rpc()`, column list, embed hint and argument name
 * in `src/**` has to exist in `supabase/migrations/*.sql`, and the
 * hand-written `database.types.ts` has to agree with the SQL about which
 * columns can be null.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');

const sql = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))
  .join('\n');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SRC = path.join(ROOT, 'src');
const sourceFiles = listSourceFiles(SRC);

type TableInfo = { columns: Map<string, { nullable: boolean }>; body: string };

/** Parses `create table public.x ( ... );` blocks. */
function parseTables(text: string): Map<string, TableInfo> {
  const tables = new Map<string, TableInfo>();
  const header = /create table public\.(\w+) \(\n/g;
  let match: RegExpExecArray | null;
  while ((match = header.exec(text)) !== null) {
    const start = match.index + match[0].length;
    const end = text.indexOf('\n);', start);
    const body = text.slice(start, end);
    const columns = new Map<string, { nullable: boolean }>();
    for (const line of body.split('\n')) {
      const column = /^ {2}(\w+) (?!\()([a-z][\w. ]*?)(?: |,|$)(.*)$/.exec(line);
      if (!column) continue;
      const [, name, , rest] = column;
      if (['constraint', 'unique', 'primary', 'check', 'foreign'].includes(name)) continue;
      const full = line.trim();
      columns.set(name, { nullable: !/not null|primary key/i.test(full) && rest !== undefined });
    }
    tables.set(match[1], { columns, body });
  }
  return tables;
}

const tables = parseTables(sql);

describe('QA contract: tables read by the app', () => {
  const calls: { file: string; table: string; index: number; text: string }[] = [];
  for (const file of sourceFiles) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\.from\('(\w+)'\)/g)) {
      calls.push({ file: path.relative(ROOT, file), table: m[1], index: m.index ?? 0, text });
    }
  }

  it('finds the calls it is meant to check', () => {
    expect(calls.length).toBeGreaterThanOrEqual(8);
  });

  it.each(calls.map((call) => [call.file, call.table, call] as const))(
    '%s reads public.%s, which exists with row level security on',
    (_file, table) => {
      expect(tables.has(table), `no create table public.${table}`).toBe(true);
      expect(sql).toMatch(new RegExp(`alter table public\\.${table} enable row level security`));
    },
  );

  it('every plain column named in select / eq / order exists on its table', () => {
    const problems: string[] = [];
    for (const call of calls) {
      const table = tables.get(call.table);
      if (!table) continue;
      // The statement is everything up to the next `;` after the .from(...)
      const statementEnd = call.text.indexOf(';', call.index);
      const statement = call.text.slice(call.index, statementEnd === -1 ? undefined : statementEnd);

      const names = new Set<string>();
      for (const m of statement.matchAll(/\.(?:eq|order|neq|gt|lt|in)\(\s*'(\w+)'/g)) names.add(m[1]);
      const select = /\.select\(\s*(?:\n\s*[^'\n]*\n\s*)?'([^']*)'/.exec(statement);
      if (select) {
        // Drop embeds: alias:table!hint(cols) / table(cols)
        const flat = select[1].replace(/\w+:[\w!]+\([^)]*\)/g, '').replace(/\w+\([^)]*\)/g, '');
        for (const part of flat.split(',')) {
          const name = part.trim();
          if (name !== '' && name !== '*') names.add(name);
        }
      }
      for (const name of names) {
        if (!table.columns.has(name)) problems.push(`${call.file}: ${call.table}.${name}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every embed hint names a real foreign key that points at the embedded table', () => {
    const problems: string[] = [];
    for (const file of sourceFiles) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(\w+):(\w+)!(\w+)\(/g)) {
        const [, , target, constraint] = m;
        const nameMatch = /^(\w+)_(\w+?)_fkey$/.exec(constraint);
        if (!nameMatch) {
          // An explicit constraint name must be declared in the SQL.
          if (!sql.includes(`constraint ${constraint}`)) problems.push(`${file}: ${constraint}`);
          continue;
        }
        // Default naming: <table>_<column>_fkey. Longest known table prefix wins.
        const owner = [...tables.keys()]
          .filter((name) => constraint.startsWith(`${name}_`))
          .sort((a, b) => b.length - a.length)[0];
        if (!owner) {
          problems.push(`${path.relative(ROOT, file)}: no table for ${constraint}`);
          continue;
        }
        const column = constraint.slice(owner.length + 1, -'_fkey'.length);
        const body = tables.get(owner)?.body ?? '';
        const declared = new RegExp(`^ {2}${column} uuid[^\\n]*references public\\.${target} `, 'm');
        const explicit = sql.includes(`constraint ${constraint}`);
        if (!declared.test(body) && !explicit) {
          problems.push(`${path.relative(ROOT, file)}: ${constraint} is not ${owner}.${column} -> ${target}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

/** `create function public.name(args)` argument names, by function name. */
function parseFunctions(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of text.matchAll(/create function public\.(\w+)\(([\s\S]*?)\)\s*returns/g)) {
    const args = m[2]
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter((name) => name !== '');
    out.set(m[1], args);
  }
  return out;
}

const functions = parseFunctions(sql);

describe('QA contract: RPCs called by the app', () => {
  const rpcs: { file: string; name: string; keys: string[] }[] = [];
  for (const file of sourceFiles) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\.rpc\(\s*'(\w+)'\s*,\s*\{([^}]*)\}/g)) {
      const keys = [...m[2].matchAll(/(\w+)\s*:/g)].map((k) => k[1]);
      rpcs.push({ file: path.relative(ROOT, file), name: m[1], keys });
    }
  }

  it('finds every RPC the app uses', () => {
    expect(new Set(rpcs.map((r) => r.name))).toEqual(
      new Set([
        'preview_invitation',
        'redeem_invitation',
        'create_invitation',
        'revoke_invitation',
        'update_display_name',
        'create_training',
        'update_training',
        'cancel_training',
        'set_rsvp',
        'get_attendance_sheet',
        'record_attendance',
        'add_walk_in_attendee',
        'finalize_attendance',
        'create_announcement',
        'update_announcement',
        'cancel_announcement',
        'mark_announcement_read',
        'mark_notification_read',
        'mark_all_notifications_read',
        'register_push_token',
        'set_notification_preferences',
        'get_my_statistics',
        'get_my_attendance_history',
        'get_member_statistics',
        'get_community_statistics',
        'list_member_statistics_summary',
      ]),
    );
  });

  it.each(rpcs.map((r) => [r.file, r.name, r] as const))(
    '%s calls %s with exactly the argument names the function declares',
    (_file, name, rpc) => {
      const declared = functions.get(name);
      expect(declared, `no function public.${name}`).toBeDefined();
      expect([...rpc.keys].sort()).toEqual([...(declared ?? [])].sort());
    },
  );

  it.each(rpcs.map((r) => [r.name] as const))('%s is executable by authenticated only', (name) => {
    expect(sql).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\)\\s+to authenticated`));
    expect(sql).not.toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\)\\s+to (anon|public)`));
  });

  it('no client code calls a service_role-only function', () => {
    for (const name of ['admin_create_community', 'finalize_due_sessions']) {
      for (const file of sourceFiles) {
        if (file.endsWith('database.types.ts')) continue;
        expect(readFileSync(file, 'utf8'), `${file} calls ${name}`).not.toMatch(
          new RegExp(`\\.rpc\\(\\s*'${name}'`),
        );
      }
    }
  });
});

describe('QA contract: database.types.ts versus the SQL', () => {
  const typesText = readFileSync(path.join(SRC, 'lib', 'database.types.ts'), 'utf8');

  function rowType(table: string): Map<string, boolean> | null {
    const start = typesText.indexOf(`      ${table}: {\n        Row: {`);
    if (start === -1) return null;
    const end = typesText.indexOf('\n        };', start);
    const block = typesText.slice(start, end);
    const row = new Map<string, boolean>();
    for (const m of block.matchAll(/^ {10}(\w+): ([^;]+);$/gm)) row.set(m[1], /\| null$/.test(m[2]));
    return row;
  }

  const appTables = [
    'communities',
    'profiles',
    'memberships',
    'invitation_codes',
    'activity_types',
    'training_sessions',
    'training_rsvps',
  ];

  it.each(appTables)('Row of %s has the same columns as the SQL', (table) => {
    const row = rowType(table);
    expect(row, `no Row type for ${table}`).not.toBeNull();
    expect([...(row?.keys() ?? [])].sort()).toEqual([...(tables.get(table)?.columns.keys() ?? [])].sort());
  });

  function nullabilityMismatches(table: string): string[] {
    const row = rowType(table);
    const mismatches: string[] = [];
    for (const [column, info] of tables.get(table)?.columns ?? []) {
      const typedNullable = row?.get(column);
      if (typedNullable !== undefined && typedNullable !== info.nullable) {
        mismatches.push(
          `${table}.${column}: SQL ${info.nullable ? 'nullable' : 'not null'}, type ${typedNullable ? 'nullable' : 'not null'}`,
        );
      }
    }
    return mismatches;
  }

  it.each(appTables.filter((table) => table !== 'training_sessions'))(
    'Row of %s agrees with the SQL about nullability',
    (table) => {
      expect(nullabilityMismatches(table)).toEqual([]);
    },
  );

  // DEFECT Q2-7: organizer_id is nullable since the Q1-2 fix (on delete set null), but the
  // hand-written type still says `string`. Fixed in database.types.ts.
  it('Row of training_sessions agrees with the SQL about nullability (was DEFECT Q2-7)', () => {
    expect(nullabilityMismatches('training_sessions')).toEqual([]);
  });
});
