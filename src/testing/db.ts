import { getDb, type DbHandle } from '../db/client';
import { applyMigrations } from '../db/migrate';
import { seed } from '../db/seed';

let prepared: Promise<DbHandle> | null = null;

/** The shared in-memory database, migrated and seeded once per test process. */
export function seededDb(): Promise<DbHandle> {
  prepared ??= (async () => {
    const handle = await getDb();
    await applyMigrations(handle, { quiet: true });
    await handle.exec(`
      SET app.operator_id = 'test';
      TRUNCATE case_month_hours, service_failures, metric_events, audit_log, referral_feedback,
               referrals, disclosures, timeline_entries, coverage_gaps, cases, households,
               credential_events, credentials, providers, referral_partners, sessions,
               auth_tokens RESTART IDENTITY CASCADE;
    `);
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
