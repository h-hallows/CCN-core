/**
 * The Drizzle schema and the migrations must describe the same database.
 *
 * They are maintained separately on purpose — migrations are hand-written SQL because
 * drizzle-kit cannot generate the triggers that carry I3, I4 and I11, and the append-only
 * guards. That separation is the right trade, but it means the two can drift: a table
 * added in SQL and forgotten in the schema is invisible to every consumer until someone
 * needs it, and a table in the schema with no migration is a query that fails in
 * production and nowhere else.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import type { DbHandle } from '../src/db/client';
import * as schema from '../src/schema';
import { seededDb } from '../src/testing/db';

let db: DbHandle;

beforeAll(async () => { db = await seededDb(); });

/** Every table the Drizzle schema declares. The module also exports enums and types. */
function declared(): PgTable[] {
  return Object.values(schema).filter((v) => is(v, PgTable)) as PgTable[];
}

function declaredTables(): string[] {
  return declared().map((t) => getTableName(t)).sort();
}

async function migratedTables(): Promise<string[]> {
  const rows = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_type = 'BASE TABLE'
        AND table_name <> '_migrations'
      ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

describe('schema and migrations describe the same database', () => {
  it('declares every table the migrations create', async () => {
    const missing = (await migratedTables()).filter((t) => !declaredTables().includes(t));
    expect(missing, `migrated but not declared: ${missing.join(', ')}`).toEqual([]);
  });

  it('declares no table the migrations do not create', async () => {
    const migrated = await migratedTables();
    const extra = declaredTables().filter((t) => !migrated.includes(t));
    expect(extra, `declared but never migrated: ${extra.join(', ')}`).toEqual([]);
  });

  it('declares every column, with no invented ones', async () => {
    const rows = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name <> '_migrations'`,
    );
    const migrated = new Map<string, Set<string>>();
    for (const r of rows) {
      const set = migrated.get(r.table_name) ?? new Set();
      set.add(r.column_name);
      migrated.set(r.table_name, set);
    }

    const problems: string[] = [];
    for (const table of declared()) {
      const name = getTableName(table);
      const actual = migrated.get(name);
      if (!actual) continue;                       // covered by the test above
      const columns = Object.values(getTableColumns(table)).map((c) => c.name);

      for (const col of columns) {
        if (!actual.has(col)) problems.push(`${name}.${col} declared but not migrated`);
      }
      for (const col of actual) {
        if (!columns.includes(col)) problems.push(`${name}.${col} migrated but not declared`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
