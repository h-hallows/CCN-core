/**
 * The audit vocabulary, and the spans that make § 3.8 answerable.
 *
 * Two things are being protected here. One is the completeness of the classification —
 * every table either has an entity or an explicit reason for having none, so a table
 * added next year cannot fall out of "who looked at this household" silently. The other
 * is that the span SQL actually runs: a fragment naming a column that has since been
 * renamed would make the audit screen UNDER-report, and under-reporting is the one
 * direction that looks like a clean record.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_ENTITIES, AUDIT_ENTITY_ALIASES, AUDIT_ENTITY_NAMES, AUDIT_VIEW_NAMES,
  UNAUDITED_TABLES, auditEntityLabel, canonicalAuditEntity, isAuditEntity, isAuditView,
} from '../src/domain/audit';
import type { DbHandle } from '../src/db/client';
import { expectRejection, seededDb } from '../src/testing/db';

let db: DbHandle;

beforeAll(async () => { db = await seededDb(); });

async function tables(): Promise<string[]> {
  const rows = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

describe('every table is classified', () => {
  it('accounts for all of them, with no table in both lists', async () => {
    const audited = new Set<string>(AUDIT_ENTITY_NAMES.map((e) => AUDIT_ENTITIES[e].table));
    const excused = new Set(Object.keys(UNAUDITED_TABLES));

    const both = [...audited].filter((t) => excused.has(t));
    expect(both, `both audited and excused: ${both.join(', ')}`).toEqual([]);

    const unclassified = (await tables())
      .filter((t) => !audited.has(t) && !excused.has(t));
    expect(
      unclassified,
      `no audit entity and no reason for having none: ${unclassified.join(', ')}. `
      + 'Add an entity to AUDIT_ENTITIES or a reason to UNAUDITED_TABLES.',
    ).toEqual([]);
  });

  it('names no table that does not exist', async () => {
    const real = new Set(await tables());
    const invented = ([
      ...AUDIT_ENTITY_NAMES.map((e) => AUDIT_ENTITIES[e].table),
      ...Object.keys(UNAUDITED_TABLES),
    ] as string[]).filter((t) => !real.has(t) && t !== '_migrations');
    expect(invented, `classified but not a table: ${invented.join(', ')}`).toEqual([]);
  });

  it('gives a reason worth reading for every unaudited table', () => {
    for (const [table, reason] of Object.entries(UNAUDITED_TABLES)) {
      expect(reason.length, table).toBeGreaterThan(20);
    }
  });
});

describe('the spans run, and select ids of their own table', () => {
  it('runs every household span against a real household', async () => {
    const [household] = await db.query<{ id: string }>(
      `SELECT id FROM households ORDER BY created_at LIMIT 1`,
    );
    expect(household).toBeDefined();

    for (const name of AUDIT_ENTITY_NAMES) {
      const sql = AUDIT_ENTITIES[name].byHousehold;
      if (!sql) continue;
      const rows = await db.query<{ id: string }>(sql, [household!.id]);
      // The fragment must run and must yield a column called `id`. Zero rows is a
      // legitimate answer for a household with no documents; a thrown error is not.
      for (const row of rows) expect(Object.keys(row), name).toContain('id');
    }
  });

  it('runs every provider span against a real provider', async () => {
    const [provider] = await db.query<{ id: string }>(
      `SELECT id FROM providers ORDER BY created_at LIMIT 1`,
    );
    expect(provider).toBeDefined();

    for (const name of AUDIT_ENTITY_NAMES) {
      const sql = AUDIT_ENTITIES[name].byProvider;
      if (!sql) continue;
      const rows = await db.query<{ id: string }>(sql, [provider!.id]);
      for (const row of rows) expect(Object.keys(row), name).toContain('id');
    }
  });

  /*
   * The span is only worth anything if the ids it returns are really rows of the table
   * the entity names. A fragment that selected the join column by mistake — `case_id`
   * where `id` was meant — would return plausible uuids that match no audit row, and
   * the screen would show a clean history for a household that had been read all day.
   */
  it('returns ids that exist in the entity\'s own table', async () => {
    /*
     * Across every seeded household, not one of them. A single household exercises
     * three or four of these fragments; the set as a whole exercises all the ones the
     * demo data can reach, and the count below is what stops this passing vacuously.
     */
    const households = await db.query<{ id: string }>(`SELECT id FROM households`);
    expect(households.length).toBeGreaterThan(3);

    const exercised = new Set<string>();
    for (const name of AUDIT_ENTITY_NAMES) {
      const def = AUDIT_ENTITIES[name];
      if (!def.byHousehold) continue;
      for (const household of households) {
        const ids = await db.query<{ id: string }>(def.byHousehold, [household.id]);
        if (ids.length === 0) continue;
        const [found] = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${def.table} WHERE id = ANY($1::uuid[])`,
          [ids.map((r) => r.id)],
        );
        expect(Number(found!.n), `${name}: ids not found in ${def.table}`)
          .toBe(ids.length);
        exercised.add(name);
      }
    }
    expect(
      [...exercised].sort(),
      'the seed no longer reaches enough of the schema for this to prove anything',
    ).toEqual(expect.arrayContaining([
      'case', 'disclosure', 'household', 'referral', 'timeline_entry',
    ]));
    /*
     * `document` and `published_shortlist` are absent because the seed files no
     * documents and publishes no benches — both are things an operator does. Their SQL
     * is still executed by the two tests above; what is unverified is only that the
     * ids they return are rows of their own table.
     */
  });
});

describe('reading what was written before the vocabulary existed', () => {
  it('translates the drifted plurals', () => {
    expect(canonicalAuditEntity('cases')).toBe('case');
    expect(canonicalAuditEntity('documents')).toBe('document');
    expect(canonicalAuditEntity('providers')).toBe('provider');
    expect(canonicalAuditEntity('credential_submissions')).toBe('credential_submission');
  });

  it('leaves a name it does not know as unrecognised rather than guessing', () => {
    expect(canonicalAuditEntity('invoices')).toBeNull();
    expect(canonicalAuditEntity('')).toBeNull();
    expect(canonicalAuditEntity(null)).toBeNull();
    expect(auditEntityLabel('invoices')).toBe('invoices');
  });

  it('maps every alias to an entity that exists', () => {
    for (const [stored, entity] of Object.entries(AUDIT_ENTITY_ALIASES)) {
      expect(isAuditEntity(entity), `${stored} -> ${entity}`).toBe(true);
      // An alias for a name that is already canonical would shadow it.
      expect(isAuditEntity(stored), `${stored} is canonical and aliased`).toBe(false);
    }
  });

  it('keeps entities and views disjoint', () => {
    for (const view of AUDIT_VIEW_NAMES) {
      expect(isAuditEntity(view), view).toBe(false);
    }
    for (const entity of AUDIT_ENTITY_NAMES) {
      expect(isAuditView(entity), entity).toBe(false);
    }
  });
});

describe('the database enforces the same vocabulary', () => {
  it('holds a CHECK listing exactly the names TypeScript knows', async () => {
    const [row] = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'audit_log_entity_vocabulary'`,
    );
    expect(row, 'migration 0021 did not apply').toBeDefined();

    const inSql = [...row!.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
    const inCode = [...AUDIT_ENTITY_NAMES, ...AUDIT_VIEW_NAMES].sort();
    /*
     * The list is written twice — once in TypeScript so a call site cannot invent a
     * name, once in SQL so anything that is not a call site cannot either. This is what
     * stops the two copies drifting: adding an entity without a migration fails here.
     */
    expect(inSql).toEqual(inCode);
  });

  it('refuses a name nobody declared', async () => {
    await expectRejection(
      () => db.query(
        `INSERT INTO audit_log (actor, action, entity) VALUES ($1, 'read', 'invoices')`,
        ['test@example.com'],
      ),
      /audit_log_entity_vocabulary/,
    );
  });

  it('still accepts every name that was declared', async () => {
    for (const entity of [...AUDIT_ENTITY_NAMES, ...AUDIT_VIEW_NAMES]) {
      await db.query(
        `INSERT INTO audit_log (actor, action, entity) VALUES ($1, 'read', $2)`,
        ['vocabulary@example.com', entity],
      );
    }
    const [row] = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE actor = 'vocabulary@example.com'`,
    );
    expect(Number(row!.n)).toBe(AUDIT_ENTITY_NAMES.length + AUDIT_VIEW_NAMES.length);
  });

  /*
   * NOT VALID means the constraint binds inserts and leaves the rows already written
   * alone. Both halves matter, and the second is easy to lose by "tidying" the
   * migration later into a plain CHECK — which would fail to deploy against any
   * database holding the drifted history, and could only be made to succeed by
   * disabling the append-only trigger.
   */
  it('is NOT VALID, so the drifted history survives it', async () => {
    const [row] = await db.query<{ validated: boolean }>(
      `SELECT convalidated AS validated FROM pg_constraint
        WHERE conname = 'audit_log_entity_vocabulary'`,
    );
    expect(row!.validated).toBe(false);
  });
});
