-- A household may see the name of a provider it is actually engaged with.
-- Web build spec § 4.1, milestone W7.
--
-- THE GAP THIS CLOSES. `providers_household_select` (migration 0003) grants a household
-- sight of a provider only while that provider sits on a LIVE bench of theirs —
-- `provider_on_household_bench` requires `withdrawn_at IS NULL`. That is exactly right
-- for the shortlist: a bench the operator has withdrawn is not theirs to browse.
--
-- It is wrong for everything that happens afterwards. The operator withdraws the
-- shortlist once a referral is made, and from that moment the household cannot read the
-- name of the person working in their own home. Two W7 screens need it:
--
--   /portal/schedule  — "who is covering; named alternates" (§ 4.1), and the provider
--                       who resolved a gap in the cover.
--   /portal/requests  — a request survives the withdrawal of the bench it was made
--                       against (that policy passes require_live = false), so the list
--                       would otherwise render rows naming nobody.
--
-- The alternative was to resolve these names through an elevated, server-only read, the
-- way eligibility is re-checked. That is the wrong tool here. An elevated read is for
-- something the household is NOT entitled to see (a credential record) being reduced to
-- something they are (a boolean). A household is plainly entitled to the name of the
-- nurse in their house. The policy was simply never written for the state after
-- referral, so this writes it.
--
-- Scoped to their own cases throughout. It grants no view of a provider they have no
-- relationship with, and still no view of a provider's credentials, licence number or
-- any other column the console holds.

CREATE OR REPLACE FUNCTION provider_engaged_with_household(pr uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT current_household() IS NOT NULL
       AND (
         -- Referred to one of their cases. The ordinary path.
         EXISTS (
           SELECT 1 FROM referrals r JOIN cases c ON c.id = r.case_id
            WHERE r.provider_id = pr AND c.household_id = current_household())
         -- Named on the case as the primary or an alternate. Normally implies a
         -- referral; checked separately so a data state where it does not still renders.
         OR EXISTS (
           SELECT 1 FROM cases c
            WHERE c.household_id = current_household()
              AND (c.primary_provider_id = pr OR pr = ANY(c.alternate_provider_ids)))
         -- Covered a gap on one of their cases.
         OR EXISTS (
           SELECT 1 FROM coverage_gaps g JOIN cases c ON c.id = g.case_id
            WHERE g.resolved_provider_id = pr AND c.household_id = current_household())
         -- Asked about on one of their shortlists, live or withdrawn. Keeps
         -- /portal/requests legible after the bench is taken down.
         OR EXISTS (
           SELECT 1 FROM shortlist_requests sr
             JOIN published_shortlists s ON s.id = sr.shortlist_id
             JOIN cases c ON c.id = s.case_id
            WHERE sr.provider_id = pr AND c.household_id = current_household())
       );
  $$;

CREATE POLICY providers_household_engaged_select ON providers
  FOR SELECT USING (
    current_role_name() = 'household'
    AND provider_engaged_with_household(providers.id)
  );
