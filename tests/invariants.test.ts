/**
 * § 7.3 — the schema half of the CI gate.
 *
 * These assertions are about the database itself: triggers, check constraints, enum
 * membership, row-level security. They live in @ccn/core so that no consuming app can
 * weaken them for itself. The behavioural half — the referral transaction, the shortlist
 * query layer — is in apps/registry/tests/referral.test.ts.
 *
 * These are the tests that keep a future contributor from quietly dismantling the legal
 * position. Every one maps to an invariant in /INVARIANTS.md. Do not weaken them, skip
 * them, or add an override path.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '../src/db/client';
import {
  caseIdWhere, expectRejection, providerIdByName, seededDb,
} from '../src/testing/db';

let db: DbHandle;

beforeAll(async () => { db = await seededDb(); });

describe('I3 — no referral without a disclosure', () => {
  it('rejects a referral row with no disclosure_id', async () => {
    const caseId = await caseIdWhere(db, `c.status = 'active'`);
    const providerId = await providerIdByName(db, 'Imelda Santoyo');
    await expectRejection(
      () => db.query(
        `INSERT INTO referrals (case_id, provider_id, referred_by) VALUES ($1,$2,'test')`,
        [caseId, providerId],
      ),
      /disclosure_id|not-null|null value/i,
    );
  });
});

describe('I11 — a skilled case cannot be referred without an ordering physician', () => {

  it('rejects the status transition at the database, even bypassing the application', async () => {
    const caseId = await caseIdWhere(
      db, `c.care = 'hospice_support' AND h.physician_name IS NULL`,
    );
    await expectRejection(
      () => db.query(`UPDATE cases SET status = 'referred' WHERE id = $1`, [caseId]),
      /no ordering physician/i,
    );
  });

  it('still allows a skilled case with no physician to be edited, so the gap can be filled', async () => {
    const caseId = await caseIdWhere(
      db, `c.care = 'hospice_support' AND h.physician_name IS NULL`,
    );
    await db.query(`UPDATE cases SET hours_per_week = 48 WHERE id = $1`, [caseId]);
    const [row] = await db.query<{ hours_per_week: number }>(
      `SELECT hours_per_week FROM cases WHERE id = $1`, [caseId],
    );
    expect(row!.hours_per_week).toBe(48);
  });
});

describe('append-only compliance record', () => {
  it('UPDATE on timeline_entries raises', async () => {
    await expectRejection(
      () => db.query(`UPDATE timeline_entries SET body = 'rewritten'`),
      /append-only/i,
    );
  });

  it('DELETE on timeline_entries raises', async () => {
    await expectRejection(() => db.query(`DELETE FROM timeline_entries`), /append-only/i);
  });

  it('DELETE on disclosures raises', async () => {
    await expectRejection(
      () => db.query(`DELETE FROM disclosures`),
      /permanent records and cannot be deleted/i,
    );
  });

  it('UPDATE disclosures SET disclosed_to raises', async () => {
    await expectRejection(
      () => db.query(`UPDATE disclosures SET disclosed_to = 'someone else'`),
      /immutable/i,
    );
  });

  it('UPDATE disclosures SET written_sent_on succeeds', async () => {
    const [row] = await db.query<{ id: string }>(
      `SELECT id FROM disclosures WHERE written_sent_on IS NULL LIMIT 1`,
    );
    expect(row).toBeDefined();
    await db.query(
      `UPDATE disclosures SET written_sent_on = current_date, written_method = 'post'
        WHERE id = $1`,
      [row!.id],
    );
    const [after] = await db.query<{ written_method: string }>(
      `SELECT written_method FROM disclosures WHERE id = $1`, [row!.id],
    );
    expect(after!.written_method).toBe('post');
  });

  it('DELETE on referrals raises', async () => {
    await expectRejection(() => db.query(`DELETE FROM referrals`), /append-only/i);
  });

  it('a referral cannot be reassigned to another provider after the fact', async () => {
    await expectRejection(
      () => db.query(
        `UPDATE referrals SET provider_id = (SELECT id FROM providers ORDER BY id LIMIT 1)`,
      ),
      /immutable/i,
    );
  });

  it('DELETE on audit_log raises', async () => {
    // Write a row first. These are row-level triggers, so a DELETE that matches nothing
    // fires nothing and succeeds — which would make this assertion pass for the wrong
    // reason on an empty table.
    await db.query(
      `INSERT INTO audit_log (actor, action, entity) VALUES ('test', 'read', 'providers')`,
    );
    await expectRejection(() => db.query(`DELETE FROM audit_log`), /append-only/i);
  });

  it('DELETE on credential_events raises', async () => {
    await expectRejection(() => db.query(`DELETE FROM credential_events`), /append-only/i);
  });

  it('a disclosure method outside phone or in person is rejected', async () => {
    const caseId = await caseIdWhere(db, `c.status = 'active'`);
    const [tl] = await db.query<{ id: string }>(
      `SELECT id FROM timeline_entries WHERE case_id = $1 LIMIT 1`, [caseId],
    );
    await expectRejection(
      () => db.query(
        `INSERT INTO disclosures (case_id, timeline_id, disclosed_to, disclosed_by, method, written_due_on)
         VALUES ($1,$2,'x','y','automated_voicemail',current_date)`,
        [caseId, tl!.id],
      ),
      /disclosures_method_live|check constraint/i,
    );
  });
});

describe('I4 — the registry cannot end a relationship', () => {
  it("ended_by cannot be set to 'registry'", async () => {
    const caseId = await caseIdWhere(db, `c.status = 'active'`);
    await expectRejection(
      () => db.query(`UPDATE cases SET ended_by = 'registry' WHERE id = $1`, [caseId]),
      /invalid input value for enum|registry/i,
    );
  });

  it('the ended_by enum has exactly three members, none of them the registry', async () => {
    const rows = await db.query<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'ended_by' ORDER BY e.enumsortorder`,
    );
    expect(rows.map((r) => r.label)).toEqual(['household', 'provider', 'mutual']);
  });
});

describe('I6 — the fee is charged to the household', () => {
  it("fee_charged_to cannot be set to 'provider'", async () => {
    const caseId = await caseIdWhere(db, `c.status = 'active'`);
    await expectRejection(
      () => db.query(`UPDATE cases SET fee_charged_to = 'provider' WHERE id = $1`, [caseId]),
      /fee_charged_to|check constraint/i,
    );
  });

  it('no column anywhere deducts from provider earnings', async () => {
    const rows = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (column_name LIKE '%deduction%' OR column_name LIKE '%withhold%'
               OR column_name LIKE '%provider_pay%')`,
    );
    expect(rows).toEqual([]);
  });
});

describe('I10 — needs profiles are the household\'s own words', () => {
  it("needs_authored_by cannot be anything but 'household'", async () => {
    const caseId = await caseIdWhere(db, `c.status = 'active'`);
    await expectRejection(
      () => db.query(`UPDATE cases SET needs_authored_by = 'registry' WHERE id = $1`, [caseId]),
      /needs_authored_by|check constraint/i,
    );
  });
});

describe('I7 — feedback informs referral decisions only', () => {
  it('use_restriction cannot be widened', async () => {
    const [ref] = await db.query<{ id: string }>(`SELECT id FROM referrals LIMIT 1`);
    await expectRejection(
      () => db.query(
        `INSERT INTO referral_feedback (referral_id, referral_service_rating, use_restriction)
         VALUES ($1, 4, 'performance_management')`,
        [ref!.id],
      ),
      /use_restriction|check constraint/i,
    );
  });

  it('accepts feedback about the referral service itself', async () => {
    const [ref] = await db.query<{ id: string }>(`SELECT id FROM referrals LIMIT 1`);
    await db.query(
      `INSERT INTO referral_feedback (referral_id, referral_service_rating, would_refer_again, notes)
       VALUES ($1, 5, true, 'Good fit, arranged quickly.')`,
      [ref!.id],
    );
    const [row] = await db.query<{ use_restriction: string }>(
      `SELECT use_restriction FROM referral_feedback WHERE referral_id = $1`, [ref!.id],
    );
    expect(row!.use_restriction).toBe('referral_decisions_only');
  });
});

describe('I1, I2, I7, I8 — the forbidden surfaces do not exist', () => {
  it('no table implies training, work direction, correction or issued equipment', async () => {
    const rows = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND (table_name LIKE 'training%' OR table_name LIKE 'course%'
            OR table_name LIKE 'module%'   OR table_name LIKE 'curriculum%'
            OR table_name LIKE 'competenc%'
            OR table_name LIKE 'task%'     OR table_name LIKE 'care_plan%'
            OR table_name LIKE 'duty%'     OR table_name LIKE 'duties%'
            OR table_name LIKE 'checklist%'
            OR table_name LIKE 'coaching%' OR table_name LIKE 'performance_review%'
            OR table_name LIKE 'corrective%'
            OR table_name LIKE 'inventory%' OR table_name LIKE 'uniform%'
            OR table_name LIKE 'equipment%' OR table_name LIKE 'badge%')`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });

  it('the coverage table records confirmation only, never task completion', async () => {
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'coverage_gaps'`,
    );
    const names = cols.map((c) => c.column_name).sort();
    expect(names).toEqual([
      'block', 'case_id', 'created_at', 'id', 'note', 'on_date',
      'resolved_at', 'resolved_provider_id',
    ]);
  });
});

describe('I9 — ccn-lint is a build gate', () => {
  const LINT = fileURLToPath(new URL('../src/lint/run.mjs', import.meta.url));

  /** Run the linter over a throwaway directory, so no test writes into the repo. */
  function lint(files: Record<string, string>): { ok: boolean; output: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ccn-lint-'));
    try {
      for (const [name, body] of Object.entries(files)) {
        writeFileSync(join(dir, name), body);
      }
      try {
        return { ok: true, output: execFileSync('node', [LINT, dir], { encoding: 'utf8' }) };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('passes on copy that calls them referred providers', () => {
    const { ok, output } = lint({
      'ok.tsx': 'export const P = () => <p>Referred providers on our roster</p>;\n',
    });
    expect(ok).toBe(true);
    expect(output).toMatch(/clean/);
  });

  it('fails on a planted forbidden string, naming the term', () => {
    const { ok, output } = lint({
      'bad.tsx': 'export const P = () => <p>Meet our caregivers</p>;\n',
    });
    expect(ok).toBe(false);
    expect(output).toMatch(/our caregivers/);
    expect(output).toMatch(/I9/);
  });

  it('does not flag the statutory words inside an explanatory comment', () => {
    const { ok, output } = lint({
      'commented.tsx':
        '// I9 forbids calling a referred provider an employee or an independent contractor.\n'
        + 'export const P = () => <p>Referred provider</p>;\n',
    });
    expect(ok).toBe(true);
    expect(output).toMatch(/clean/);
  });

  it('catches an identifier that would imply work direction (I2)', () => {
    const { ok, output } = lint({ 'tasks.ts': 'export const tasks = [];\n' });
    expect(ok).toBe(false);
    expect(output).toMatch(/I2/);
  });

  it('catches a snake_case identifier that would imply training (I1)', () => {
    const { ok, output } = lint({ 'mod.ts': 'export const training_modules = [];\n' });
    expect(ok).toBe(false);
    expect(output).toMatch(/I1/);
  });

  it('documents the known gap: camelCase slips past the word boundaries', () => {
    // `taskList` and `trainingModules` are NOT caught, because the patterns are
    // word-bounded. Pinned here so the limitation is visible rather than assumed away;
    // widening it belongs with the architecture spec § 2.5 ruleset merge.
    const { ok } = lint({ 'camel.ts': 'export const taskList = [];\n' });
    expect(ok).toBe(true);
  });

  it('is the ruleset the apps consume, not a second copy of it', async () => {
    const { FORBIDDEN_COPY } = await import('../src/lint/forbidden.mjs');
    expect(FORBIDDEN_COPY).toContain('independent contractor');
    expect(FORBIDDEN_COPY).toContain('our caregivers');
  });
});

describe('RLS is on from the first migration', () => {
  it('enables row level security on every table', async () => {
    const rows = await db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'r' AND NOT c.relrowsecurity`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});

afterAll(async () => {
  // The in-memory database goes with the process; nothing to clean up on disk.
});
