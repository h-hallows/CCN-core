-- The assignment log starts being written. Civil Code § 1812.529, spec § 9.1.
--
-- `assignment_log` was created in migration 0004 and nothing has ever inserted into it.
-- That is the worst of the three states a statutory register can be in. An absent table
-- is an open gap; a written one is evidence; a present and empty one reads as compliance
-- to anyone who looks at the schema, while the shelf it stands for holds nothing. Six
-- referrals for private duty nursing have been recorded in this database and § 1812.529
-- asks for a permanent log sheet for each of them.
--
-- So the log sheet becomes part of what a referral IS, not a form someone fills in
-- afterwards. `makeReferral` writes it in the transaction that writes the referral, and
-- the constraint trigger below checks at COMMIT that it did — deferred, because the two
-- rows cannot both exist before either of them does. A referral for a Chapter 7 care
-- type that reaches the database without its entry is rolled back, whether it came
-- through the app, a script or a psql session.
--
-- The second trigger is about alignment rather than existence. A log sheet carries the
-- patient's name and address and the physician, and it points at a referral that already
-- names a case and a provider. If those disagree the register is worse than empty: it is
-- a permanent, append-only record of an assignment that did not happen as written, which
-- is the false entry § 1812.529 prohibits by name. So the pairing is checked on the way
-- in, where it can still be refused.

-- ---------------------------------------------------------------------------
-- A Chapter 7 referral must carry its log sheet, checked at commit.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_assignment_logged() RETURNS trigger AS $$
DECLARE
  skilled boolean;
  sheets  int;
BEGIN
  -- The same three care types as assert_physician_for_skilled and domain/care.ts
  -- SKILLED. tests/assignment.test.ts fails if the lists part company.
  SELECT c.care IN ('skilled_nursing', 'post_surgical', 'hospice_support')
    INTO skilled
    FROM cases c WHERE c.id = NEW.case_id;

  IF NOT coalesce(skilled, false) THEN
    RETURN NULL;   -- Not a nurses' registry assignment. § 1812.529 does not reach it.
  END IF;

  SELECT count(*) INTO sheets FROM assignment_log WHERE referral_id = NEW.id;
  IF sheets = 0 THEN
    RAISE EXCEPTION
      'Civil Code 1812.529: a private duty nursing referral must be entered in the '
      'assignment log in the same transaction (referral %)', NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_assignment_logged
  AFTER INSERT ON referrals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_assignment_logged();

-- ---------------------------------------------------------------------------
-- A log sheet must describe the referral it points at.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_assignment_aligned() RETURNS trigger AS $$
DECLARE r record;
BEGIN
  SELECT case_id, provider_id INTO r FROM referrals WHERE id = NEW.referral_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assignment_log: referral % does not exist', NEW.referral_id;
  END IF;
  IF r.case_id <> NEW.case_id THEN
    RAISE EXCEPTION
      'assignment_log: entry names case % but referral % is on case %',
      NEW.case_id, NEW.referral_id, r.case_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF r.provider_id <> NEW.provider_id THEN
    RAISE EXCEPTION
      'assignment_log: entry names provider % but referral % is to provider %',
      NEW.provider_id, NEW.referral_id, r.provider_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Service cannot end before it begins. A permanent record saying otherwise cannot be
  -- edited, so it is refused rather than corrected.
  IF NEW.service_to IS NOT NULL AND NEW.service_to < NEW.service_from THEN
    RAISE EXCEPTION 'assignment_log: service_to precedes service_from'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_assignment_aligned
  BEFORE INSERT ON assignment_log
  FOR EACH ROW EXECUTE FUNCTION assert_assignment_aligned();

-- The commit check reads by referral, and so does every correction lookup.
CREATE UNIQUE INDEX IF NOT EXISTS assignment_log_original_per_referral
  ON assignment_log (referral_id) WHERE corrects_id IS NULL;

-- ---------------------------------------------------------------------------
-- The register is readable, so it is an audited entity.
--
-- A log sheet holds the patient's name, their address and their physician. Opening the
-- register is reading identifiable information about those households, and § 3.8 asks
-- who looked. Dropped and re-added rather than widened, for the reason 0021 gives:
-- Postgres has no ALTER CONSTRAINT for a CHECK, and the history stays NOT VALID.
-- ---------------------------------------------------------------------------

ALTER TABLE audit_log DROP CONSTRAINT audit_log_entity_vocabulary;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_entity_vocabulary CHECK (entity IN (
    'assignment', 'audit_log', 'case', 'compliance', 'consent', 'credential',
    'credential_submission', 'disclosure', 'disclosure_log_export', 'document',
    'fee_schedule', 'fee_schedule_delivery', 'household', 'inquiry',
    'operator_session', 'provider', 'provider_application', 'published_shortlist',
    'referral', 'referral_feedback', 'referral_partner', 'service_failure',
    'shortlist_request', 'timeline_entry', 'today', 'unattributed_referral', 'user'
  )) NOT VALID;
