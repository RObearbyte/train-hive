import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';
import type { TestProject } from 'vitest/node';

/**
 * Boots a throwaway PostgreSQL cluster (real binaries from the `embedded-postgres` package),
 * applies the Supabase shim and then every migration in name order.
 *
 * Several runs may execute at the same time (different agents, watch mode next to a one-off
 * run), so every run gets its own free port and its own data directory under `.tmp/`.
 *
 * Windows notes: the cluster is `persistent` and we delete the directory ourselves. With
 * `persistent: false` the library removes the directory during `stop()` while Postgres still
 * holds file handles, which fails with EBUSY.
 */

const DATA_DIR_PREFIX = 'pgdata-test';
const STALE_AFTER_MS = 60 * 60 * 1000;
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

/** Asks the OS for a TCP port that is free right now. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port);
        else reject(new Error('Could not determine a free port'));
      });
    });
  });
}

/** True when the directory holds a postmaster.pid whose process is still alive. */
async function isClusterRunning(dir: string): Promise<boolean> {
  let pid: number;
  try {
    const pidFile = await fs.readFile(path.join(dir, 'postmaster.pid'), 'utf8');
    // The first line of postmaster.pid is the process id; parseInt ignores what follows it.
    pid = Number.parseInt(pidFile, 10);
  } catch {
    // No pid file: the cluster was shut down cleanly or never started.
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else. Anything else: it is gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Best effort: deletes data directories left behind by runs that were killed, when they are
 * older than an hour and no Postgres is running on them. Never fails the run.
 */
async function removeStaleDataDirs(tmpDir: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(tmpDir);
  } catch {
    return;
  }
  for (const name of names.filter((entry) => entry.startsWith(DATA_DIR_PREFIX))) {
    const dir = path.join(tmpDir, name);
    try {
      const stats = await fs.stat(dir);
      if (!stats.isDirectory() || Date.now() - stats.mtimeMs < STALE_AFTER_MS) continue;
      if (await isClusterRunning(dir)) continue;
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch (error) {
      console.warn(`[test db] could not remove stale directory ${dir}:`, error);
    }
  }
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
  const tmpDir = path.join(root, '.tmp');
  const dataDir = path.join(
    tmpDir,
    `${DATA_DIR_PREFIX}-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  const migrationsDir = path.join(root, 'supabase', 'migrations');
  const shimFile = path.join(root, 'supabase', 'tests', 'shim.sql');

  await fs.mkdir(tmpDir, { recursive: true });
  await removeStaleDataDirs(tmpDir);
  const port = await findFreePort();

  // Postgres writes its regular server log to stderr. Keep it quiet unless startup fails.
  const serverLog: string[] = [];
  const capture = (message: unknown) => {
    serverLog.push(message instanceof Error ? message.message : String(message));
  };

  const postgres = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
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
      // Not fatal (typically EBUSY on Windows): the directory is gitignored and a later run
      // deletes it once it is an hour old.
      console.warn('[test db] could not remove the data directory:', error);
    }
  };

  try {
    await postgres.initialise();
    await postgres.start();

    const databaseUrl = `postgres://${USER}:${PASSWORD}@127.0.0.1:${port}/${DATABASE}`;
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
