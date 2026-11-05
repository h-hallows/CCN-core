-- Four write policies and guards that trusted a value the writer supplied.
--
-- THE PATTERN. Migration 0008 closed one instance: a provider could INSERT a
-- `credentials` row, and `eligibility()` read the presence of that row as proof the
-- requirement was met. The lesson recorded under I12 was about THAT table. The pattern
-- was live in four more places, and this migration closes them.

-- ---------------------------------------------------------------------------
-- 1. CRITICAL — a household could grant itself read on any provider in the registry.
--
-- `shortlist_requests_household_insert` (0003) checked the shortlist belonged to the
-- household and never checked that `provider_id` was ON that shortlist. Then 0007 —
-- written to keep /portal/requests legible after a bench is withdrawn — trusted the
-- presence of such a row as proof of a relationship, and granted SELECT on the whole
-- `providers` row on that basis.
--
-- So: pick any provider uuid, insert a request for them against your own shortlist,
-- and read their row — including `providers.notes`, which is the OPERATOR'S DILIGENCE
-- RECORD. Reproduced against the seed: a household with no sight of a provider gained
-- their name, phone, licence number and notes in one statement. I12 says an ineligible
-- provider must not reach the client "and the reason must not reach them either"; the
-- reason is written in `notes`.
--
-- It also let a household put a provider who was never screened for their case — one
-- marked do_not_refer, or on their own blocked list — into the operator's pending
-- queue, which `screen()` does not re-run.
--
-- Two halves, because either alone leaves the other exploitable by a different route.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS shortlist_requests_household_insert ON shortlist_requests;

CREATE POLICY shortlist_requests_household_insert ON shortlist_requests
  FOR INSERT WITH CHECK (
    current_role_name() = 'household'
    AND requested_by = current_user_id()
    AND status = 'pending'
    AND referral_id IS NULL
    AND household_owns_shortlist(shortlist_requests.shortlist_id)
    -- You may only ask about somebody we put in front of you.
    AND EXISTS (
      SELECT 1 FROM published_shortlist_items i
       WHERE i.shortlist_id = shortlist_requests.shortlist_id
         AND i.provider_id = shortlist_requests.provider_id)
  );

CREATE OR REPLACE FUNCTION provider_engaged_with_household(pr uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT current_household() IS NOT NULL
       AND (
         EXISTS (
           SELECT 1 FROM referrals r JOIN cases c ON c.id = r.case_id
            WHERE r.provider_id = pr AND c.household_id = current_household())
         OR EXISTS (
           SELECT 1 FROM cases c
            WHERE c.household_id = current_household()
              AND (c.primary_provider_id = pr OR pr = ANY(c.alternate_provider_ids)))
         OR EXISTS (
           SELECT 1 FROM coverage_gaps g JOIN cases c ON c.id = g.case_id
            WHERE g.resolved_provider_id = pr AND c.household_id = current_household())
         -- Asked about on one of their shortlists, live or withdrawn — but proven by
         -- the ITEM, which only the operator writes, rather than by the request, whose
         -- provider_id the household supplies.
         OR EXISTS (
           SELECT 1 FROM shortlist_requests sr
             JOIN published_shortlist_items i
               ON i.shortlist_id = sr.shortlist_id AND i.provider_id = sr.provider_id
             JOIN published_shortlists s ON s.id = sr.shortlist_id
             JOIN cases c ON c.id = s.case_id
            WHERE sr.provider_id = pr AND c.household_id = current_household())
       );
  $$;

-- ---------------------------------------------------------------------------
-- 2. HIGH — I11's physician gate was skipped by changing `care` without `status`.
--
-- `assert_physician_for_skilled` fires only on a transition into referred/active, so a
-- case already active could be switched from 'companion' to 'skilled_nursing' with no
-- ordering physician on the household record. § 1812.524(a) is the predicate for the
-- whole Chapter 7 posture. The transition-only design was deliberate — it avoids
-- locking legacy rows — so the fix widens the trigger rather than removing it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_physician_for_skilled() RETURNS trigger AS $$
DECLARE phys text;
BEGIN
  -- Unchanged from 0001 except for the final OR. Fire only on a TRANSITION, because
  -- firing on every update would permanently lock an imported or legacy skilled case
  -- that lacks a physician — it could never be edited again, including to add one.
  IF NEW.care IN ('skilled_nursing','post_surgical','hospice_support')
     AND NEW.status IN ('referred','active')
     AND (TG_OP = 'INSERT'
          OR OLD.status IS DISTINCT FROM NEW.status
          -- Becoming skilled is as much a transition as becoming active. Without this
          -- an already-active companion case could be switched to skilled nursing
          -- with no ordering physician on the household record.
          OR OLD.care IS DISTINCT FROM NEW.care) THEN
    SELECT physician_name INTO phys FROM households WHERE id = NEW.household_id;
    IF phys IS NULL OR btrim(phys) = '' THEN
      RAISE EXCEPTION
        'Skilled case % cannot be referred: no ordering physician on household record', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 3. HIGH — the § 1812.533(b)(4) nurse-disclosure gate read only the newest row.
--
-- It took the most recent disclosure for the case and defaulted the flag to false, so
-- a SECOND referral on the same case — which I3 guarantees produces a second
-- disclosure — silently removed the gate if whoever wrote it did not carry the flag
-- forward. The case could then go active with the residence disclosure never
-- delivered, which is the one § 1812.533(b)(4) requires BEFORE care begins.
--
-- Now: any outstanding disclosure on the case blocks, not just the latest. It also
-- fails CLOSED when the caller cannot read `disclosures`, matching
-- assert_physician_for_skilled rather than differing from it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_nurse_disclosure() RETURNS trigger AS $$
DECLARE outstanding boolean;
BEGIN
  IF NEW.status = 'active'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    -- Was: the newest disclosure only, with the flag defaulting to false. Now: ANY
    -- outstanding one blocks, and an unreadable `disclosures` fails closed rather
    -- than open, matching assert_physician_for_skilled instead of differing from it.
    SELECT EXISTS (
      SELECT 1 FROM disclosures d
       WHERE d.case_id = NEW.id
         AND d.nurse_disclosure_required
         AND d.nurse_disclosure_sent_on IS NULL)
      INTO outstanding;
    IF coalesce(outstanding, true) THEN
      RAISE EXCEPTION
        'Case % cannot start: nurses'' registry disclosure not yet delivered to the patient',
        NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 4. MEDIUM-HIGH — both column guards were deny-lists, and both had gaps.
--
-- `cases_household_update_guard` opened with a check that LOOKED like a catch-all:
--
--   IF (NEW.*) IS DISTINCT FROM (OLD.*)
--      AND (NEW.household_profile IS NOT DISTINCT FROM OLD.household_profile)
--
-- which only means "household_profile must be one of the things that changed". Change
-- it AND something else in one statement and the only remaining check was an explicit
-- list that omitted adl_needs, starts_on, ends_on, expected_weeks, rate_band_low,
-- rate_band_high, language_pref, end_reason_note and deleted_at. A household could set
-- its own rate band (which match.ts reads), rewrite its ADL needs (which I10 is about)
-- or soft-delete its own case, removing it from every operator compliance query.
--
-- The provider guard had the same shape and omitted specialties, languages and
-- max_travel_min — and `specialties` is rendered to households beside verified
-- credentials and sorts the operator's match list.
--
-- Both are inverted to ALLOW-LISTS. 0008's stated reason for preferring a separate
-- table over a column guard was that "every future column has to be remembered"; these
-- two guards are what happens when one is not. A column added in migration 0014 is now
-- refused by default instead of permitted by default.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cases_household_update_guard() RETURNS trigger AS $$
BEGIN
  IF current_role_name() IS DISTINCT FROM 'household' THEN
    RETURN NEW;
  END IF;

  -- Allow-list of one. Everything else on the row must be identical.
  IF (to_jsonb(NEW) - 'household_profile') IS DISTINCT FROM (to_jsonb(OLD) - 'household_profile') THEN
    RAISE EXCEPTION 'a household may edit its household profile and nothing else on a case';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION providers_provider_update_guard() RETURNS trigger AS $$
BEGIN
  IF current_role_name() IS DISTINCT FROM 'provider' THEN
    RETURN NEW;
  END IF;

  -- Everything a provider states about themselves, named explicitly. Anything not in
  -- this list — including anything added later — is refused.
  IF (to_jsonb(NEW) - 'rate_hourly' - 'rate_notes' - 'availability' - 'restrictions'
                    - 'bio' - 'preferred_name' - 'phone' - 'email'
                    - 'photo_url' - 'photo_consent_on' - 'updated_at')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'rate_hourly' - 'rate_notes' - 'availability' - 'restrictions'
                    - 'bio' - 'preferred_name' - 'phone' - 'email'
                    - 'photo_url' - 'photo_consent_on' - 'updated_at') THEN
    RAISE EXCEPTION
      'a referred provider may change their stated rate, availability, restrictions, '
      'bio, contact details and photo — nothing else on this record';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 5. Indexes for the access patterns the portals actually use. No behaviour change.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS inquiries_partner ON inquiries (partner_id, received_at DESC);
CREATE INDEX IF NOT EXISTS coverage_gaps_case_date ON coverage_gaps (case_id, on_date, block);
CREATE INDEX IF NOT EXISTS coverage_gaps_resolver ON coverage_gaps (resolved_provider_id)
  WHERE resolved_provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS psi_provider ON published_shortlist_items (provider_id);
CREATE INDEX IF NOT EXISTS slr_provider ON shortlist_requests (provider_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS cases_primary_prov ON cases (primary_provider_id)
  WHERE primary_provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS timeline_provider ON timeline_entries (provider_id, case_id, at DESC);
