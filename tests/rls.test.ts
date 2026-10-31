/**
 * The § 4 role matrix, and the § 10 acceptance tests that depend on it.
 *
 * These only mean anything because migration 0003 FORCEs row-level security. Postgres
 * exempts a table's owner from its own policies, and on a managed Postgres the role you
 * are handed usually owns everything — so without FORCE the whole matrix would be
 * present, inert, and every assertion below would pass for the wrong reason.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '../src/db/client';
import { asClaims, expectDenied, seededDb } from '../src/testing/db';

let db: DbHandle;
let householdId: string;
let otherHouseholdId: string;
let caseId: string;
let providerId: string;
let userId: string;
let shortlistId: string;
let disclosureId: string;
let timelineId: string;

/** First row, or a clear failure. `noUncheckedIndexedAccess` makes [0] possibly undefined. */
async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await db.query<T>(sql, params);
  if (!row) throw new Error(`fixture query returned no rows: ${sql}`);
  return row;
}

beforeAll(async () => {
  db = await seededDb();

  const kase = await one<{ id: string; household_id: string }>(
    `SELECT id, household_id FROM cases WHERE status = 'active' ORDER BY created_at LIMIT 1`);
  caseId = kase.id;
  householdId = kase.household_id;

  otherHouseholdId = (await one<{ id: string }>(
    `SELECT id FROM households WHERE id <> $1 LIMIT 1`, [householdId])).id;
  providerId = (await one<{ id: string }>(
    `SELECT id FROM providers WHERE full_name = 'Imelda Santoyo'`)).id;
  disclosureId = (await one<{ id: string }>(`SELECT id FROM disclosures LIMIT 1`)).id;
  timelineId = (await one<{ id: string }>(`SELECT id FROM timeline_entries LIMIT 1`)).id;

  userId = (await one<{ id: string }>(
    `INSERT INTO users (email, display_name, role)
     VALUES ('member@example.com', 'Household member', 'household') RETURNING id`)).id;
  await db.query(
    `INSERT INTO household_users (user_id, household_id) VALUES ($1, $2)`,
    [userId, householdId]);

  shortlistId = (await one<{ id: string }>(
    `INSERT INTO published_shortlists (case_id, published_by) VALUES ($1, 'operator')
     RETURNING id`, [caseId])).id;
  await db.query(
    `INSERT INTO published_shortlist_items (shortlist_id, provider_id, position)
     VALUES ($1, $2, 1)`, [shortlistId, providerId]);
});

const household = () => ({ ccn_role: 'household', ccn_household_id: householdId, ccn_user_id: userId });
const provider = () => ({ ccn_role: 'provider', ccn_provider_id: providerId });

describe('§ 10 — a household request is not a referral', () => {
  it('household role: INSERT INTO referrals is denied', async () => {
    await expectDenied(() => asClaims(db, household(), (tx) =>
      tx.query(
        `INSERT INTO referrals (case_id, provider_id, disclosure_id, referred_by)
         VALUES ($1, $2, $3, 'household')`,
        [caseId, providerId, disclosureId],
      )));
  });

  it('household role: INSERT INTO disclosures is denied', async () => {
    await expectDenied(() => asClaims(db, household(), (tx) =>
      // Explicit VALUES, not INSERT..SELECT: a select the policy filters to nothing
      // would insert nothing and succeed, passing this test for the wrong reason.
      tx.query(
        `INSERT INTO disclosures (case_id, timeline_id, disclosed_to, disclosed_by, method, written_due_on)
         VALUES ($1, $2, 'me', 'me', 'phone', current_date)`,
        [caseId, timelineId],
      )));
  });

  it('household role: may record a request against its own bench', async () => {
    const rows = await asClaims(db, household(), (tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO shortlist_requests (shortlist_id, provider_id, requested_by)
         VALUES ($1, $2, $3) RETURNING id`,
        [shortlistId, providerId, userId],
      ));
    expect(rows).toHaveLength(1);
  });

  it('and that request creates no referral', async () => {
    const before = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM referrals`);
    await asClaims(db, household(), (tx) =>
      tx.query(
        `INSERT INTO shortlist_requests (shortlist_id, provider_id, requested_by)
         VALUES ($1, $2, $3)`, [shortlistId, providerId, userId]));
    const after = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM referrals`);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('household role: cannot forge a request that claims to be referred', async () => {
    await expectDenied(() => asClaims(db, household(), (tx) =>
      tx.query(
        `INSERT INTO shortlist_requests (shortlist_id, provider_id, requested_by, status)
         VALUES ($1, $2, $3, 'referred')`, [shortlistId, providerId, userId])));
  });
});

describe('§ 10 — a household sees only its own case', () => {
  it('SELECT from another case\'s shortlist returns zero rows', async () => {
    const rows = await asClaims(
      db, { ccn_role: 'household', ccn_household_id: otherHouseholdId, ccn_user_id: userId },
      (tx) => tx.query(`SELECT id FROM published_shortlists WHERE id = $1`, [shortlistId]),
    );
    expect(rows).toEqual([]);
  });

  it('sees its own shortlist', async () => {
    const rows = await asClaims(db, household(), (tx) =>
      tx.query(`SELECT id FROM published_shortlists WHERE id = $1`, [shortlistId]));
    expect(rows).toHaveLength(1);
  });

  it('sees only providers on its own bench, not the whole roster', async () => {
    const rows = await asClaims(db, household(), (tx) =>
      tx.query<{ id: string }>(`SELECT id FROM providers`));
    expect(rows.map((r) => r.id)).toEqual([providerId]);
  });

  it('a withdrawn shortlist disappears', async () => {
    await db.query(`UPDATE published_shortlists SET withdrawn_at = now() WHERE id = $1`, [shortlistId]);
    const rows = await asClaims(db, household(), (tx) =>
      tx.query(`SELECT id FROM published_shortlists WHERE id = $1`, [shortlistId]));
    expect(rows).toEqual([]);
    await db.query(`UPDATE published_shortlists SET withdrawn_at = NULL WHERE id = $1`, [shortlistId]);
  });
});

describe('§ 10 — a provider uploads, the operator verifies', () => {
  it('provider role: INSERT INTO credentials for themselves succeeds', async () => {
    const rows = await asClaims(db, provider(), (tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO credentials (provider_id, type, verified_on, verified_by, verification_source)
         VALUES ($1, 'immunization', current_date, 'provider', 'uploaded document')
         RETURNING id`, [providerId]));
    expect(rows).toHaveLength(1);
  });

  it('provider role: UPDATE credentials SET expires_on changes nothing', async () => {
    // There is no UPDATE policy for a provider, and an UPDATE that matches no row is
    // not an error — it reports zero rows. So the assertion is that the expiry is
    // untouched, not that the statement threw.
    const before = await db.query<{ id: string; expires_on: string | null }>(
      `SELECT id, expires_on::text FROM credentials WHERE provider_id = $1 ORDER BY type`,
      [providerId]);

    await asClaims(db, provider(), (tx) =>
      tx.query(`UPDATE credentials SET expires_on = current_date + 3650 WHERE provider_id = $1`,
        [providerId]));

    const after = await db.query<{ id: string; expires_on: string | null }>(
      `SELECT id, expires_on::text FROM credentials WHERE provider_id = $1 ORDER BY type`,
      [providerId]);
    expect(after).toEqual(before);
  });

  it('provider role: cannot insert a credential for somebody else', async () => {
    const other = await one<{ id: string }>(
      `SELECT id FROM providers WHERE id <> $1 LIMIT 1`, [providerId]);
    await expectDenied(() => asClaims(db, provider(), (tx) =>
      tx.query(
        `INSERT INTO credentials (provider_id, type, verified_on, verified_by, verification_source)
         VALUES ($1, 'other', current_date, 'provider', 'x')`, [other.id])));
  });
});

describe('§ 6.4 — the column rules row-level security cannot express', () => {
  it('a provider may state their own rate and availability', async () => {
    await asClaims(db, provider(), (tx) =>
      tx.query(
        `UPDATE providers SET rate_hourly = 80, availability = ARRAY['Mon:AM'] WHERE id = $1`,
        [providerId]));
    const [row] = await db.query<{ rate_hourly: string }>(
      `SELECT rate_hourly FROM providers WHERE id = $1`, [providerId]);
    expect(Number(row!.rate_hourly)).toBe(80);
  });

  it('a provider cannot change their own referral status — that is the registry\'s lever', async () => {
    await expectDenied(() => asClaims(db, provider(), (tx) =>
      // A value that differs from the current one: the guard compares old against new,
      // so setting a field to what it already holds is correctly a no-op.
      tx.query(`UPDATE providers SET status = 'do_not_refer' WHERE id = $1`, [providerId])));
  });

  it('a provider cannot widen their own service area', async () => {
    await expectDenied(() => asClaims(db, provider(), (tx) =>
      tx.query(`UPDATE providers SET areas = ARRAY['Everywhere'] WHERE id = $1`, [providerId])));
  });

  it('a household may edit the profile that travels to a substitute', async () => {
    await asClaims(db, household(), (tx) =>
      tx.query(`UPDATE cases SET household_profile = 'Side door, not the front.' WHERE id = $1`,
        [caseId]));
    const [row] = await db.query<{ household_profile: string }>(
      `SELECT household_profile FROM cases WHERE id = $1`, [caseId]);
    expect(row!.household_profile).toBe('Side door, not the front.');
  });

  it('a household cannot rewrite the terms, or the needs profile it stated at intake', async () => {
    await expectDenied(() => asClaims(db, household(), (tx) =>
      tx.query(`UPDATE cases SET fee_pct = 0 WHERE id = $1`, [caseId])));
    await expectDenied(() => asClaims(db, household(), (tx) =>
      tx.query(`UPDATE cases SET needs_profile = 'rewritten' WHERE id = $1`, [caseId])));
  });
});

describe('the default is nothing', () => {
  it('a connection carrying no claim sees no rows at all', async () => {
    for (const table of ['providers', 'households', 'cases', 'referrals', 'audit_log']) {
      const rows = await asClaims(db, null, (tx) => tx.query(`SELECT 1 FROM ${table} LIMIT 1`));
      expect(rows, `${table} leaked to an unidentified connection`).toEqual([]);
    }
  });

  it('a partner may hand us a referral and read nothing back', async () => {
    // No RETURNING: that reads the row back, which needs a SELECT policy a partner
    // does not have and should not have. The public intake code does not use it either.
    await asClaims(db, { ccn_role: 'partner' }, (tx) =>
      tx.query(`INSERT INTO inquiries (name, phone) VALUES ('Partner referral', '555')`));
    const count = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM inquiries WHERE name = 'Partner referral'`);
    expect(Number(count.n)).toBe(1);

    const read = await asClaims(db, { ccn_role: 'partner' }, (tx) =>
      tx.query(`SELECT id FROM inquiries`));
    expect(read).toEqual([]);
  });
});
