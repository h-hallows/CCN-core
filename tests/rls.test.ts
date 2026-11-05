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

  it('sees only providers it is engaged with, not the whole roster', async () => {
    const rows = await asClaims(db, household(), (tx) =>
      tx.query<{ id: string }>(`SELECT id FROM providers`));
    const visible = rows.map((r) => r.id);

    expect(visible, 'the provider on this bench should be visible').toContain(providerId);

    const all = await one<{ n: string }>(`SELECT count(*)::text AS n FROM providers`);
    expect(visible.length).toBeLessThan(Number(all.n));

    // Was `toEqual([providerId])`, an exact list that migration 0007 widened: a
    // household can now also see a provider referred to one of its cases, named on one
    // as primary or alternate, covering a gap, or asked about on a bench since
    // withdrawn. The seed's own case has a primary and two alternates, so the exact
    // list was always going to be brittle.
    //
    // The replacement asserts the thing that actually matters, and more strictly than
    // a count would: every provider visible to this household has a real relationship
    // with it. Written as its own query rather than by calling the policy's helper, so
    // a predicate that forgot to scope by household would still fail here.
    const related = await db.query<{ id: string }>(
      `SELECT p.id FROM providers p
        WHERE EXISTS (SELECT 1 FROM published_shortlist_items i
                        JOIN published_shortlists s ON s.id = i.shortlist_id
                        JOIN cases c ON c.id = s.case_id
                       WHERE i.provider_id = p.id AND c.household_id = $1)
           OR EXISTS (SELECT 1 FROM referrals r JOIN cases c ON c.id = r.case_id
                       WHERE r.provider_id = p.id AND c.household_id = $1)
           OR EXISTS (SELECT 1 FROM cases c
                       WHERE c.household_id = $1
                         AND (c.primary_provider_id = p.id
                              OR p.id = ANY(c.alternate_provider_ids)))
           OR EXISTS (SELECT 1 FROM coverage_gaps g JOIN cases c ON c.id = g.case_id
                       WHERE g.resolved_provider_id = p.id AND c.household_id = $1)
           OR EXISTS (SELECT 1 FROM shortlist_requests sr
                        JOIN published_shortlists s ON s.id = sr.shortlist_id
                        JOIN cases c ON c.id = s.case_id
                       WHERE sr.provider_id = p.id AND c.household_id = $1)`,
      [householdId]);
    const allowed = new Set(related.map((r) => r.id));
    for (const id of visible) {
      expect(allowed.has(id), `provider ${id} is visible with no relationship`).toBe(true);
    }
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

/**
 * Migration 0006 — the two reads the client portal needs. Web build spec § 4.1, W7.
 *
 * Both tables were operator-only. The policies added here are SELECT and nothing else:
 * a household may see the gaps in its own cover and read back the feedback it wrote,
 * and may still not write either, nor see anybody else's.
 */
describe('W7 — what the client portal may read', () => {
  let gapId: string;
  let ownReferralId: string;
  let otherReferralId: string;
  let feedbackId: string;

  beforeAll(async () => {
    gapId = (await one<{ id: string }>(
      `INSERT INTO coverage_gaps (case_id, on_date, block, note)
       VALUES ($1, current_date + 3, 'AM', 'arranging cover') RETURNING id`,
      [caseId])).id;

    // A referral on this household's case, and one on somebody else's.
    ownReferralId = (await one<{ id: string }>(
      `INSERT INTO referrals (case_id, provider_id, disclosure_id, referred_by)
       VALUES ($1, $2, $3, 'operator') RETURNING id`,
      [caseId, providerId, disclosureId])).id;

    const otherCase = await one<{ id: string }>(
      `SELECT id FROM cases WHERE household_id = $1 LIMIT 1`, [otherHouseholdId]);
    otherReferralId = (await one<{ id: string }>(
      `INSERT INTO referrals (case_id, provider_id, disclosure_id, referred_by)
       VALUES ($1, $2, $3, 'operator') RETURNING id`,
      [otherCase.id, providerId, disclosureId])).id;

    feedbackId = (await one<{ id: string }>(
      `INSERT INTO referral_feedback (referral_id, referral_service_rating, would_refer_again, notes)
       VALUES ($1, 4, true, 'The call before the introduction was the useful part.')
       RETURNING id`, [ownReferralId])).id;

    await db.query(
      `INSERT INTO referral_feedback (referral_id, referral_service_rating, notes)
       VALUES ($1, 2, 'Not ours to read.')`, [otherReferralId]);
  });

  it('a household sees a gap in the cover on its own case', async () => {
    const rows = await asClaims(db, household(), (tx) =>
      tx.query<{ id: string }>(`SELECT id FROM coverage_gaps WHERE id = $1`, [gapId]));
    expect(rows).toHaveLength(1);
  });

  it('a household sees no gap on anybody else\'s case', async () => {
    const rows = await asClaims(
      db, { ccn_role: 'household', ccn_household_id: otherHouseholdId, ccn_user_id: userId },
      (tx) => tx.query(`SELECT id FROM coverage_gaps WHERE id = $1`, [gapId]));
    expect(rows).toEqual([]);
  });

  it('a household still cannot create or resolve a gap itself', async () => {
    await expectDenied(() => asClaims(db, household(), (tx) =>
      tx.query(
        `INSERT INTO coverage_gaps (case_id, on_date, block) VALUES ($1, current_date, 'PM')`,
        [caseId])));
    await asClaims(db, household(), async (tx) => {
      // An UPDATE with no policy matches no rows rather than raising.
      const rows = await tx.query(
        `UPDATE coverage_gaps SET resolved_at = now() WHERE id = $1 RETURNING id`, [gapId]);
      expect(rows).toEqual([]);
    });
  });

  it('a household reads back the feedback it wrote', async () => {
    const rows = await asClaims(db, household(), (tx) =>
      tx.query<{ id: string; use_restriction: string }>(
        `SELECT id, use_restriction FROM referral_feedback WHERE id = $1`, [feedbackId]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.use_restriction).toBe('referral_decisions_only');
  });

  it('a household cannot read feedback about another household\'s referral', async () => {
    const rows = await asClaims(db, household(), (tx) =>
      tx.query(`SELECT id FROM referral_feedback WHERE referral_id = $1`, [otherReferralId]));
    expect(rows).toEqual([]);
  });

  it('feedback cannot be revised afterwards, by anyone with a policy', async () => {
    // A statement that can be rewritten later is a weaker record of what was said. No
    // UPDATE policy exists for any role but the operator, and none for DELETE at all.
    await asClaims(db, household(), async (tx) => {
      const rows = await tx.query(
        `UPDATE referral_feedback SET notes = 'rewritten' WHERE id = $1 RETURNING id`,
        [feedbackId]);
      expect(rows).toEqual([]);
    });
  });

  it('I7 holds: the use restriction is still the only value the check allows', async () => {
    await expectDenied(() => db.query(
      `INSERT INTO referral_feedback (referral_id, use_restriction)
       VALUES ($1, 'performance_review')`, [ownReferralId]));
  });
});

/**
 * Migration 0007 — a household may see a provider it is actually engaged with.
 *
 * 0003 scoped provider visibility to a LIVE bench, which silently ends the moment the
 * operator withdraws the shortlist after making the referral. These assert the view
 * survives that, and that it still does not extend to a stranger.
 */
describe('W7 — a household can still name the person in its house', () => {
  let engagedId: string;
  let strangerId: string;
  let withdrawnListId: string;

  beforeAll(async () => {
    engagedId = (await one<{ id: string }>(
      `SELECT id FROM providers WHERE full_name = 'Grace Okonkwo'`)).id;
    strangerId = (await one<{ id: string }>(
      `SELECT p.id FROM providers p
        WHERE p.id NOT IN (SELECT provider_id FROM referrals)
          AND p.id NOT IN (SELECT provider_id FROM published_shortlist_items)
          AND p.id NOT IN (SELECT provider_id FROM shortlist_requests)
        LIMIT 1`)).id;

    // Referred to this household's case, then the bench taken down — the ordinary
    // sequence, and the one that used to make the provider invisible.
    await db.query(
      `INSERT INTO referrals (case_id, provider_id, disclosure_id, referred_by)
       VALUES ($1, $2, $3, 'operator')`,
      [caseId, engagedId, disclosureId]);

    withdrawnListId = (await one<{ id: string }>(
      `INSERT INTO published_shortlists (case_id, published_by, withdrawn_at)
       VALUES ($1, 'operator', now()) RETURNING id`, [caseId])).id;
    await db.query(
      `INSERT INTO published_shortlist_items (shortlist_id, provider_id, position)
       VALUES ($1, $2, 1)`, [withdrawnListId, engagedId]);
  });

  it('sees the referred provider even though the bench is withdrawn', async () => {
    const rows = await asClaims(db, household(), (tx) =>
      tx.query<{ full_name: string }>(
        `SELECT full_name FROM providers WHERE id = $1`, [engagedId]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.full_name).toBe('Grace Okonkwo');
  });

  it('cannot see the bench row itself, which is still withdrawn', async () => {
    // 0007 widened provider visibility and nothing else. The withdrawn shortlist stays
    // out of reach, so this is not a back door into a bench the operator took down.
    const rows = await asClaims(db, household(), (tx) =>
      tx.query(`SELECT id FROM published_shortlist_items WHERE shortlist_id = $1`,
        [withdrawnListId]));
    expect(rows).toEqual([]);
  });

  it('still cannot see a provider it has no relationship with', async () => {
    const rows = await asClaims(db, household(), (tx) =>
      tx.query(`SELECT id FROM providers WHERE id = $1`, [strangerId]));
    expect(rows).toEqual([]);
  });

  it('still cannot see any provider\'s credentials', async () => {
    const rows = await asClaims(db, household(), (tx) =>
      tx.query(`SELECT id FROM credentials WHERE provider_id = $1`, [engagedId]));
    expect(rows).toEqual([]);
  });

  it('still cannot write to a provider row', async () => {
    await asClaims(db, household(), async (tx) => {
      const rows = await tx.query(
        `UPDATE providers SET rate_hourly = 1 WHERE id = $1 RETURNING id`, [engagedId]);
      expect(rows).toEqual([]);
    });
  });

  it('another household sees neither of them', async () => {
    const rows = await asClaims(
      db, { ccn_role: 'household', ccn_household_id: otherHouseholdId, ccn_user_id: userId },
      (tx) => tx.query(`SELECT id FROM providers WHERE id = $1`, [engagedId]));
    expect(rows).toEqual([]);
  });
});
