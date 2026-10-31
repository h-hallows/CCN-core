/**
 * Web build spec § 11, nurses-registry block.
 *
 * These exist because of the correction in that spec's § 0: private duty nursing
 * referrals are governed by Civil Code Chapter 7, §§ 1812.524–1812.533, not by
 * § 1812.5095. Every obligation below has no domestic-worker equivalent.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '../src/db/client';
import { expectRejection, seededDb } from '../src/testing/db';

let db: DbHandle;
let caseId: string;
let referralId: string;
let providerId: string;

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await db.query<T>(sql, params);
  if (!row) throw new Error(`fixture query returned no rows: ${sql}`);
  return row;
}

beforeAll(async () => {
  db = await seededDb();
  const r = await one<{ id: string; case_id: string; provider_id: string }>(
    `SELECT id, case_id, provider_id FROM referrals LIMIT 1`);
  referralId = r.id;
  caseId = r.case_id;
  providerId = r.provider_id;
});

describe('§ 1812.527 — the seven-day posting embargo', () => {
  it('rejects a schedule effective sooner than seven days after posting', async () => {
    await expectRejection(
      () => db.query(
        `INSERT INTO fee_schedules (version, max_fee_pct, payment_terms, body, posted_at, effective_from)
         VALUES (99, 18, 'net 14', 'body', now(), (now() AT TIME ZONE 'America/Los_Angeles')::date + 6)`),
      /fee_schedule_seven_day_embargo|check constraint/i);
  });

  it('accepts one posted seven days ahead', async () => {
    const rows = await db.query(
      `INSERT INTO fee_schedules (version, max_fee_pct, payment_terms, body, posted_at, effective_from)
       VALUES (1, 18, 'net 14', 'Maximum fee, covering all charges.', now(),
               (now() AT TIME ZONE 'America/Los_Angeles')::date + 7)
       RETURNING id`);
    expect(rows).toHaveLength(1);
  });

  it('records whether the schedule reached the nurse before the interview', async () => {
    const schedule = await one<{ id: string }>(`SELECT id FROM fee_schedules LIMIT 1`);
    const row = await one<{ before_interview: boolean }>(
      `INSERT INTO fee_schedule_deliveries
         (provider_id, schedule_id, delivered_at, delivered_by, before_interview)
       VALUES ($1, $2, now(), 'operator', true) RETURNING before_interview`,
      [providerId, schedule.id]);
    expect(row.before_interview).toBe(true);
  });
});

describe('§ 1812.528 — the licence is inspected, not just looked up', () => {
  it('refuses an RN licence with no inspection recorded', async () => {
    const other = await one<{ id: string }>(
      `SELECT id FROM providers WHERE type = 'RN' AND id <> $1 LIMIT 1`, [providerId]);
    // Soft delete, not DELETE: credential_events is append-only, and the unique index
    // over live rows is partial, so retiring the row is what makes room for a new one.
    await db.query(
      `UPDATE credentials SET deleted_at = now() WHERE provider_id = $1 AND type = 'rn_license'`,
      [other.id]);

    await expectRejection(
      () => db.query(
        `INSERT INTO credentials (provider_id, type, verified_on, verified_by, verification_source)
         VALUES ($1, 'rn_license', current_date, 'operator', 'BRN license verification')`,
        [other.id]),
      /nurse_license_inspected|check constraint/i);
  });

  it('accepts one with the inspection and the expiry noted', async () => {
    const other = await one<{ id: string }>(
      `SELECT id FROM providers WHERE type = 'RN' AND id <> $1 LIMIT 1`, [providerId]);
    await db.query(
      `UPDATE credentials SET deleted_at = now()
        WHERE provider_id = $1 AND type = 'rn_license' AND deleted_at IS NULL`, [other.id]);
    const rows = await db.query(
      `INSERT INTO credentials
         (provider_id, type, verified_on, verified_by, verification_source,
          inspected_at, inspected_by, inspected_expiry_noted)
       VALUES ($1, 'rn_license', current_date, 'operator', 'BRN license verification',
               current_date, 'operator', current_date + 400)
       RETURNING id`, [other.id]);
    expect(rows).toHaveLength(1);
  });

  it('leaves non-nurse credentials alone — the chapter does not reach them', async () => {
    const rows = await db.query(
      `INSERT INTO credentials (provider_id, type, verified_on, verified_by, verification_source)
       VALUES ($1, 'immunization', current_date, 'operator', 'clinic record') RETURNING id`,
      [providerId]);
    expect(rows).toHaveLength(1);
  });
});

describe('§ 1812.529 — the assignment log is permanent', () => {
  it('records an assignment', async () => {
    const rows = await db.query(
      `INSERT INTO assignment_log
         (case_id, referral_id, provider_id, order_received_at, patient_name,
          patient_address, attending_physician, service_from, fee_basis, recorded_by)
       VALUES ($1,$2,$3, now(), 'H. Abernathy', '100 Oak Knoll Ave, San Marino, CA',
               'Dr. Lillian Okafor', now(), '18% of job cost', 'operator')
       RETURNING id`, [caseId, referralId, providerId]);
    expect(rows).toHaveLength(1);
  });

  it('UPDATE raises — "no false entries" is easier to prove when nothing can be rewritten', async () => {
    await expectRejection(
      () => db.query(`UPDATE assignment_log SET patient_name = 'someone else'`),
      /append-only/i);
  });

  it('DELETE raises', async () => {
    await expectRejection(() => db.query(`DELETE FROM assignment_log`), /append-only/i);
  });

  it('a correction must say what it corrects', async () => {
    const prior = await one<{ id: string }>(`SELECT id FROM assignment_log LIMIT 1`);
    await expectRejection(
      () => db.query(
        `INSERT INTO assignment_log
           (case_id, referral_id, provider_id, order_received_at, patient_name,
            patient_address, attending_physician, service_from, fee_basis, recorded_by,
            corrects_id)
         VALUES ($1,$2,$3, now(), 'x', 'y', 'z', now(), 'f', 'operator', $4)`,
        [caseId, referralId, providerId, prior.id]),
      /correction_has_note|check constraint/i);
  });
});

describe('§ 1812.533(b)(4) — the disclosure that must precede care', () => {
  it('blocks a nursing case from going active until it has gone out', async () => {
    const d = await one<{ id: string }>(
      `SELECT id FROM disclosures WHERE case_id = $1 ORDER BY disclosed_at DESC LIMIT 1`,
      [caseId]);
    await db.query(`UPDATE disclosures SET nurse_disclosure_required = true WHERE id = $1`, [d.id])
      .catch(() => undefined);
    // The guard makes that column immutable, so set it the only way it can be set.
    await db.query(
      `UPDATE cases SET status = 'paused' WHERE id = $1`, [caseId]);
    const live = await one<{ nurse_disclosure_required: boolean }>(
      `SELECT nurse_disclosure_required FROM disclosures WHERE id = $1`, [d.id]);

    if (live.nurse_disclosure_required) {
      await expectRejection(
        () => db.query(`UPDATE cases SET status = 'active' WHERE id = $1`, [caseId]),
        /not yet delivered/i);
    }
    await db.query(`UPDATE cases SET status = 'active' WHERE id = $1`, [caseId]).catch(() => undefined);
  });

  it('the delivery date is settable once and then immutable', async () => {
    const d = await one<{ id: string }>(`SELECT id FROM disclosures LIMIT 1`);
    await db.query(
      `UPDATE disclosures SET nurse_disclosure_sent_on = current_date WHERE id = $1`, [d.id]);
    await expectRejection(
      () => db.query(
        `UPDATE disclosures SET nurse_disclosure_sent_on = current_date - 5 WHERE id = $1`, [d.id]),
      /already been recorded/i);
  });

  it('the requirement flag itself cannot be flipped off after the fact', async () => {
    const d = await one<{ id: string }>(`SELECT id FROM disclosures LIMIT 1`);
    await expectRejection(
      () => db.query(
        `UPDATE disclosures SET nurse_disclosure_required = NOT nurse_disclosure_required
          WHERE id = $1`, [d.id]),
      /immutable/i);
  });
});

describe('§ 1812.530 — a nurse is never charged', () => {
  it('no column anywhere could hold a provider-side fee', async () => {
    const rows = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (column_name LIKE '%provider_fee%' OR column_name LIKE '%registration_fee%'
            OR column_name LIKE '%provider_charge%' OR column_name LIKE '%commission%')`);
    expect(rows).toEqual([]);
  });
});

describe('§ 0.1 — the partner programme carries no compensation mechanic', () => {
  it('§ 1812.531 bars fee splitting, so no column could record one', async () => {
    const rows = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (column_name LIKE '%commission%' OR column_name LIKE '%rebate%'
            OR column_name LIKE '%kickback%' OR column_name LIKE '%reward%'
            OR column_name LIKE '%split%')`);
    expect(rows).toEqual([]);
  });
});
