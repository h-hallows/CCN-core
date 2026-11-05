-- Two reads the client portal needs and the § 4 matrix does not yet grant.
-- Web build spec § 4.1, milestone W7.
--
-- Both are SELECT policies on tables that already have row-level security forced. No
-- table changes, no new columns, nothing granted to any other role.

-- ---------------------------------------------------------------------------
-- A household may see the gaps in its own cover.
--
-- `coverage_gaps` was operator-only, which is the right default and the wrong answer
-- here: the household is the party whose care has the gap. The alternative to showing
-- it is that they discover it when nobody arrives, and a registry that knew and said
-- nothing is in a worse position than one that said "we are arranging cover" on a
-- Tuesday. § 4.1 requires exactly that, with named alternates.
--
-- `resolved_provider_id` names a provider, which is intended: it is the person covering
-- a shift on this household's own case, and they will meet them. It is scoped to their
-- own case and nothing else.
-- ---------------------------------------------------------------------------

CREATE POLICY coverage_gaps_household_select ON coverage_gaps
  FOR SELECT USING (
    current_role_name() = 'household'
    AND household_owns_case(coverage_gaps.case_id)
  );

-- ---------------------------------------------------------------------------
-- A household may read back the feedback it wrote.
--
-- There was an INSERT policy and no SELECT, so a household could submit and never see
-- that it had. The practical result is duplicate submissions against one referral, and
-- an operator reading the same answers twice without knowing whether the second is a
-- correction.
--
-- Still no UPDATE and no DELETE, for either role. Feedback is a statement made at a
-- point in time; one that can be revised afterwards is a weaker record of what was
-- actually said. I7 is untouched by this: the restriction that matters is what the
-- feedback may be USED for — referral decisions only, never provider discipline,
-- coaching or corrective action — and who may read it back does not bear on that.
-- ---------------------------------------------------------------------------

CREATE POLICY feedback_household_select ON referral_feedback
  FOR SELECT USING (
    current_role_name() = 'household'
    AND household_owns_referral(referral_feedback.referral_id)
  );
