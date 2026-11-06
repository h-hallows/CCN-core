-- The rest of the write-to-read pattern, plus three records that were not permanent.
--
-- 0013 closed the household→provider escalation. These are the remaining instances
-- found by the same review: a row a non-operator writes, which something else reads as
-- authoritative, with the write unconstrained.

-- ---------------------------------------------------------------------------
-- 1. A partner's intake write constrained no columns.
--
-- `inquiries_partner_insert` (0003) checked the role and nothing else, while
-- `partner_referrals()` (0012) scopes a partner's view by `inquiries.partner_id` — a
-- column the partner writes. So a partner could insert a row naming their own
-- partner_id and an ARBITRARY household_id, then read the outcome field back: the
-- function answers "does that household have a live partner_outcome consent". 0012's
-- own comment says the presence of household_id "tells a partner the family engaged
-- us — which is the one fact the consent gate exists to protect", and the forged row
-- walked through the gate it built.
--
-- Forging `handled_at` also put a referral outside `inquiries_unhandled`, i.e. out of
-- the operator's queue; forging someone else's partner_id misattributed it.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS inquiries_partner_insert ON inquiries;

CREATE POLICY inquiries_partner_insert ON inquiries
  FOR INSERT WITH CHECK (
    current_role_name() = 'partner'
    -- Either unattributed (the no-account path, where the operator links it later) or
    -- attributed to the partner actually signed in. Never to anyone else.
    AND (partner_id IS NULL OR partner_id = current_partner())
    -- A referral arrives unconverted and unhandled. The operator decides both.
    AND household_id IS NULL
    AND handled_at IS NULL
    AND handled_by IS NULL
  );

-- ---------------------------------------------------------------------------
-- 2. A partner could write anything into the operator's notification queue.
--
-- `notifications_partner_insert` (0005) checked only the role, so a partner could
-- choose any `notification_kind` — including the compliance kinds
-- `written_statement_due`, `nurse_disclosure_outstanding` and `credential_expiring` —
-- write arbitrary subject, body and payload, and pre-mark the row delivered and read.
-- An untrusted party writing rows that look like the system's own compliance alerts,
-- into a queue a human works, is an integrity problem for exactly the records the
-- registry's position rests on. Once mail is wired it is also a phishing surface.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS notifications_partner_insert ON operator_notifications;

CREATE POLICY notifications_partner_insert ON operator_notifications
  FOR INSERT WITH CHECK (
    current_role_name() = 'partner'
    AND kind = 'partner_referral'
    AND delivered_at IS NULL
    AND read_at IS NULL
  );

-- ---------------------------------------------------------------------------
-- 3. Revoking a consent did not unpublish what it consented to.
--
-- `assert_live_consent` fires on `testimonials` only, so it refuses a NEW publication
-- on a revoked consent and does nothing about one already published. Nothing fired on
-- `consents` at all. Reproduced: publish, revoke, and the testimonial is still live.
--
-- 0002's comment says the rule should not "rest entirely on the application
-- remembering to join". Revocation after publication is the case that actually
-- matters, and it rested on exactly that. Under § 1812.533(b)(1) a published
-- testimonial whose consent was withdrawn is an advertising exposure as well as a
-- privacy one, so withdrawal takes effect at the moment it is recorded.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION unpublish_on_revoked_consent() RETURNS trigger AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
    UPDATE testimonials SET published = false
     WHERE consent_id = NEW.id AND published;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_consent_revoked
  AFTER UPDATE ON consents
  FOR EACH ROW EXECUTE FUNCTION unpublish_on_revoked_consent();

-- ---------------------------------------------------------------------------
-- 4. The § 1812.527 embargo was arithmetic, not an embargo; and a delivered schedule
--    could be rewritten underneath the nurse it was delivered to.
--
-- The CHECK compares effective_from against posted_at, and posted_at is caller
-- supplied with no bound — so backdating it by seven days satisfies a schedule
-- effective today. A CHECK cannot express `posted_at <= now()` because now() is not
-- immutable, so this belongs in a trigger.
--
-- Worse: `fee_schedules` had no immutability guard at all, while
-- `fee_schedule_deliveries` is read as proof a nurse received schedule X before their
-- interview. Reproduced: deliver version N, then rewrite its max_fee_pct and body. The
-- delivery row still attests to content that no longer exists. That is the same
-- pattern as the others, pointed the other way — the row proves delivery of something
-- mutable.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fee_schedule_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a posted fee schedule is a permanent record and cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The embargo is seven days of NOTICE, which backdating does not give.
    IF NEW.posted_at > now() + interval '1 minute' THEN
      RAISE EXCEPTION 'a fee schedule cannot be posted in the future';
    END IF;
    RETURN NEW;
  END IF;

  -- Nothing a nurse was shown may change afterwards. Post a new version instead.
  IF (NEW.version, NEW.max_fee_pct, NEW.payment_terms, NEW.body,
      NEW.posted_at, NEW.effective_from)
     IS DISTINCT FROM
     (OLD.version, OLD.max_fee_pct, OLD.payment_terms, OLD.body,
      OLD.posted_at, OLD.effective_from) THEN
    RAISE EXCEPTION
      'a posted fee schedule is immutable; post a new version with its own notice period';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fee_schedule_guard
  BEFORE INSERT OR UPDATE OR DELETE ON fee_schedules
  FOR EACH ROW EXECUTE FUNCTION fee_schedule_guard();

-- ---------------------------------------------------------------------------
-- 5. Feedback said it was immutable and was not.
--
-- 0006: "Still no UPDATE and no DELETE, for either role. Feedback is a statement made
-- at a point in time; one that can be revised afterwards is a weaker record." True of
-- the household, which has no policy. Not true of the operator, whose `operator_all`
-- is FOR ALL with an UPDATE grant and no guard. I7 makes this record legally
-- load-bearing, so it gets the same treatment `disclosures` has.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION referral_feedback_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'referral feedback is what was said at the time and cannot be % afterwards', TG_OP;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_referral_feedback_immutable
  BEFORE UPDATE OR DELETE ON referral_feedback
  FOR EACH ROW EXECUTE FUNCTION referral_feedback_guard();

-- Only one answer per referral, so the application's check-then-insert cannot race.
CREATE UNIQUE INDEX IF NOT EXISTS referral_feedback_one_per_referral
  ON referral_feedback (referral_id);

-- ---------------------------------------------------------------------------
-- 6. The claims were four independent assertions nobody cross-checked.
--
-- `current_household()` returned whatever the claim said, with no check that
-- `current_user_id()` is actually a member of that household. Nothing is exploitable
-- through the apps today — they build claims from the session's own membership rows —
-- but it is the one bug class that turns a scoped leak into an unscoped one, and the
-- membership tables already exist. Defence in depth, one EXISTS each.
--
-- The operator is exempt: it carries no household or provider claim.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_household() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT h.household_id
      FROM household_users h
     WHERE h.household_id = nullif(ccn_claims() ->> 'ccn_household_id', '')::uuid
       AND h.user_id = nullif(ccn_claims() ->> 'ccn_user_id', '')::uuid;
  $$;

CREATE OR REPLACE FUNCTION current_provider() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT p.provider_id
      FROM provider_users p
     WHERE p.provider_id = nullif(ccn_claims() ->> 'ccn_provider_id', '')::uuid
       AND p.user_id = nullif(ccn_claims() ->> 'ccn_user_id', '')::uuid;
  $$;

CREATE OR REPLACE FUNCTION current_partner() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT r.partner_id
      FROM partner_users r
     WHERE r.partner_id = nullif(ccn_claims() ->> 'ccn_partner_id', '')::uuid
       AND r.user_id = nullif(ccn_claims() ->> 'ccn_user_id', '')::uuid;
  $$;

-- ---------------------------------------------------------------------------
-- 7. The SECURITY DEFINER with no caller check.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION household_shares_outcome_with_partner(h uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT current_role_name() = 'partner'
       AND current_partner() IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM consents
          WHERE subject_type = 'household'
            AND subject_id = h
            AND kind = 'partner_outcome'
            AND revoked_at IS NULL);
  $$;
