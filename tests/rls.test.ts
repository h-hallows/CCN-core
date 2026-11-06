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
import { asClaims, expectDenied, expectRejection, seededDb } from '../src/testing/db';

let db: DbHandle;
let householdId: string;
let otherHouseholdId: string;
let caseId: string;
let providerId: string;
let providerUserId: string;
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
  providerUserId = (await one<{ id: string }>(
    `INSERT INTO users (email, display_name, role)
     VALUES ('rls-provider@example.com', 'RLS provider', 'provider')
     ON CONFLICT (email) DO UPDATE SET role = 'provider' RETURNING id`)).id;
  await db.query(
    `INSERT INTO provider_users (user_id, provider_id) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`, [providerUserId, providerId]);
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
/*
 * A provider claim now has to name a user who is actually linked to that provider.
 * Migration 0014 cross-checks the claims against the membership tables, so a claim
 * asserting a provider id with no `provider_users` row resolves to NULL — which is
 * the point: the four claims used to be independent assertions nobody checked. The
 * applications have always built them from these rows, so this fixture is what
 * production looks like; it simply was not what the test looked like.
 */
const provider = () => ({
  ccn_role: 'provider', ccn_user_id: providerUserId, ccn_provider_id: providerId,
});

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
    // 0019 allows one OPEN request per provider per bench, so the one the previous
    // test made is answered first — which is also the real sequence: a family asks
    // again after the operator has closed the last one.
    await db.query(
      `UPDATE shortlist_requests SET status = 'withdrawn', resolved_at = now()
        WHERE shortlist_id = $1 AND provider_id = $2 AND status = 'pending'`,
      [shortlistId, providerId]);

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

  it('cannot ask twice about the same person while the first is unanswered', async () => {
    /*
     * 0019. `lib/request.ts` reads for an existing pending row and answers "you have
     * already asked us", which is check-then-write: nothing stops a second insert
     * between the read and the write, and a double-tap on a phone does it. The queue
     * then shows the same family asking about the same nurse twice, which reads as two
     * people wanting two different things.
     */
    await db.query(
      `UPDATE shortlist_requests SET status = 'withdrawn', resolved_at = now()
        WHERE shortlist_id = $1 AND provider_id = $2 AND status = 'pending'`,
      [shortlistId, providerId]);

    await asClaims(db, household(), (tx) => tx.query(
      `INSERT INTO shortlist_requests (shortlist_id, provider_id, requested_by)
       VALUES ($1, $2, $3)`, [shortlistId, providerId, userId]));

    await expectRejection(
      () => asClaims(db, household(), (tx) => tx.query(
        `INSERT INTO shortlist_requests (shortlist_id, provider_id, requested_by)
         VALUES ($1, $2, $3)`, [shortlistId, providerId, userId])),
      /shortlist_requests_one_open_per_provider|duplicate key/i,
    );
  });

  it('one case shows one live bench, whatever the application does', async () => {
    /*
     * 0019. `publishBench` withdraws the live bench and inserts the new one in a
     * transaction, but the UPDATE can only lock rows that exist — nothing stops a
     * concurrent INSERT. Two live benches render on the family's own screen as two
     * short lists with nothing to say which is current, and somebody asks about a
     * provider the operator deliberately took away.
     *
     * A case of its own, because withdrawing this file's shared fixture bench would
     * change what every test after this one sees.
     */
    const [kase] = await db.query<{ id: string }>(
      `SELECT c.id FROM cases c
        WHERE c.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM published_shortlists p WHERE p.case_id = c.id)
        ORDER BY c.id LIMIT 1`);
    expect(kase).toBeTruthy();

    await db.query(
      `INSERT INTO published_shortlists (case_id, published_by) VALUES ($1, 'operator')`,
      [kase!.id]);

    await expectRejection(
      () => db.query(
        `INSERT INTO published_shortlists (case_id, published_by) VALUES ($1, 'operator')`,
        [kase!.id]),
      /published_shortlists_one_live_per_case|duplicate key/i,
    );

    // Withdrawn benches are ordinary history and do not collide.
    await db.query(
      `UPDATE published_shortlists SET withdrawn_at = now() WHERE case_id = $1`,
      [kase!.id]);
    await db.query(
      `INSERT INTO published_shortlists (case_id, published_by) VALUES ($1, 'operator')`,
      [kase!.id]);
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
  it('provider role: INSERT INTO credentials is denied', async () => {
    /*
     * This test used to assert the opposite — that the insert SUCCEEDS — under a
     * describe block named "a provider uploads, the operator verifies". The intent was
     * right and the assertion inverted it, which is how migration 0003's
     * `credentials_provider_insert` policy survived review.
     *
     * It mattered because `eligibility()` counts the presence of a row of the required
     * type as that requirement being met. A provider could therefore insert their own
     * Live Scan and move onto a household's shortlist with no background check — I12
     * broken by the role it most exists to constrain. Migration 0008 drops the policy;
     * uploads go to `credential_submissions`, which nothing computes eligibility from.
     */
    await expectDenied(() => asClaims(db, provider(), (tx) =>
      tx.query(
        `INSERT INTO credentials (provider_id, type, verified_on, verified_by, verification_source)
         VALUES ($1, 'immunization', current_date, 'provider', 'uploaded document')`,
        [providerId])));
  });

  it('provider role: hands the same thing in as a submission instead', async () => {
    const rows = await asClaims(db, provider(), (tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO credential_submissions (provider_id, type, note)
         VALUES ($1, 'immunization', 'uploaded document') RETURNING id`, [providerId]));
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

  it('provider role: cannot submit on behalf of somebody else', async () => {
    const other = await one<{ id: string }>(
      `SELECT id FROM providers WHERE id <> $1 LIMIT 1`, [providerId]);
    await expectDenied(() => asClaims(db, provider(), (tx) =>
      tx.query(
        `INSERT INTO credential_submissions (provider_id, type) VALUES ($1, 'other')`,
        [other.id])));
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
    /*
     * A provider created here, rather than one picked out of the seed.
     *
     * This used to be an unordered `LIMIT 1` over providers absent from `referrals`,
     * `published_shortlist_items` and `shortlist_requests` — three of the five branches
     * of `provider_engaged_with_household`. It missed the other two, so whenever the
     * heap happened to hand back a provider named as one of this household's case
     * primaries or alternates, the "stranger" was legitimately visible and the suite
     * went red for the right reason about the wrong row.
     *
     * Mirroring all five branches here would make the fixture a copy of the policy it
     * is testing, and it would quietly stop being a stranger the next time the policy
     * gains a branch. A provider inserted now has no relationship to anything, and
     * cannot acquire one by someone editing a function.
     */
    strangerId = (await one<{ id: string }>(
      `INSERT INTO providers (full_name, type, status, transports, areas, availability,
                              specialties, languages)
       VALUES ('Stranger, No Relationship', 'CNA', 'active', false,
               ARRAY['Pasadena'], ARRAY['AM'], ARRAY[]::text[], ARRAY['English'])
       RETURNING id`)).id;

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

/**
 * Migration 0008 — a provider submits, the operator verifies. W8.
 *
 * The first test here is a regression test for a hole that was real. Migration 0003
 * granted providers INSERT on `credentials`, and `eligibility()` counts the presence of
 * a row of the required type as that requirement being met. Together those let a
 * provider insert their own Live Scan and move themselves onto a household's shortlist.
 * Nothing provider-facing had been built, so nothing had exploited it; W8 is the
 * milestone that would have.
 */
describe('W8 — a provider cannot verify themselves', () => {
  let providerUserId: string;
  let selfId: string;
  let otherProviderId: string;

  const self = () => ({
    ccn_role: 'provider', ccn_user_id: providerUserId, ccn_provider_id: selfId,
  });

  beforeAll(async () => {
    selfId = (await one<{ id: string }>(
      `SELECT id FROM providers WHERE full_name = 'Tomás Beltrán'`)).id;
    otherProviderId = (await one<{ id: string }>(
      `SELECT id FROM providers WHERE id <> $1 LIMIT 1`, [selfId])).id;

    providerUserId = (await one<{ id: string }>(
      `INSERT INTO users (email, display_name, role)
       VALUES ('w8-provider@example.com', 'W8 provider', 'provider')
       ON CONFLICT (email) DO UPDATE SET role = 'provider' RETURNING id`)).id;
    await db.query(
      `INSERT INTO provider_users (user_id, provider_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`, [providerUserId, selfId]);
  });

  it('cannot insert a credential at all, which is the whole point', async () => {
    await expectDenied(() => asClaims(db, self(), (tx) => tx.query(
      `INSERT INTO credentials
         (provider_id, type, verified_on, verified_by, verification_source, expires_on)
       VALUES ($1, 'live_scan', current_date, 'me', 'I checked it myself',
               current_date + 365)`,
      [selfId])));
  });

  it('cannot insert one even with the verification fields left out', async () => {
    await expectDenied(() => asClaims(db, self(), (tx) => tx.query(
      `INSERT INTO credentials (provider_id, type) VALUES ($1, 'live_scan')`,
      [selfId])));
  });

  it('cannot amend an expiry on a credential it already has', async () => {
    await asClaims(db, self(), async (tx) => {
      const rows = await tx.query(
        `UPDATE credentials SET expires_on = current_date + 3650
          WHERE provider_id = $1 RETURNING id`, [selfId]);
      expect(rows).toEqual([]);
    });
  });

  it('still sees its own credentials, so it knows what is missing', async () => {
    const rows = await asClaims(db, self(), (tx) =>
      tx.query(`SELECT id FROM credentials WHERE provider_id = $1`, [selfId]));
    expect(rows.length).toBeGreaterThan(0);
  });

  it('sees nobody else\'s', async () => {
    const rows = await asClaims(db, self(), (tx) =>
      tx.query(`SELECT id FROM credentials WHERE provider_id = $1`, [otherProviderId]));
    expect(rows).toEqual([]);
  });

  it('may hand in a submission, which is not a credential', async () => {
    const rows = await asClaims(db, self(), (tx) => tx.query<{ id: string; state: string }>(
      `INSERT INTO credential_submissions (provider_id, type, identifier, note)
       VALUES ($1, 'live_scan', 'ATI-12345', 'Done last week, receipt attached')
       RETURNING id, state::text AS state`, [selfId]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('submitted');
  });

  it('a submission does not make anyone eligible — nothing reads it as one', async () => {
    // The guarantee in database terms: handing something in adds no row to the table
    // eligibility() is computed from.
    const creds = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM credentials
        WHERE provider_id = $1 AND type = 'live_scan' AND deleted_at IS NULL`, [selfId]);
    expect(Number(creds.n)).toBe(0);
  });

  it('cannot hand in something that claims to have been reviewed', async () => {
    await expectDenied(() => asClaims(db, self(), (tx) => tx.query(
      `INSERT INTO credential_submissions
         (provider_id, type, state, reviewed_at, reviewed_by)
       VALUES ($1, 'tb_clearance', 'accepted', now(), 'me')`, [selfId])));
  });

  it('cannot submit on behalf of another provider', async () => {
    await expectDenied(() => asClaims(db, self(), (tx) => tx.query(
      `INSERT INTO credential_submissions (provider_id, type)
       VALUES ($1, 'tb_clearance')`, [otherProviderId])));
  });

  it('cannot review its own submission afterwards', async () => {
    await asClaims(db, self(), async (tx) => {
      const rows = await tx.query(
        `UPDATE credential_submissions SET state = 'accepted' WHERE provider_id = $1
         RETURNING id`, [selfId]);
      expect(rows).toEqual([]);
    });
  });

  it('sees its own submissions and nobody else\'s', async () => {
    await db.query(
      `INSERT INTO credential_submissions (provider_id, type) VALUES ($1, 'cpr_bls')`,
      [otherProviderId]);
    const rows = await asClaims(db, self(), (tx) =>
      tx.query<{ provider_id: string }>(`SELECT provider_id FROM credential_submissions`));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.provider_id).toBe(selfId);
  });
});

describe('W8 — the provider states their own bio', () => {
  it('a provider may write it, because the guard does not forbid it', async () => {
    await asClaims(db, provider(), (tx) => tx.query(
      `UPDATE providers SET bio = $2 WHERE id = $1`,
      [providerId, 'Twelve years on post-surgical recovery, mostly orthopaedic.']));
    const [row] = await db.query<{ bio: string }>(
      `SELECT bio FROM providers WHERE id = $1`, [providerId]);
    expect(row!.bio).toContain('post-surgical');
  });

  it('a provider still may not write the operator\'s notes about them', async () => {
    await expectDenied(() => asClaims(db, provider(), (tx) =>
      tx.query(`UPDATE providers SET notes = 'say something nice' WHERE id = $1`,
        [providerId])));
  });

  it('nobody else may write it', async () => {
    const other = await one<{ id: string }>(
      `SELECT id FROM providers WHERE id <> $1 LIMIT 1`, [providerId]);
    await asClaims(db, provider(), async (tx) => {
      const rows = await tx.query(
        `UPDATE providers SET bio = 'not mine' WHERE id = $1 RETURNING id`, [other.id]);
      expect(rows).toEqual([]);
    });
  });
});

describe('W9 — a provider learns the area and nothing else about the household', () => {
  let referredCaseId: string;
  let unrelatedCaseId: string;

  beforeAll(async () => {
    referredCaseId = (await one<{ case_id: string }>(
      `SELECT case_id FROM referrals WHERE provider_id = $1 LIMIT 1`, [providerId]))
      .case_id;
    unrelatedCaseId = (await one<{ id: string }>(
      `SELECT id FROM cases WHERE id NOT IN (SELECT case_id FROM referrals WHERE provider_id = $1)
        LIMIT 1`, [providerId])).id;
  });

  it('returns the area for a case they were referred to', async () => {
    const rows = await asClaims(db, provider(), (tx) =>
      tx.query<{ area: string | null }>(
        `SELECT case_area_for_provider($1) AS area`, [referredCaseId]));
    expect(rows[0]!.area).toBeTruthy();
  });

  it('returns nothing for a case they were not', async () => {
    const rows = await asClaims(db, provider(), (tx) =>
      tx.query<{ area: string | null }>(
        `SELECT case_area_for_provider($1) AS area`, [unrelatedCaseId]));
    expect(rows[0]!.area).toBeNull();
  });

  it('still cannot read the household row behind it', async () => {
    const rows = await asClaims(db, provider(), (tx) =>
      tx.query(`SELECT id FROM households`));
    expect(rows).toEqual([]);
  });

  it('gives a household nothing through it either', async () => {
    const rows = await asClaims(db, household(), (tx) =>
      tx.query<{ area: string | null }>(
        `SELECT case_area_for_provider($1) AS area`, [referredCaseId]));
    expect(rows[0]!.area).toBeNull();
  });
});

describe('W9 — a provider reads back what they wrote, and nothing else', () => {
  let noteId: string;
  let referredCase: string;

  beforeAll(async () => {
    referredCase = (await one<{ case_id: string }>(
      `SELECT case_id FROM referrals WHERE provider_id = $1 LIMIT 1`, [providerId]))
      .case_id;
    noteId = (await one<{ id: string }>(
      `INSERT INTO timeline_entries (case_id, type, author, body, provider_id)
       VALUES ($1, 'note', 'provider', 'Opportunity response: not taking this one.', $2)
       RETURNING id`, [referredCase, providerId])).id;
  });

  it('reads its own note', async () => {
    const rows = await asClaims(db, provider(), (tx) =>
      tx.query<{ id: string }>(`SELECT id FROM timeline_entries WHERE id = $1`, [noteId]));
    expect(rows).toHaveLength(1);
  });

  it('cannot read the operator\'s notes on the same case', async () => {
    const operatorNote = await one<{ id: string }>(
      `INSERT INTO timeline_entries (case_id, type, author, body)
       VALUES ($1, 'call', 'operator', 'Rang the daughter about the physician letter.')
       RETURNING id`, [referredCase]);
    const rows = await asClaims(db, provider(), (tx) =>
      tx.query(`SELECT id FROM timeline_entries WHERE id = $1`, [operatorNote.id]));
    expect(rows).toEqual([]);
  });

  it('sees only entries it authored, across the whole table', async () => {
    const rows = await asClaims(db, provider(), (tx) =>
      tx.query<{ provider_id: string | null }>(`SELECT provider_id FROM timeline_entries`));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.provider_id).toBe(providerId);
  });

  it('still cannot change or delete one — the table is append-only for everyone', async () => {
    await expectDenied(() => db.query(
      `UPDATE timeline_entries SET body = 'rewritten' WHERE id = $1`, [noteId]));
    await expectDenied(() => db.query(
      `DELETE FROM timeline_entries WHERE id = $1`, [noteId]));
  });
});

/**
 * Migration 0012 — the partner portal. W11.
 *
 * Two things are being asserted. A partner sees the referrals they sent and nobody
 * else's; and what happened to each is bounded by what the household agreed to share,
 * because the presence of an outcome tells the partner the family engaged us.
 */
describe('W11 — a partner sees their own referrals, within consent', () => {
  let partnerId: string;
  let otherPartnerId: string;
  let partnerUserId: string;
  let mineUnconverted: string;
  let mineConverted: string;
  let theirs: string;
  let convertedHousehold: string;

  const partner = () => ({
    ccn_role: 'partner', ccn_user_id: partnerUserId, ccn_partner_id: partnerId,
  });

  beforeAll(async () => {
    partnerId = (await one<{ id: string }>(
      `INSERT INTO referral_partners (name, org, role)
       VALUES ('A Discharge Planner', 'A Hospital', 'discharge_planner') RETURNING id`)).id;
    otherPartnerId = (await one<{ id: string }>(
      `INSERT INTO referral_partners (name, org, role)
       VALUES ('Another Planner', 'Another Hospital', 'discharge_planner') RETURNING id`)).id;

    partnerUserId = (await one<{ id: string }>(
      `INSERT INTO users (email, display_name, role)
       VALUES ('w11-partner@example.com', 'W11 partner', 'partner') RETURNING id`)).id;
    await db.query(
      `INSERT INTO partner_users (user_id, partner_id) VALUES ($1,$2)`,
      [partnerUserId, partnerId]);

    convertedHousehold = (await one<{ id: string }>(
      `SELECT id FROM households LIMIT 1`)).id;

    mineUnconverted = (await one<{ id: string }>(
      `INSERT INTO inquiries (name, phone, area, urgency, partner_id, referrer)
       VALUES ('Family Contact', '310', 'brentwood', 'discharge', $1,
               '{"patientInitials":"A.B."}'::jsonb)
       RETURNING id`, [partnerId])).id;
    mineConverted = (await one<{ id: string }>(
      `INSERT INTO inquiries (name, phone, area, urgency, partner_id, household_id, referrer)
       VALUES ('Another Contact', '310', 'bel_air', 'routine', $1, $2,
               '{"patientInitials":"C.D."}'::jsonb)
       RETURNING id`, [partnerId, convertedHousehold])).id;
    theirs = (await one<{ id: string }>(
      `INSERT INTO inquiries (name, phone, area, urgency, partner_id, referrer)
       VALUES ('Not Theirs', '310', 'malibu', 'routine', $1,
               '{"patientInitials":"E.F."}'::jsonb)
       RETURNING id`, [otherPartnerId])).id;
  });

  it('cannot read the inquiries table directly', async () => {
    // The projection exists precisely because a row policy would hand over
    // household_id, and its presence is the fact the consent gate protects.
    const rows = await asClaims(db, partner(), (tx) =>
      tx.query(`SELECT id FROM inquiries`));
    expect(rows).toEqual([]);
  });

  it('sees the referrals it sent', async () => {
    const rows = await asClaims(db, partner(), (tx) =>
      tx.query<{ inquiry_id: string }>(`SELECT inquiry_id FROM partner_referrals()`));
    const ids = rows.map((r) => r.inquiry_id);
    expect(ids).toContain(mineUnconverted);
    expect(ids).toContain(mineConverted);
  });

  it('does not see another partner\'s', async () => {
    const rows = await asClaims(db, partner(), (tx) =>
      tx.query<{ inquiry_id: string }>(`SELECT inquiry_id FROM partner_referrals()`));
    expect(rows.map((r) => r.inquiry_id)).not.toContain(theirs);
  });

  it('gets the patient initials it supplied, never a name', async () => {
    const rows = await asClaims(db, partner(), (tx) =>
      tx.query<{ inquiry_id: string; patient_initials: string }>(
        `SELECT inquiry_id, patient_initials FROM partner_referrals()`));
    const row = rows.find((r) => r.inquiry_id === mineUnconverted);
    expect(row!.patient_initials).toBe('A.B.');
  });

  it('is told nothing about the outcome without consent', async () => {
    const rows = await asClaims(db, partner(), (tx) =>
      tx.query<{ inquiry_id: string; outcome: string | null }>(
        `SELECT inquiry_id, outcome FROM partner_referrals()`));
    // Converted, but the household has not agreed to share that.
    expect(rows.find((r) => r.inquiry_id === mineConverted)!.outcome).toBeNull();
    expect(rows.find((r) => r.inquiry_id === mineUnconverted)!.outcome).toBeNull();
  });

  it('is told once the household consents', async () => {
    await db.query(
      `INSERT INTO consents (subject_type, subject_id, kind, granted_at, granted_by)
       VALUES ('household', $1, 'partner_outcome', now(), 'operator')`,
      [convertedHousehold]);
    const rows = await asClaims(db, partner(), (tx) =>
      tx.query<{ inquiry_id: string; outcome: string | null }>(
        `SELECT inquiry_id, outcome FROM partner_referrals()`));
    expect(rows.find((r) => r.inquiry_id === mineConverted)!.outcome).toBe('care_arranged');
  });

  it('stops being told the moment consent is revoked', async () => {
    await db.query(
      `UPDATE consents SET revoked_at = now()
        WHERE subject_type = 'household' AND subject_id = $1 AND kind = 'partner_outcome'`,
      [convertedHousehold]);
    const rows = await asClaims(db, partner(), (tx) =>
      tx.query<{ inquiry_id: string; outcome: string | null }>(
        `SELECT inquiry_id, outcome FROM partner_referrals()`));
    expect(rows.find((r) => r.inquiry_id === mineConverted)!.outcome).toBeNull();
  });

  it('gives a household nothing through the same function', async () => {
    const rows = await asClaims(db, household(), (tx) =>
      tx.query(`SELECT inquiry_id FROM partner_referrals()`));
    expect(rows).toEqual([]);
  });

  it('may still hand in a referral, which is the part needing no account', async () => {
    const before = await one<{ n: string }>(`SELECT count(*)::text AS n FROM inquiries`);
    // No RETURNING. Under row-level security, INSERT ... RETURNING also needs a SELECT
    // policy matching the new row, and a partner deliberately has none on `inquiries`
    // — they read through partner_referrals() instead. The application never hits
    // this: /api/refer runs on the operator connection, like the other intake routes.
    await asClaims(db, { ccn_role: 'partner' }, (tx) => tx.query(
      `INSERT INTO inquiries (name, phone, area, urgency)
       VALUES ('Walk-in Referral', '310', 'westwood', 'discharge')`));
    const after = await one<{ n: string }>(`SELECT count(*)::text AS n FROM inquiries`);
    expect(Number(after.n)).toBe(Number(before.n) + 1);
  });

  it('an invite for a partner must name one', async () => {
    await expectDenied(() => db.query(
      `INSERT INTO portal_invites (email, role, token_hash, issued_by, expires_at)
       VALUES ('x@example.com', 'partner', 'hash-w11', 'operator', now() + interval '1 day')`));
  });
});

describe('W11 — nothing in the schema could hold a referral payment', () => {
  it('has no column that reads as compensation, anywhere', async () => {
    // § 1812.531 forbids a nurses' registry dividing fees with a physician, surgeon,
    // nurse, hospital, patient or their agents — which covers most of the people the
    // partner portal is for. Spec § 0.1: "no schema column that could hold one". A
    // column that exists gets filled in, so the assertion is that it does not.
    const rows = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (column_name ~* 'commission|compensat|bonus|reward|payout|kickback|incentive|finder'
               OR column_name ~* 'referral_fee|partner_fee|split')`);
    expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([]);
  });

  it('keeps the referral partner record to contact details and nothing else', async () => {
    const rows = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'referral_partners'
        ORDER BY column_name`);
    expect(rows.map((r) => r.column_name).sort()).toEqual(
      ['created_at', 'email', 'id', 'name', 'notes', 'org', 'phone', 'role']);
  });
});

/**
 * Migration 0014 — the rest of the write-to-read pattern, and three records that
 * said they were permanent and were not.
 */
describe('0014 — a partner may hand us a referral and nothing else', () => {
  let partnerId: string;
  let otherPartnerId: string;
  let partnerUserId: string;
  const partner = () => ({
    ccn_role: 'partner', ccn_user_id: partnerUserId, ccn_partner_id: partnerId,
  });

  beforeAll(async () => {
    partnerId = (await one<{ id: string }>(
      `INSERT INTO referral_partners (name) VALUES ('0014 Partner') RETURNING id`)).id;
    otherPartnerId = (await one<{ id: string }>(
      `INSERT INTO referral_partners (name) VALUES ('0014 Other') RETURNING id`)).id;
    partnerUserId = (await one<{ id: string }>(
      `INSERT INTO users (email, display_name, role)
       VALUES ('0014-partner@example.com', '0014 partner', 'partner') RETURNING id`)).id;
    await db.query(`INSERT INTO partner_users (user_id, partner_id) VALUES ($1,$2)`,
      [partnerUserId, partnerId]);
  });

  it('may still send one with no attribution at all — the no-account path', async () => {
    await asClaims(db, { ccn_role: 'partner' }, (tx) => tx.query(
      `INSERT INTO inquiries (name, phone, area, urgency)
       VALUES ('0014 walk-in', '310', 'westwood', 'routine')`));
  });

  it('cannot aim a referral at a household, which was a consent oracle', async () => {
    // partner_referrals() answers "did this household consent to sharing the outcome".
    // Scoped by inquiries.partner_id, which the partner writes — so a forged row with
    // somebody else's household_id turned that into a question anyone could ask.
    const household = await one<{ id: string }>(`SELECT id FROM households LIMIT 1`);
    await expectDenied(() => asClaims(db, partner(), (tx) => tx.query(
      `INSERT INTO inquiries (name, partner_id, household_id)
       VALUES ('forged', $1, $2)`, [partnerId, household.id])));
  });

  it('cannot attribute a referral to a different partner', async () => {
    await expectDenied(() => asClaims(db, partner(), (tx) => tx.query(
      `INSERT INTO inquiries (name, partner_id) VALUES ('misattributed', $1)`,
      [otherPartnerId])));
  });

  it('cannot pre-mark a referral handled, hiding it from the operator queue', async () => {
    await expectDenied(() => asClaims(db, partner(), (tx) => tx.query(
      `INSERT INTO inquiries (name, partner_id, handled_at, handled_by)
       VALUES ('prehandled', $1, now(), 'nobody')`, [partnerId])));
  });

  it('cannot forge a compliance alert in the operator\'s queue', async () => {
    await expectDenied(() => asClaims(db, partner(), (tx) => tx.query(
      `INSERT INTO operator_notifications (kind, subject, body)
       VALUES ('credential_expiring', 'All clear', 'Nothing outstanding')`)));
    await expectDenied(() => asClaims(db, partner(), (tx) => tx.query(
      `INSERT INTO operator_notifications (kind, subject, body, delivered_at, read_at)
       VALUES ('partner_referral', 'x', 'y', now(), now())`)));
  });

  it('may still cause the one notification it is meant to', async () => {
    await asClaims(db, partner(), (tx) => tx.query(
      `INSERT INTO operator_notifications (kind, subject, body)
       VALUES ('partner_referral', 'A referral arrived', 'Open the console.')`));
  });
});

describe('0014 — records that said they were permanent now are', () => {
  it('revoking a consent takes the testimonial down', async () => {
    const household = await one<{ id: string }>(`SELECT id FROM households LIMIT 1`);
    const consent = await one<{ id: string }>(
      `INSERT INTO consents (subject_type, subject_id, kind, granted_at, granted_by)
       VALUES ('household', $1, 'testimonial', now(), 'operator') RETURNING id`,
      [household.id]);
    const t = await one<{ id: string }>(
      `INSERT INTO testimonials (household_id, consent_id, body, attribution, published)
       VALUES ($1, $2, 'They were wonderful.', 'J.T., Brentwood', true) RETURNING id`,
      [household.id, consent.id]);

    await db.query(`UPDATE consents SET revoked_at = now() WHERE id = $1`, [consent.id]);

    const after = await one<{ published: boolean }>(
      `SELECT published FROM testimonials WHERE id = $1`, [t.id]);
    // Was: still true. Publication outlived the consent it rested on.
    expect(after.published).toBe(false);
  });

  it('a fee schedule cannot be backdated into its own notice period', async () => {
    await expectDenied(() => db.query(
      `INSERT INTO fee_schedules (version, max_fee_pct, payment_terms, body,
                                  posted_at, effective_from)
       VALUES (8001, 15, 'Net 15', 'backdated',
               now() + interval '2 days', current_date + 30)`));
  });

  it('a posted fee schedule cannot be rewritten under the nurse it was given to', async () => {
    const s = await one<{ id: string }>(
      `INSERT INTO fee_schedules (version, max_fee_pct, payment_terms, body,
                                  posted_at, effective_from)
       VALUES (8002, 15, 'Net 15', 'original', now(), current_date + 10) RETURNING id`);
    await expectDenied(() => db.query(
      `UPDATE fee_schedules SET max_fee_pct = 40, body = 'rewritten' WHERE id = $1`,
      [s.id]));
    await expectDenied(() => db.query(`DELETE FROM fee_schedules WHERE id = $1`, [s.id]));
  });

  it('feedback cannot be revised or deleted by anyone', async () => {
    /*
     * A referral that has no feedback yet, chosen deterministically.
     *
     * This was `SELECT id FROM referrals LIMIT 1`, which is whatever Postgres hands back
     * from the heap. An earlier test in this file leaves feedback on a referral, so
     * whenever the unordered read happened to return that one, this test collided with
     * `referral_feedback_one_per_referral` and the suite went red for no reason. An
     * intermittently failing test teaches you to re-run rather than to read.
     */
    const referral = await one<{ id: string }>(
      `SELECT r.id FROM referrals r
        WHERE NOT EXISTS (SELECT 1 FROM referral_feedback f WHERE f.referral_id = r.id)
        ORDER BY r.id LIMIT 1`);
    const f = await one<{ id: string }>(
      `INSERT INTO referral_feedback (referral_id, referral_service_rating, notes)
       VALUES ($1, 2, 'as said at the time') RETURNING id`, [referral.id]);
    await expectDenied(() => db.query(
      `UPDATE referral_feedback SET referral_service_rating = 5 WHERE id = $1`, [f.id]));
    await expectDenied(() => db.query(
      `DELETE FROM referral_feedback WHERE id = $1`, [f.id]));
  });

  it('and only one answer per referral', async () => {
    const referral = await one<{ id: string }>(
      `SELECT referral_id AS id FROM referral_feedback ORDER BY referral_id LIMIT 1`);
    await expectDenied(() => db.query(
      `INSERT INTO referral_feedback (referral_id, referral_service_rating)
       VALUES ($1, 5)`, [referral.id]));
  });
});

describe('0014 — a claim is only as good as the membership behind it', () => {
  it('a household claim naming a household the user does not belong to resolves to nothing', async () => {
    const orphan = await one<{ id: string }>(
      `INSERT INTO users (email, display_name, role)
       VALUES ('0014-orphan@example.com', 'Orphan', 'household') RETURNING id`);
    const other = await one<{ id: string }>(`SELECT id FROM households LIMIT 1`);

    const rows = await asClaims(
      db,
      { ccn_role: 'household', ccn_household_id: other.id, ccn_user_id: orphan.id },
      (tx) => tx.query<{ h: string | null }>(`SELECT current_household()::text AS h`));
    expect(rows[0]!.h).toBeNull();
  });

  it('and so it reaches none of that household\'s data', async () => {
    const orphan = await one<{ id: string }>(
      `SELECT id FROM users WHERE email = '0014-orphan@example.com'`);
    const rows = await asClaims(
      db,
      { ccn_role: 'household', ccn_household_id: householdId, ccn_user_id: orphan.id },
      (tx) => tx.query(`SELECT id FROM cases`));
    expect(rows).toEqual([]);
  });

  it('a real member still resolves', async () => {
    const rows = await asClaims(db, household(), (tx) =>
      tx.query<{ h: string | null }>(`SELECT current_household()::text AS h`));
    expect(rows[0]!.h).toBe(householdId);
  });
});
