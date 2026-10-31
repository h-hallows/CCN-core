-- Role-based row-level security. Architecture spec § 4.
--
-- Migrations 0001 and 0002 enabled RLS on every table with a single permissive policy:
-- "is anyone identified". That was right while the operator console was the only client.
-- It is not right once households and providers sign in, so this replaces it with the
-- § 4 matrix.
--
-- WHERE THE CLAIMS COME FROM. The spec writes auth.jwt(), which exists only on Supabase.
-- These helpers read `request.jwt.claims` instead — the GUC Supabase's own auth.jwt()
-- reads — so the same policies are enforced identically on Supabase, on RDS, on a local
-- Docker Postgres and on the embedded database the tests use. Every connection sets it;
-- see setClaims() in packages/core/src/db/client.ts.
--
-- FORCE, not just ENABLE. Postgres exempts a table's owner from its own policies, and on
-- a managed Postgres the role you are given usually owns everything. Without FORCE the
-- entire matrix below would be present and inert, and every test of it would pass for
-- the wrong reason.

-- ---------------------------------------------------------------------------
-- Claims
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ccn_claims() RETURNS jsonb
  LANGUAGE sql STABLE AS $$
    SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  $$;

CREATE OR REPLACE FUNCTION current_role_name() RETURNS user_role
  LANGUAGE sql STABLE AS $$
    SELECT nullif(ccn_claims() ->> 'ccn_role', '')::user_role;
  $$;

CREATE OR REPLACE FUNCTION current_household() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT nullif(ccn_claims() ->> 'ccn_household_id', '')::uuid;
  $$;

CREATE OR REPLACE FUNCTION current_provider() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT nullif(ccn_claims() ->> 'ccn_provider_id', '')::uuid;
  $$;

CREATE OR REPLACE FUNCTION current_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT nullif(ccn_claims() ->> 'ccn_user_id', '')::uuid;
  $$;

CREATE OR REPLACE FUNCTION is_operator() RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT current_role_name() = 'operator'; $$;

-- ---------------------------------------------------------------------------
-- Drop the blanket policies from 0001 and 0002, and force RLS everywhere.
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = current_schema()
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS operator_all ON %I', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    -- Default for every table: the operator, and nobody else. Tables that other roles
    -- may touch get their narrower policies below, which are additive.
    EXECUTE format(
      'CREATE POLICY operator_all ON %I FOR ALL USING (is_operator()) WITH CHECK (is_operator())',
      t);
  END LOOP;
END $$;

-- The migration bookkeeping table is infrastructure, not data. Leaving it behind the
-- operator claim would mean a migration runner has to impersonate one.
ALTER TABLE _migrations NO FORCE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- Ownership helpers.
--
-- SECURITY DEFINER on purpose. A policy on `cases` that queries `referrals`, whose own
-- policy queries `cases`, is infinite recursion — Postgres detects it and fails the
-- statement. Running the lookup as the definer steps outside row-level security for
-- that one question, which is both the standard fix and safe here: each takes an id and
-- answers a yes/no about the CURRENT claim. None returns a row, so none can be used to
-- read anything the caller could not already see.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION household_owns_case(c uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT current_household() IS NOT NULL
       AND EXISTS (SELECT 1 FROM cases WHERE id = c AND household_id = current_household());
  $$;

CREATE OR REPLACE FUNCTION household_owns_shortlist(s uuid, require_live boolean DEFAULT true)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT current_household() IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM published_shortlists p JOIN cases c ON c.id = p.case_id
          WHERE p.id = s
            AND c.household_id = current_household()
            AND (NOT require_live OR p.withdrawn_at IS NULL));
  $$;

CREATE OR REPLACE FUNCTION provider_on_household_bench(pr uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT current_household() IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM published_shortlist_items i
           JOIN published_shortlists p ON p.id = i.shortlist_id
           JOIN cases c ON c.id = p.case_id
          WHERE i.provider_id = pr
            AND p.withdrawn_at IS NULL
            AND c.household_id = current_household());
  $$;

CREATE OR REPLACE FUNCTION provider_referred_to_case(c uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT current_provider() IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM referrals WHERE case_id = c AND provider_id = current_provider());
  $$;

CREATE OR REPLACE FUNCTION household_owns_referral(r uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT current_household() IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM referrals rr JOIN cases c ON c.id = rr.case_id
          WHERE rr.id = r AND c.household_id = current_household());
  $$;

-- ---------------------------------------------------------------------------
-- providers — a household sees only providers on a shortlist published to its own
-- case, and never a withdrawn one. A provider sees and edits only their own row.
-- ---------------------------------------------------------------------------

CREATE POLICY providers_household_select ON providers
  FOR SELECT USING (
    current_role_name() = 'household'
    AND provider_on_household_bench(providers.id)
  );

CREATE POLICY providers_own_select ON providers
  FOR SELECT USING (current_role_name() = 'provider' AND id = current_provider());

CREATE POLICY providers_own_update ON providers
  FOR UPDATE USING (current_role_name() = 'provider' AND id = current_provider())
  WITH CHECK (current_role_name() = 'provider' AND id = current_provider());

-- ---------------------------------------------------------------------------
-- credentials — a provider may add a document. They may never set an expiry or a
-- verification: that is the whole diligence story. They upload, the operator verifies.
-- ---------------------------------------------------------------------------

CREATE POLICY credentials_provider_select ON credentials
  FOR SELECT USING (current_role_name() = 'provider' AND provider_id = current_provider());

CREATE POLICY credentials_provider_insert ON credentials
  FOR INSERT WITH CHECK (
    current_role_name() = 'provider' AND provider_id = current_provider()
  );

-- No UPDATE policy for providers, deliberately. There is nothing to grant.

-- ---------------------------------------------------------------------------
-- households and cases
-- ---------------------------------------------------------------------------

CREATE POLICY households_own_select ON households
  FOR SELECT USING (current_role_name() = 'household' AND id = current_household());

-- No household UPDATE on `households`. The one field they author is on `cases`.

CREATE POLICY cases_household_select ON cases
  FOR SELECT USING (current_role_name() = 'household' AND household_id = current_household());

CREATE POLICY cases_household_update ON cases
  FOR UPDATE USING (current_role_name() = 'household' AND household_id = current_household())
  WITH CHECK (current_role_name() = 'household' AND household_id = current_household());

CREATE POLICY cases_provider_select ON cases
  FOR SELECT USING (current_role_name() = 'provider' AND provider_referred_to_case(cases.id));

-- ---------------------------------------------------------------------------
-- the published bench
-- ---------------------------------------------------------------------------

CREATE POLICY shortlists_household_select ON published_shortlists
  FOR SELECT USING (
    current_role_name() = 'household'
    AND withdrawn_at IS NULL
    AND household_owns_case(published_shortlists.case_id)
  );

CREATE POLICY shortlist_items_household_select ON published_shortlist_items
  FOR SELECT USING (
    current_role_name() = 'household'
    AND household_owns_shortlist(published_shortlist_items.shortlist_id)
  );

-- A household may ask. Asking is not referring.
CREATE POLICY shortlist_requests_household_select ON shortlist_requests
  FOR SELECT USING (
    current_role_name() = 'household'
    AND household_owns_shortlist(shortlist_requests.shortlist_id, false)
  );

CREATE POLICY shortlist_requests_household_insert ON shortlist_requests
  FOR INSERT WITH CHECK (
    current_role_name() = 'household'
    AND requested_by = current_user_id()
    AND status = 'pending'
    AND referral_id IS NULL
    AND household_owns_shortlist(shortlist_requests.shortlist_id)
  );

-- ---------------------------------------------------------------------------
-- the compliance record — read by those it concerns, written only by the operator
-- ---------------------------------------------------------------------------

CREATE POLICY referrals_household_select ON referrals
  FOR SELECT USING (
    current_role_name() = 'household'
    AND household_owns_case(referrals.case_id)
  );

CREATE POLICY referrals_provider_select ON referrals
  FOR SELECT USING (current_role_name() = 'provider' AND provider_id = current_provider());

-- There is deliberately no INSERT policy for any role but the operator. A household
-- request is not a referral, and nothing outside the console's disclosure transaction
-- may create one.

CREATE POLICY disclosures_household_select ON disclosures
  FOR SELECT USING (
    current_role_name() = 'household'
    AND household_owns_case(disclosures.case_id)
  );

CREATE POLICY feedback_household_insert ON referral_feedback
  FOR INSERT WITH CHECK (
    current_role_name() = 'household'
    AND use_restriction = 'referral_decisions_only'
    AND household_owns_referral(referral_feedback.referral_id)
  );

-- timeline_entries: a provider may log their own decline on a case they were referred
-- to (§ 6.4). Nothing else, and never an update — the table is append-only anyway.
CREATE POLICY timeline_provider_insert ON timeline_entries
  FOR INSERT WITH CHECK (
    current_role_name() = 'provider'
    AND provider_id = current_provider()
    AND type = 'note'
    AND provider_referred_to_case(timeline_entries.case_id)
  );

-- ---------------------------------------------------------------------------
-- intake — a partner may hand us a referral without an account
-- ---------------------------------------------------------------------------

CREATE POLICY inquiries_partner_insert ON inquiries
  FOR INSERT WITH CHECK (current_role_name() = 'partner');

-- ---------------------------------------------------------------------------
-- portal access
-- ---------------------------------------------------------------------------

CREATE POLICY users_own_select ON users
  FOR SELECT USING (id = current_user_id());

CREATE POLICY household_users_own_select ON household_users
  FOR SELECT USING (user_id = current_user_id());

CREATE POLICY provider_users_own_select ON provider_users
  FOR SELECT USING (user_id = current_user_id());

-- ---------------------------------------------------------------------------
-- Column-level rules that row-level security cannot express.
--
-- A Postgres policy decides which ROWS a statement may touch, not which COLUMNS. The
-- usual answer is a column GRANT, but § 4 puts all four audiences on one database role
-- and distinguishes them by JWT claim, so a grant cannot tell them apart either.
--
-- These triggers are therefore the only place the § 6.4 column rules can live. Without
-- them "enforced by RLS, not by the form" would not be true of the fields that matter
-- most: a provider setting their own credential expiry, or their own service area.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION providers_provider_update_guard() RETURNS trigger AS $$
BEGIN
  IF current_role_name() IS DISTINCT FROM 'provider' THEN
    RETURN NEW;
  END IF;

  -- Everything a provider states about themselves. Notably absent: `status`, which is
  -- the registry's forward-only stop (I4), and `areas`, which the operator confirms
  -- against the service area rather than taking on trust.
  IF (NEW.status, NEW.areas, NEW.full_name, NEW.type, NEW.license_number,
      NEW.license_state, NEW.transports, NEW.notes, NEW.agreement_signed_on,
      NEW.written_notice_ack_on, NEW.work_auth_verified_on, NEW.orientation_on,
      NEW.deleted_at)
     IS DISTINCT FROM
     (OLD.status, OLD.areas, OLD.full_name, OLD.type, OLD.license_number,
      OLD.license_state, OLD.transports, OLD.notes, OLD.agreement_signed_on,
      OLD.written_notice_ack_on, OLD.work_auth_verified_on, OLD.orientation_on,
      OLD.deleted_at) THEN
    RAISE EXCEPTION
      'a referred provider may change their stated rate, availability, restrictions, '
      'contact details and photo — nothing else on this record';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_providers_provider_update
  BEFORE UPDATE ON providers
  FOR EACH ROW EXECUTE FUNCTION providers_provider_update_guard();

CREATE OR REPLACE FUNCTION cases_household_update_guard() RETURNS trigger AS $$
BEGIN
  IF current_role_name() IS DISTINCT FROM 'household' THEN
    RETURN NEW;
  END IF;

  -- The household authors one field: the routine, access and preferences that travel to
  -- a substitute. Not the needs profile, which is a record of what they said at intake
  -- (I10), and certainly not the terms.
  IF (NEW.*) IS DISTINCT FROM (OLD.*)
     AND (NEW.household_profile IS NOT DISTINCT FROM OLD.household_profile) THEN
    RAISE EXCEPTION 'a household may edit its household profile and nothing else on a case';
  END IF;

  IF (NEW.status, NEW.care, NEW.urgency, NEW.needs_profile, NEW.schedule,
      NEW.hours_per_week, NEW.rate_agreed, NEW.fee_pct, NEW.primary_provider_id,
      NEW.alternate_provider_ids, NEW.referred_on, NEW.written_due_on,
      NEW.written_sent_on, NEW.ended_on, NEW.ended_by, NEW.end_reason)
     IS DISTINCT FROM
     (OLD.status, OLD.care, OLD.urgency, OLD.needs_profile, OLD.schedule,
      OLD.hours_per_week, OLD.rate_agreed, OLD.fee_pct, OLD.primary_provider_id,
      OLD.alternate_provider_ids, OLD.referred_on, OLD.written_due_on,
      OLD.written_sent_on, OLD.ended_on, OLD.ended_by, OLD.end_reason) THEN
    RAISE EXCEPTION 'a household may edit its household profile and nothing else on a case';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cases_household_update
  BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION cases_household_update_guard();

-- ---------------------------------------------------------------------------
-- The application role.
--
-- A superuser bypasses row-level security outright, and a table's owner bypasses it
-- unless the table is FORCEd — so the policies above are only real for a role that is
-- neither. This creates that role, which is what the application should connect as in
-- deployment and what the test suite switches to before asserting any of the matrix.
--
-- No DELETE, anywhere. The compliance record is append-only by design, and withholding
-- the privilege means a mistake cannot even reach the triggers that would refuse it.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ccn_app') THEN
    CREATE ROLE ccn_app NOLOGIN;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'could not create role ccn_app; create it by hand and re-grant';
END $$;

GRANT USAGE ON SCHEMA public TO ccn_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ccn_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO ccn_app;
