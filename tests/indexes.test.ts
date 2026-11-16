/**
 * Every foreign key is indexed on the side that needs it.
 *
 * Postgres indexes the REFERENCED side of a foreign key because it has to; the target is
 * a primary or unique key. It indexes the referencing side not at all. That asymmetry is
 * the most reliably forgotten fact about this database, and it had been forgotten
 * twenty-three times before migration 0024 — including on `household_users.household_id`,
 * which row-level security reads per candidate row rather than once per query.
 *
 * The test exists because the gap is invisible. Nothing fails, nothing warns, and at
 * this size nothing is even slow: the whole database is a few hundred rows, so a
 * sequential scan and an index lookup are indistinguishable. It becomes visible at the
 * point where fixing it means holding a lock over a table somebody is reading.
 *
 * It asks the catalogue rather than reading the migrations, which is the only way to
 * answer the question truthfully — an index can arrive in any migration, under any name,
 * as part of a UNIQUE constraint or a composite, and a grep for CREATE INDEX would miss
 * most of those and then say the schema was fine.
 *
 * EXCUSES ARE NAMED, NOT COUNTED. `EXCUSED` is empty, and the intent is that it stays
 * that way: a rule with no exceptions is one nobody has to keep true. If a key is ever
 * added that genuinely should not be indexed — a column written once and never joined on
 * — it goes here with a reason long enough to have required thought.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '../src/db/client';
import { seededDb } from '../src/testing/db';

let db: DbHandle;

beforeAll(async () => { db = await seededDb(); });

/**
 * Foreign keys whose referencing column may go unindexed, and why.
 *
 * Keyed `table.column`. Deliberately empty; see the note above.
 */
const EXCUSED: Record<string, string> = {};

interface Fk {
  table: string;
  column: string;
  refs: string;
  columns: number;
  indexed: boolean;
}

/**
 * Every foreign key, with whether some index LEADS with its referencing column.
 *
 * Leading is the test, not membership: an index on (b, a) does nothing for a lookup by
 * `a`, so counting it would pass a schema that is still scanning. `indkey[0]` is the
 * first indexed column, and a composite that happens to start with the key column counts
 * — which is correct, and is why this cannot be answered by looking for an index whose
 * name matches a convention.
 */
async function foreignKeys(): Promise<Fk[]> {
  return db.query<Fk>(
    `SELECT c.conrelid::regclass::text              AS table,
            a.attname::text                         AS column,
            c.confrelid::regclass::text             AS refs,
            array_length(c.conkey, 1)               AS columns,
            EXISTS (SELECT 1 FROM pg_index i
                     WHERE i.indrelid = c.conrelid
                       AND i.indkey[0] = k.attnum)  AS indexed
       FROM pg_constraint c
       JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON k.ord = 1
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.contype = 'f'
        AND c.connamespace = 'public'::regnamespace
      ORDER BY 1, 2`,
  );
}

describe('foreign keys are indexed on the referencing side', () => {
  it('finds the keys at all, so a silent empty result cannot pass this file', async () => {
    const fks = await foreignKeys();
    // Sabotage guard. Every assertion below is over this list, and a query that returned
    // nothing — a renamed catalogue column, a schema that failed to migrate — would make
    // all of them vacuously true.
    expect(fks.length).toBeGreaterThan(40);
  });

  it('leaves none of them unindexed', async () => {
    const missing = (await foreignKeys())
      .filter((f) => f.columns === 1 && !f.indexed)
      .map((f) => `${f.table}.${f.column} -> ${f.refs}`)
      .filter((k) => !(k.split(' ')[0]! in EXCUSED));

    expect(
      missing,
      'A foreign key with no index on the referencing side. Every join from the child, '
      + 'every delete of a parent, and every RLS predicate over it is a sequential scan. '
      + `Add one in a migration:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has no composite foreign key quietly relying on this rule', async () => {
    /*
     * The rule above is written for single-column keys, because a composite wants an
     * index chosen rather than generated. There are none today. If one appears, it needs
     * a decision rather than this test's silence.
     */
    const composite = (await foreignKeys())
      .filter((f) => f.columns > 1)
      .map((f) => `${f.table}.${f.column} (+${f.columns - 1} more) -> ${f.refs}`);
    expect(composite).toEqual([]);
  });

  it('excuses nothing without a reason somebody had to write', () => {
    for (const [key, reason] of Object.entries(EXCUSED)) {
      expect(reason.length, `${key} is excused with too short a reason`).toBeGreaterThan(40);
    }
  });
});
