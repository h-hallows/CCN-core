import { getDb, type DbHandle, type Tx } from '../db/client';
import { applyMigrations } from '../db/migrate';
import { seed } from '../db/seed';

let prepared: Promise<DbHandle> | null = null;

/** The shared in-memory database, migrated and seeded once per test process. */
export function seededDb(): Promise<DbHandle> {
  prepared ??= (async () => {
    const handle = await getDb();
    await applyMigrations(handle, { quiet: true });
    await handle.exec(`SET app.operator_id = 'test';`);
    await truncateAll(handle);
    await seed(handle);
    return handle;
  })();
  return prepared;
}

export const TEST_CTX = { actor: 'test@example.com', ip: null, userAgent: null };

/** Assert that a database statement is rejected, and that the message says why. */
export async function expectRejection(
  run: () => Promise<unknown>,
  matcher: RegExp,
): Promise<string> {
  try {
    await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!matcher.test(message)) {
      throw new Error(`rejected, but not for the expected reason: ${message}`);
    }
    return message;
  }
  throw new Error('expected the statement to be rejected, but it succeeded');
}

export async function caseIdWhere(
  handle: DbHandle,
  where: string,
  params: unknown[] = [],
): Promise<string> {
  const [row] = await handle.query<{ id: string }>(
    `SELECT c.id FROM cases c JOIN households h ON h.id = c.household_id
      WHERE ${where} LIMIT 1`,
    params,
  );
  if (!row) throw new Error(`no case matching ${where}`);
  return row.id;
}

export async function providerIdByName(handle: DbHandle, name: string): Promise<string> {
  const [row] = await handle.query<{ id: string }>(
    `SELECT id FROM providers WHERE full_name = $1`, [name],
  );
  if (!row) throw new Error(`no provider named ${name}`);
  return row.id;
}

/**
 * Empty every table, enumerated from the database rather than from a list.
 *
 * A hand-maintained list silently stops covering tables that later migrations add — it
 * had already fallen behind `users` and all ten front-door tables, which is invisible on
 * an in-memory database that starts empty anyway, and shows up as a duplicate-key error
 * the second time the suite runs against a real Postgres.
 */
export async function truncateAll(handle: DbHandle): Promise<void> {
  const rows = await handle.query<{ table_name: string }>(
    // ORDER BY is load-bearing, not tidiness. TRUNCATE takes an ACCESS EXCLUSIVE lock
    // on every table named, in the order named. information_schema returns rows in no
    // guaranteed order, so two truncates could take the same locks in different orders
    // and deadlock — which is exactly what happened against a real Postgres: one run
    // green, the next failing in beforeAll with "deadlock detected" and skipping a
    // whole file. Every caller now takes the locks in the same order, so they queue
    // instead of deadlocking.
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_type = 'BASE TABLE'
        AND table_name <> '_migrations'
      ORDER BY table_name`,
  );
  if (rows.length === 0) return;
  const names = rows.map((r) => `"${r.table_name}"`).join(', ');

  // Ordering removes the cause; the retry covers anything else holding a lock when a
  // suite starts, which would otherwise fail the whole file rather than one test.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await handle.exec(`TRUNCATE ${names} RESTART IDENTITY CASCADE;`);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= 3 || !/deadlock|lock timeout|could not obtain lock/i.test(message)) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
}

/**
 * Run statements as one of the four audiences.
 *
 * `SET LOCAL` inside a transaction, so the claim cannot leak into the next test through
 * a pooled connection — which would quietly turn a household into an operator and make
 * every policy assertion pass.
 */
export async function asClaims<T>(
  handle: DbHandle,
  claims: Record<string, string> | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return handle.transaction(async (tx) => {
    // Switch off the owning/superuser role first. Postgres exempts a superuser from
    // row-level security outright and a table owner unless the table is FORCEd, so
    // asserting the policy matrix as the connection's default role would pass every
    // test while enforcing nothing.
    await tx.query(`SET LOCAL ROLE ccn_app`);
    await tx.query(
      `SELECT set_config('request.jwt.claims', $1, true)`,
      [claims ? JSON.stringify(claims) : ''],
    );
    return fn(tx);
  });
}

/** Assert a statement is refused, whether by a policy or by a guard trigger. */
export async function expectDenied(run: () => Promise<unknown>): Promise<void> {
  let denied = false;
  try {
    await run();
  } catch {
    denied = true;
  }
  if (!denied) throw new Error('expected the statement to be denied, but it succeeded');
}
