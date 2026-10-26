/**
 * Migration runner. Applies migrations/*.sql in filename order, once each.
 *
 *   npm run db:migrate          apply pending migrations
 *   npm run db:reset            drop the public schema first, then apply everything
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DbHandle } from './client';

// src/db/ -> the package root, where migrations/ lives beside src/.
/**
 * Load the workspace's .env before anything reads process.env.
 *
 * These scripts run from packages/core, but the connection strings belong to the
 * workspace, not to this package — there is one database, and one file naming it.
 * Vercel injects its own environment, where no .env exists and this is a no-op.
 */
export function loadWorkspaceEnv(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const envFile = join(root, '.env');
  try {
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  } catch {
    // An unreadable or malformed .env must not stop a deployment that sets real
    // environment variables instead.
  }
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
}

export async function applyMigrations(
  handle: DbHandle,
  opts: { reset?: boolean; quiet?: boolean } = {},
): Promise<string[]> {
  const log = (m: string) => { if (!opts.quiet) console.log(m); };

  if (opts.reset) {
    await handle.exec(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    log('dropped and recreated schema public');
  }

  // The migrator must satisfy the RLS policies it is about to create.
  await handle.exec(`
    SET app.operator_id = 'migrator';
    CREATE TABLE IF NOT EXISTS _migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const applied = new Set<string>();
  for (const r of await handle.query<{ name: string }>(`SELECT name FROM _migrations`)) {
    applied.add(r.name);
  }

  const ran: string[] = [];
  for (const { name, sql } of migrationFiles()) {
    if (applied.has(name)) continue;
    await handle.exec(`BEGIN;\n${sql}\nINSERT INTO _migrations (name) VALUES ('${name}');\nCOMMIT;`);
    ran.push(name);
    log(`applied ${name}`);
  }
  if (ran.length === 0) log('no pending migrations');
  return ran;
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

async function main(): Promise<void> {
  loadWorkspaceEnv();
  const { openMigrationDb } = await import('./client');
  const { describeConnection } = await import('../env');
  const handle = await openMigrationDb();
  const target = process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim();
  console.log(`driver: ${handle.driver}${target ? ` -> ${describeConnection(target)}` : ''}`);

  const reset = process.argv.includes('--reset');
  if (reset && handle.driver === 'postgres') {
    // --reset drops every table. Never let that happen to a remote database by accident.
    if (process.argv.includes('--i-mean-it')) {
      console.log('resetting a REMOTE database, as explicitly confirmed');
    } else {
      console.error(
        'Refusing to --reset a remote Postgres.\n'
        + 'This drops schema public and everything in it. If that is genuinely what you '
        + 'want, re-run with --i-mean-it.',
      );
      await handle.close();
      process.exit(1);
    }
  }

  await applyMigrations(handle, { reset });
  await handle.close();
}

if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
