/**
 * The assignment log — Civil Code § 1812.529. Migration 0023.
 *
 * `assignment_log` existed from migration 0004 and nothing wrote to it for the whole of
 * the project's history. The table had tests: it rejected UPDATE, it rejected DELETE, it
 * demanded a note on a correction. Every one of them passed against rows the test had
 * inserted itself, which is why none of them noticed that the application never did.
 *
 * So the first assertion here is the one that was missing: the seeded database, which is
 * the only end-to-end run of the referral path there is, contains a log sheet for every
 * private duty nursing referral in it. Everything after that defends the two triggers
 * and the one field list the sheets are written from.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '../src/db/client';
import { expectRejection, insertReferral, seededDb } from '../src/testing/db';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASSIGNMENT_FIELDS, ASSIGNMENT_LOG_CORRECTION, ASSIGNMENT_LOG_INSERT,
  BLOCKING_ASSIGNMENT_FIELDS, SKILLED, SKILLED_SQL_ARRAY, assignmentBlockedReason,
  assignmentMissing,
  feeBasisOf, type AssignmentField, type AssignmentFieldDef,
} from '../src/domain';

let db: DbHandle;

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await db.query<T>(sql, params);
  if (!row) throw new Error(`fixture query returned no rows: ${sql}`);
  return row;
}

/**
 * Columns of `assignment_log` that § 1812.529 does not enumerate, each with the reason
 * it is there anyway. The completeness test below fails if a new NOT NULL column is
 * neither a statutory field nor listed here, so the field list cannot quietly fall
 * behind the table it describes.
 */
const STRUCTURAL_COLUMNS: Record<string, string> = {
  id: 'the entry’s own key, which a correction points back at',
  case_id: 'which case the assignment is on; the statute names the patient, we also name the record',
  referral_id: 'the referral this sheet is the log of, and what the commit check reads by',
  recorded_by: 'who made the entry — not required by the section, required to answer for it',
  created_at: 'when the entry was made, which is not the hour the order arrived',
};

const MIGRATIONS = join(import.meta.dirname, '..', 'migrations');

beforeAll(async () => {
  db = await seededDb();
});

describe('the register is written, not merely present', () => {
  it('holds a sheet for every private duty nursing referral in the seed', async () => {
    const rows = await db.query<{ referral_id: string; care: string; sheets: string }>(
      `SELECT r.id AS referral_id, c.care,
              (SELECT count(*) FROM assignment_log a WHERE a.referral_id = r.id) AS sheets
         FROM referrals r JOIN cases c ON c.id = r.case_id`);
    const skilled = rows.filter((r) => (SKILLED as readonly string[]).includes(r.care));
    expect(skilled.length).toBeGreaterThan(0);
    for (const r of skilled) {
      expect(Number(r.sheets), `referral ${r.referral_id} (${r.care}) has no log sheet`)
        .toBeGreaterThan(0);
    }
  });

  it('writes no sheet for care the section does not reach', async () => {
    const [row] = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM assignment_log a
         JOIN cases c ON c.id = a.case_id
        WHERE c.care NOT IN ('skilled_nursing','post_surgical','hospice_support')`);
    expect(Number(row!.n)).toBe(0);
  });

  it('fills every statutory field from the household record, not from a default', async () => {
    const rows = await db.query<Record<string, unknown>>(
      `SELECT patient_name, patient_address, attending_physician, order_received_at,
              service_from, fee_basis, provider_id
         FROM assignment_log WHERE corrects_id IS NULL`);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        expect(value, `${key} is empty on a log sheet`).toBeTruthy();
      }
      expect(String(row.fee_basis)).toMatch(/% of job cost/);
    }
  });
});

describe('the commit check — a referral cannot exist without its sheet', () => {
  async function disclosureOn(caseId: string): Promise<string> {
    const row = await one<{ id: string }>(
      `SELECT id FROM disclosures WHERE case_id = $1 LIMIT 1`, [caseId]);
    return row.id;
  }

  async function skilledCase(): Promise<{ id: string; provider: string }> {
    const row = await one<{ id: string; provider_id: string }>(
      `SELECT c.id, r.provider_id FROM cases c JOIN referrals r ON r.case_id = c.id
        WHERE c.care IN ('skilled_nursing','post_surgical','hospice_support') LIMIT 1`);
    return { id: row.id, provider: row.provider_id };
  }

  it('refuses a nursing referral with no entry, at COMMIT', async () => {
    const kase = await skilledCase();
    const disclosureId = await disclosureOn(kase.id);
    const message = await expectRejection(
      () => db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO referrals (case_id, provider_id, disclosure_id, referred_by)
           VALUES ($1, $2, $3, 'operator')`,
          [kase.id, kase.provider, disclosureId]);
      }),
      /1812\.529/);
    expect(message).toMatch(/assignment log/i);
  });

  it('accepts the same referral when the entry goes in with it', async () => {
    const kase = await skilledCase();
    const disclosureId = await disclosureOn(kase.id);
    const referralId = await insertReferral(db,
      { caseId: kase.id, providerId: kase.provider, disclosureId });
    const row = await one<{ n: string }>(
      `SELECT count(*) AS n FROM assignment_log WHERE referral_id = $1`, [referralId]);
    expect(Number(row.n)).toBe(1);
  });

  it('leaves a companion or personal care referral alone', async () => {
    const kase = await one<{ id: string; provider_id: string }>(
      `SELECT c.id, r.provider_id FROM cases c JOIN referrals r ON r.case_id = c.id
        WHERE c.care NOT IN ('skilled_nursing','post_surgical','hospice_support') LIMIT 1`);
    const disclosureId = await disclosureOn(kase.id);
    const inserted = await db.transaction(async (tx) => {
      const [row] = await tx.query<{ id: string }>(
        `INSERT INTO referrals (case_id, provider_id, disclosure_id, referred_by)
         VALUES ($1, $2, $3, 'operator') RETURNING id`,
        [kase.id, kase.provider_id, disclosureId]);
      return row!.id;
    });
    const row = await one<{ n: string }>(
      `SELECT count(*) AS n FROM assignment_log WHERE referral_id = $1`, [inserted]);
    expect(Number(row.n)).toBe(0);
  });

  it('offers the care list as a SQL array that Postgres accepts', async () => {
    const rows = await db.query<{ care: string }>(
      `SELECT c.care::text AS care FROM cases c WHERE c.care = ANY(${SKILLED_SQL_ARRAY})`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(SKILLED).toContain(r.care);
    for (const care of SKILLED) expect(SKILLED_SQL_ARRAY).toContain(`'${care}'`);
  });

  it('uses the same three care types the physician trigger and SKILLED use', () => {
    const sql = readFileSync(
      join(MIGRATIONS, '0023_a_referral_without_a_log_sheet_is_not_a_referral.sql'), 'utf8');
    const listed = [...sql.matchAll(/'(skilled_nursing|post_surgical|hospice_support)'/g)]
      .map((m) => m[1]!);
    expect([...new Set(listed)].sort()).toEqual([...SKILLED].sort());

    // And nothing else: a fourth care type added to the trigger and not to SKILLED would
    // mean referrals the database demands a sheet for and `assignmentMissing` waves past.
    const careList = sql.match(/c\.care IN \(([^)]*)\)/s)?.[1] ?? '';
    const inTrigger = [...careList.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(inTrigger.sort()).toEqual([...SKILLED].sort());
  });
});

describe('the alignment check — a sheet must describe the referral it points at', () => {
  let referralId = '';
  let caseId = '';
  let providerId = '';
  let otherCaseId = '';
  let otherProviderId = '';

  beforeAll(async () => {
    const row = await one<{ id: string; case_id: string; provider_id: string }>(
      `SELECT r.id, r.case_id, r.provider_id FROM referrals r
         JOIN cases c ON c.id = r.case_id
        WHERE c.care IN ('skilled_nursing','post_surgical','hospice_support') LIMIT 1`);
    referralId = row.id; caseId = row.case_id; providerId = row.provider_id;
    otherCaseId = (await one<{ id: string }>(
      `SELECT id FROM cases WHERE id <> $1 LIMIT 1`, [caseId])).id;
    otherProviderId = (await one<{ id: string }>(
      `SELECT id FROM providers WHERE id <> $1 LIMIT 1`, [providerId])).id;
  });

  const sheet = (caseArg: string, providerArg: string, to: string | null) => () => db.query(
    `INSERT INTO assignment_log
       (case_id, referral_id, provider_id, order_received_at, patient_name,
        patient_address, attending_physician, service_from, service_to, fee_basis,
        recorded_by, corrects_id, correction_note)
     VALUES ($1, $2, $3, now(), 'A Patient', '1 Somewhere, CA', 'Dr. Someone',
             now(), $4, '18% of job cost', 'test',
             (SELECT id FROM assignment_log WHERE referral_id = $2 AND corrects_id IS NULL),
             'checking the alignment trigger')`,
    [caseArg, referralId, providerArg, to]);

  it('refuses a sheet naming another case', async () => {
    await expectRejection(sheet(otherCaseId, providerId, null), /names case .* but referral/);
  });

  it('refuses a sheet naming another provider', async () => {
    await expectRejection(sheet(caseId, otherProviderId, null),
      /names provider .* but referral/);
  });

  it('refuses service that ends before it begins', async () => {
    await expectRejection(sheet(caseId, providerId, '2000-01-01'),
      /service_to precedes service_from/);
  });

  it('accepts an aligned correction', async () => {
    const rows = await db.query<{ id: string }>(
      sheetSqlAligned(), [caseId, referralId, providerId]);
    expect(rows).toHaveLength(1);
  });

  function sheetSqlAligned(): string {
    return `INSERT INTO assignment_log
       (case_id, referral_id, provider_id, order_received_at, patient_name,
        patient_address, attending_physician, service_from, fee_basis,
        recorded_by, corrects_id, correction_note)
     VALUES ($1, $2, $3, now(), 'A Patient', '1 Somewhere, CA', 'Dr. Someone',
             now(), '18% of job cost', 'test',
             (SELECT id FROM assignment_log WHERE referral_id = $2 AND corrects_id IS NULL),
             'the address was wrong on the original')
     RETURNING id`;
  }
});

describe('the field list accounts for the whole table', () => {
  it('every statutory field names a real column', async () => {
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'assignment_log'`);
    const names = new Set(cols.map((c) => c.column_name));
    for (const key of Object.keys(ASSIGNMENT_FIELDS) as AssignmentField[]) {
      expect(names, `ASSIGNMENT_FIELDS.${key} names no column`)
        .toContain(ASSIGNMENT_FIELDS[key].column);
    }
  });

  it('every NOT NULL column is a statutory field or an explained one', async () => {
    const cols = await db.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'assignment_log'`);
    const statutory = new Set(
      (Object.keys(ASSIGNMENT_FIELDS) as AssignmentField[])
        .map((k) => ASSIGNMENT_FIELDS[k].column as string));
    for (const col of cols.filter((c) => c.is_nullable === 'NO')) {
      const known = statutory.has(col.column_name)
        || col.column_name in STRUCTURAL_COLUMNS;
      expect(known, `${col.column_name} is required by the table and explained nowhere`)
        .toBe(true);
    }
  });

  it('explains no column twice, and none that does not exist', async () => {
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'assignment_log'`);
    const names = new Set(cols.map((c) => c.column_name));
    const statutory = new Set(
      (Object.keys(ASSIGNMENT_FIELDS) as AssignmentField[])
        .map((k) => ASSIGNMENT_FIELDS[k].column as string));
    for (const [col, reason] of Object.entries(STRUCTURAL_COLUMNS)) {
      expect(names, `${col} is explained and does not exist`).toContain(col);
      expect(statutory.has(col), `${col} is both statutory and structural`).toBe(false);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('blocks only on fields the table actually requires', async () => {
    const cols = await db.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'assignment_log'`);
    const nullable = new Map(cols.map((c) => [c.column_name, c.is_nullable === 'YES']));
    for (const field of BLOCKING_ASSIGNMENT_FIELDS) {
      const column = ASSIGNMENT_FIELDS[field].column;
      expect(nullable.get(column), `${column} blocks a referral but the table permits null`)
        .toBe(false);
    }
  });

  it('gives every blocking field something the operator can do about it', () => {
    for (const field of BLOCKING_ASSIGNMENT_FIELDS) {
      const def: AssignmentFieldDef = ASSIGNMENT_FIELDS[field];
      expect(def.fix?.length ?? 0,
        `${field} blocks a referral and says nothing about how to clear it`)
        .toBeGreaterThan(10);
    }
  });
});

describe('what counts as missing', () => {
  const complete = {
    care: 'skilled_nursing',
    patientName: 'Howard Abernathy',
    patientAddress: '100 Oak Knoll Ave, Brentwood, CA',
    attendingPhysician: 'Dr. Lillian Okafor',
    startsOn: '2026-12-01',
    feePct: 18,
  };

  it('finds nothing missing on a complete nursing record', () => {
    expect(assignmentMissing(complete)).toEqual([]);
  });

  /*
   * And on a record as the DATABASE hands it over, which is not the same test. The first
   * version of AssignmentFacts declared `startsOn: string`, and a `date` column arrives
   * from the driver as a Date — so the check reported every start date in the database
   * as absent and refused every nursing referral. A fixture of string literals passed
   * throughout. This is the assertion that would have caught it.
   */
  it('finds nothing missing on a seeded case read straight out of the table', async () => {
    const rows = await db.query<{
      care: string; cr_name: string | null; cr_address: string | null;
      physician_name: string | null; starts_on: string | null; fee_pct: string | null;
    }>(
      `SELECT c.care::text AS care, h.cr_name, h.cr_address, h.physician_name,
              c.starts_on, c.fee_pct
         FROM cases c JOIN households h ON h.id = c.household_id
        WHERE EXISTS (SELECT 1 FROM referrals r WHERE r.case_id = c.id)
          AND c.care IN ('skilled_nursing','post_surgical','hospice_support')`);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(assignmentMissing({
        care: row.care,
        patientName: row.cr_name,
        patientAddress: row.cr_address,
        attendingPhysician: row.physician_name,
        startsOn: row.starts_on,
        feePct: row.fee_pct,
      }), `a referred nursing case reads as missing fields: ${row.cr_name}`).toEqual([]);
    }
  });

  it('reads a start date whatever shape the driver hands it in', () => {
    expect(assignmentMissing({ ...complete, startsOn: new Date('2026-12-01T00:00:00Z') }))
      .toEqual([]);
    expect(assignmentMissing({ ...complete, startsOn: '2026-12-01T00:00:00.000Z' }))
      .toEqual([]);
  });

  it('asks for nothing at all outside Chapter 7', () => {
    expect(assignmentMissing({
      care: 'companion', patientName: null, patientAddress: null,
      attendingPhysician: null, startsOn: null, feePct: null,
    })).toEqual([]);
  });

  it('names each absent field', () => {
    expect(assignmentMissing({ ...complete, patientAddress: '   ' }))
      .toEqual(['patient_address']);
    expect(assignmentMissing({ ...complete, patientName: null }))
      .toEqual(['patient_name']);
    expect(assignmentMissing({ ...complete, attendingPhysician: '' }))
      .toEqual(['attending_physician']);
    expect(assignmentMissing({ ...complete, startsOn: null }))
      .toEqual(['service_from']);
    expect(assignmentMissing({ ...complete, feePct: null }))
      .toEqual(['fee_basis']);
  });

  it('names all of them at once, in the order the log sheet reads', () => {
    expect(assignmentMissing({
      care: 'post_surgical', patientName: null, patientAddress: null,
      attendingPhysician: null, startsOn: null, feePct: null,
    })).toEqual([...BLOCKING_ASSIGNMENT_FIELDS]);
  });

  it('says why, citing the section', () => {
    const reason = assignmentBlockedReason(['patient_address', 'fee_basis']);
    expect(reason).toContain('1812.529');
    expect(reason).toContain('the address of the patient');
    expect(reason).toContain('the fee charged');
    expect(assignmentBlockedReason([])).toBe('');
  });
});

describe('the fee basis is what was charged, never what could have been', () => {
  it('words the percentage with who pays it', () => {
    expect(feeBasisOf(18)).toBe('18% of job cost, billed to the household');
    expect(feeBasisOf('20.00')).toBe('20% of job cost, billed to the household');
    expect(feeBasisOf(17.5)).toBe('17.5% of job cost, billed to the household');
  });

  it('is null where nothing was agreed, with no schedule fallback', () => {
    expect(feeBasisOf(null)).toBeNull();
    expect(feeBasisOf(undefined)).toBeNull();
    expect(feeBasisOf('')).toBeNull();
    expect(feeBasisOf(0)).toBeNull();
    expect(feeBasisOf('not a number')).toBeNull();
  });
});

describe('the hour the order arrived', () => {
  it('is the enquiry that produced the case, where there is one', async () => {
    const kase = await one<{ id: string; household_id: string; created_at: string;
      provider_id: string }>(
      `SELECT c.id, c.household_id, c.created_at, r.provider_id
         FROM cases c JOIN referrals r ON r.case_id = c.id
        WHERE c.care IN ('skilled_nursing','post_surgical','hospice_support') LIMIT 1`);
    const disclosureId = (await one<{ id: string }>(
      `SELECT id FROM disclosures WHERE case_id = $1 LIMIT 1`, [kase.id])).id;

    // Two enquiries from this household: one before the case was opened, one after. The
    // order that produced this case is the earlier one; the later is a second order and
    // must not rewrite the hour on this sheet.
    const before = new Date(Date.parse(kase.created_at) - 3_600_000).toISOString();
    const after = new Date(Date.parse(kase.created_at) + 86_400_000).toISOString();
    for (const at of [before, after]) {
      await db.query(
        `INSERT INTO inquiries (received_at, name, household_id) VALUES ($1, 'Caller', $2)`,
        [at, kase.household_id]);
    }

    const referralId = await db.transaction(async (tx) => {
      const [ref] = await tx.query<{ id: string }>(
        `INSERT INTO referrals (case_id, provider_id, disclosure_id, referred_by)
         VALUES ($1, $2, $3, 'operator') RETURNING id`,
        [kase.id, kase.provider_id, disclosureId]);
      await tx.query(ASSIGNMENT_LOG_INSERT, [ref!.id, '18% of job cost', 'test', null]);
      return ref!.id;
    });

    const row = await one<{ order_received_at: string }>(
      `SELECT order_received_at FROM assignment_log WHERE referral_id = $1`, [referralId]);
    expect(Date.parse(row.order_received_at)).toBe(Date.parse(before));
  });
});

describe('a correction supersedes and never edits', () => {
  it('leaves the original readable and points at it', async () => {
    const original = await one<{ id: string; patient_address: string; referral_id: string }>(
      `SELECT id, patient_address, referral_id FROM assignment_log
        WHERE corrects_id IS NULL LIMIT 1`);
    const [corrected] = await db.query<{ id: string }>(ASSIGNMENT_LOG_CORRECTION, [
      original.id, 'Howard Abernathy', '101 Oak Knoll Ave, Brentwood, CA',
      'Dr. Lillian Okafor', '2026-11-01', null, '18% of job cost', 'test',
      'The house number was transposed on the original entry.',
    ]);
    expect(corrected).toBeTruthy();

    const still = await one<{ patient_address: string }>(
      `SELECT patient_address FROM assignment_log WHERE id = $1`, [original.id]);
    expect(still.patient_address).toBe(original.patient_address);

    const row = await one<{ corrects_id: string; correction_note: string;
      order_received_at: string }>(
      `SELECT corrects_id, correction_note, order_received_at
         FROM assignment_log WHERE id = $1`, [corrected!.id]);
    expect(row.corrects_id).toBe(original.id);
    expect(row.correction_note).toMatch(/transposed/);
  });

  it('copies the hour the order arrived rather than restating it', async () => {
    const original = await one<{ id: string; order_received_at: string }>(
      `SELECT id, order_received_at FROM assignment_log
        WHERE corrects_id IS NULL ORDER BY created_at LIMIT 1`);
    const [corrected] = await db.query<{ id: string }>(ASSIGNMENT_LOG_CORRECTION, [
      original.id, 'A Patient', '1 Somewhere, CA', 'Dr. Someone',
      '2026-11-01', null, '18% of job cost', 'test', 'The physician had changed.',
    ]);
    const row = await one<{ order_received_at: string }>(
      `SELECT order_received_at FROM assignment_log WHERE id = $1`, [corrected!.id]);
    expect(Date.parse(row.order_received_at)).toBe(Date.parse(original.order_received_at));
  });
});

describe('the register is an audited entity', () => {
  it('the audit vocabulary admits it', async () => {
    const rows = await db.query(
      `INSERT INTO audit_log (actor, action, entity) VALUES ('test','read','assignment')
       RETURNING id`);
    expect(rows).toHaveLength(1);
  });

  it('every migration that widens the vocabulary leaves it NOT VALID', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
    const widening = files.filter((f) =>
      readFileSync(join(MIGRATIONS, f), 'utf8').includes('audit_log_entity_vocabulary'));
    expect(widening.length).toBeGreaterThan(1);
    for (const f of widening) {
      const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
      expect(sql, `${f} adds the vocabulary constraint without NOT VALID`)
        .toMatch(/audit_log_entity_vocabulary CHECK[\s\S]*?NOT VALID/);
    }
  });
});
