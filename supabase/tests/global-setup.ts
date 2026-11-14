import fs from 'node:fs/promises';
import path from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';
import type { TestProject } from 'vitest/node';

/**
 * Boots a throwaway PostgreSQL cluster (real binaries from the `embedded-postgres` package),
 * applies the Supabase shim and then every migration in name order.
 *
 * Windows notes: the cluster is `persistent` and lives in our own directory under `.tmp/`,
 * which is wiped before each run. With `persistent: false` the library removes the directory
 * during `stop()` while Postgres still holds file handles, which fails with EBUSY.
 */

const PORT = 54329;
const USER = 'postgres';
const PASSWORD = 'postgres';
const DATABASE = 'postgres';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function applySqlFile(client: Client, file: string): Promise<void> {
  const sql = await fs.readFile(file, 'utf8');
  try {
    await client.query(sql);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to apply ${path.basename(file)}: ${reason}`, { cause: error });
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const root = project.config.root;
  const dataDir = path.join(root, '.tmp', 'pgdata-test');
  const migrationsDir = path.join(root, 'supabase', 'migrations');
  const shimFile = path.join(root, 'supabase', 'tests', 'shim.sql');

  try {
    await removeDir(dataDir);
  } catch (error) {
    throw new Error(
      `Could not delete the stale test database directory ${dataDir}. ` +
        `A Postgres process from an earlier run may still be using it (port ${PORT}); stop it and retry.`,
      { cause: error },
    );
  }
  await fs.mkdir(path.dirname(dataDir), { recursive: true });

  // Postgres writes its regular server log to stderr. Keep it quiet unless startup fails.
  const serverLog: string[] = [];
  const capture = (message: unknown) => {
    serverLog.push(message instanceof Error ? message.message : String(message));
  };

  const postgres = new EmbeddedPostgres({
    databaseDir: dataDir,
    port: PORT,
    user: USER,
    password: PASSWORD,
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    // Throwaway cluster: durability is irrelevant, speed is not.
    postgresFlags: ['-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off'],
    onLog: capture,
    onError: capture,
  });

  const stop = async () => {
    try {
      await postgres.stop();
    } catch (error) {
      console.warn('[test db] could not stop embedded Postgres cleanly:', error);
    }
    try {
      await removeDir(dataDir);
    } catch (error) {
      // Not fatal: the directory is gitignored and is wiped at the start of the next run.
      console.warn('[test db] could not remove the data directory:', error);
    }
  };

  try {
    await postgres.initialise();
    await postgres.start();

    const databaseUrl = `postgres://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`;
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await applySqlFile(client, shimFile);
      const migrations = (await fs.readdir(migrationsDir))
        .filter((name) => name.endsWith('.sql'))
        .sort();
      for (const name of migrations) {
        await applySqlFile(client, path.join(migrationsDir, name));
      }
    } finally {
      await client.end();
    }

    process.env.TEST_DATABASE_URL = databaseUrl;
    project.provide('databaseUrl', databaseUrl);
  } catch (error) {
    console.error(serverLog.join('\n'));
    await stop();
    throw error;
  }

  return stop;
}
