/**
 * Database client.
 *
 * Two drivers, same schema:
 *  - DATABASE_URL set   -> node-postgres against a real Postgres 16 (`npm run db:up`,
 *                          or Supabase/RDS in deployment).
 *  - DATABASE_URL unset -> embedded PGlite (WASM Postgres 16) at ./.pglite, so the
 *                          invariant triggers in migration 0001 can be exercised with
 *                          no server installed. Tests always use an in-memory PGlite.
 *                          A production build refuses this fallback outright — see
 *                          lib/env.ts for why.
 *
 * Either way the connection sets `app.operator_id`, which is what the RLS policies in
 * migration 0001 check.
 */
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { resolveDatabaseConfig, resolveMigrationConfig } from '../env';
import type { DatabaseConfig } from '../env';
import * as schema from '../schema';

export type Database = ReturnType<typeof drizzlePg<typeof schema>> | ReturnType<typeof drizzlePglite<typeof schema>>;

/**
 * A driver-agnostic handle.
 *  - `db`    Drizzle, for typed application queries.
 *  - `exec`  multi-statement SQL, for migrations.
 *  - `query` a single parameterised statement returning rows, for the few places where
 *            hand-written SQL is clearer than the query builder.
 */
export interface DbHandle {
  db: Database;
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Run `fn` inside one transaction on one connection, committing on return and rolling
   * back on throw. The referral transaction (I3) depends on this: issuing BEGIN and the
   * inserts as separate pool queries can land on different connections, which would
   * leave a referral committed without its disclosure.
   */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  driver: 'postgres' | 'pglite';
}

/** A single connection inside a transaction. */
export interface Tx {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

const OPERATOR_ID = 'operator';
const OPERATOR_SETTING = `SET app.operator_id = '${OPERATOR_ID}'`;

let cached: Promise<DbHandle> | null = null;

export function getDb(): Promise<DbHandle> {
  cached ??= connect();
  return cached;
}

async function connect(): Promise<DbHandle> {
  // Throws rather than falling back to an embedded database in production. See lib/env.ts.
  return open(resolveDatabaseConfig(process.env));
}

function open(config: DatabaseConfig): Promise<DbHandle> {
  return config.driver === 'postgres'
    ? connectPostgres(config.url)
    : connectPglite(process.env.PGLITE_DIR ?? './.pglite');
}

/**
 * A fresh, uncached handle for migrations and seeding, over DIRECT_URL when one is set.
 * A pooled connection cannot run migration 0001's CREATE TYPE / FUNCTION / TRIGGER
 * statements, so this never shares the application's pool.
 */
export function openMigrationDb(): Promise<DbHandle> {
  return open(resolveMigrationConfig(process.env));
}

async function connectPostgres(connectionString: string): Promise<DbHandle> {
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString,
    ssl: /\bsslmode=require\b/.test(connectionString) ? { rejectUnauthorized: true } : undefined,
    max: 8,
    // The RLS policies in migration 0001 check app.operator_id. Setting it as a startup
    // parameter means the connection is never usable without it. Doing the same from a
    // `connect` event handler races the first real query on that connection, because the
    // handler cannot be awaited.
    options: `-c app.operator_id=${OPERATOR_ID}`,
  });
  return {
    db: drizzlePg(pool, { schema }),
    exec: async (sql) => void (await pool.query(sql)),
    query: async (sql, params) => (await pool.query(sql, params as never)).rows,
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({
          query: async (sql, params) => (await client.query(sql, params as never)).rows as never,
        });
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
    driver: 'postgres',
  };
}

async function connectPglite(dataDir: string | undefined): Promise<DbHandle> {
  const { PGlite } = await import('@electric-sql/pglite');
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  await client.exec(OPERATOR_SETTING);
  return {
    db: drizzlePglite(client, { schema }),
    exec: (sql) => client.exec(sql).then(() => undefined),
    query: async (sql, params) => (await client.query(sql, params as never)).rows as never,
    transaction: (fn) =>
      client.transaction(async (tx) =>
        fn({ query: async (sql, params) => (await tx.query(sql, params as never)).rows as never }),
      ) as Promise<never>,
    close: () => client.close(),
    driver: 'pglite',
  };
}

/** A fresh, isolated, in-memory database with migrations applied. Tests only. */
export async function createTestDb(): Promise<DbHandle> {
  const handle = await connectPglite(undefined);
  const { applyMigrations } = await import('./migrate');
  await applyMigrations(handle, { quiet: true });
  return handle;
}
