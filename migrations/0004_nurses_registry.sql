-- The nurses' registry chapter. Web build spec § 9.
--
-- THE CORRECTION THIS MIGRATION EXISTS FOR. Every earlier document treated Civil Code
-- § 1812.5095 as governing. That is right for CNAs, HCAs and companions. It is the wrong
-- chapter for nurses: private duty nursing referrals fall under Chapter 7,
-- §§ 1812.524–1812.533, which carries obligations with no § 1812.5095 equivalent — an
-- assignment log, a posted fee schedule with a seven-day embargo, a licence physically
-- inspected, and a residence disclosure delivered BEFORE care begins rather than within
-- three business days afterwards.
--
-- The timing difference is the one to get right. A single "send within three days" job
-- satisfies § 1812.5095(f) and breaches § 1812.533(b)(4). So the nurse disclosure is a
-- status gate on the case, not a reminder.

-- ---------------------------------------------------------------------------
-- § 9.1 Assignment log — § 1812.529
--
-- Permanent log sheets for every order and assignment. "No false entries" is easier to
-- prove when nothing can be rewritten, so this is append-only and a correction is a new
-- row referencing the old one.
-- ---------------------------------------------------------------------------

CREATE TABLE assignment_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id             uuid NOT NULL REFERENCES cases(id),
  referral_id         uuid NOT NULL REFERENCES referrals(id),
  provider_id         uuid NOT NULL REFERENCES providers(id),
  order_received_at   timestamptz NOT NULL,
  patient_name        text NOT NULL,
  patient_address     text NOT NULL,
  attending_physician text NOT NULL,          -- § 1812.524 predicate, logged per assignment
  service_from        timestamptz NOT NULL,
  service_to          timestamptz,
  fee_basis           text NOT NULL,          -- the fee charged, as charged
  recorded_by         text NOT NULL,
  /** A correction never edits; it supersedes. */
  corrects_id         uuid REFERENCES assignment_log(id),
  correction_note     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assignment_log_correction_has_note
    CHECK (corrects_id IS NULL OR btrim(coalesce(correction_note, '')) <> '')
);

CREATE INDEX assignment_log_case ON assignment_log (case_id, service_from DESC);
CREATE INDEX assignment_log_provider ON assignment_log (provider_id, service_from DESC);

CREATE TRIGGER trg_assignment_log_append_only
  BEFORE UPDATE OR DELETE ON assignment_log
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- ---------------------------------------------------------------------------
-- § 9.2 Fee schedule — § 1812.527
--
-- Given to the nurse BEFORE the interview, not at signing. The maximum fee is fixed and
-- covers all charges. A change takes effect only after seven days of conspicuous
-- posting, which the CHECK enforces in the database rather than in a calendar reminder.
-- ---------------------------------------------------------------------------

CREATE TABLE fee_schedules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version        int NOT NULL UNIQUE,
  max_fee_pct    numeric(5,2) NOT NULL CHECK (max_fee_pct > 0),
  payment_terms  text NOT NULL,
  body           text NOT NULL,
  posted_at      timestamptz NOT NULL,
  effective_from date NOT NULL,
  CONSTRAINT fee_schedule_seven_day_embargo
    CHECK (effective_from >= (posted_at AT TIME ZONE 'America/Los_Angeles')::date + 7)
);

CREATE TABLE fee_schedule_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id      uuid NOT NULL REFERENCES providers(id),
  schedule_id      uuid NOT NULL REFERENCES fee_schedules(id),
  delivered_at     timestamptz NOT NULL,
  delivered_by     text NOT NULL,
  before_interview boolean NOT NULL,
  UNIQUE (provider_id, schedule_id)
);

-- ---------------------------------------------------------------------------
-- § 9.3 Licence inspection — § 1812.528
--
-- The statute asks for a physical inspection noted on the application with the expiry
-- date, which is a different act from a primary-source lookup. Both are recorded: the
-- lookup in verification_source, the inspection here.
--
-- NOT VALID is deliberate. Existing rows predate the requirement, and backfilling
-- inspected_at would be asserting that someone physically inspected a licence when
-- nobody did — fabricating the exact record the statute wants. New and updated rows are
-- checked from now on; run VALIDATE CONSTRAINT once the operator has worked through the
-- existing nurses.
-- ---------------------------------------------------------------------------

ALTER TABLE credentials
  ADD COLUMN inspected_at             date,
  ADD COLUMN inspected_by             text,
  ADD COLUMN inspected_expiry_noted   date,
  ADD COLUMN experience_verified_at   date,
  ADD COLUMN experience_verified_note text;

ALTER TABLE credentials ADD CONSTRAINT nurse_license_inspected
  CHECK (
    type NOT IN ('rn_license','lvn_license')
    OR (inspected_at IS NOT NULL AND inspected_by IS NOT NULL
        AND inspected_expiry_noted IS NOT NULL)
  ) NOT VALID;

-- ---------------------------------------------------------------------------
-- § 9.4 Advertising record — § 1812.533(c)
--
-- A record of every advertisement with date and publication, kept one year. A website
-- is an advertisement and it changes every deploy, so CI writes this row; a manual log
-- would not be kept.
-- ---------------------------------------------------------------------------

CREATE TABLE advertising_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  published_on date NOT NULL,
  publication  text NOT NULL,          -- 'website', an ad platform, a directory, a title
  reference    text,                   -- URL, campaign id, or commit SHA
  snapshot_url text,                   -- a stored copy of what ran
  recorded_by  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX advertising_log_published ON advertising_log (published_on DESC);

CREATE TRIGGER trg_advertising_log_append_only
  BEFORE UPDATE OR DELETE ON advertising_log
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- ---------------------------------------------------------------------------
-- § 9.5 Nurse disclosure tracking, and the status gate
-- ---------------------------------------------------------------------------

ALTER TABLE disclosures
  ADD COLUMN nurse_disclosure_required  boolean NOT NULL DEFAULT false,
  ADD COLUMN nurse_disclosure_sent_on   date,
  ADD COLUMN nurse_disclosure_method    text,
  ADD COLUMN complaint_contacts_sent_on date,
  ADD COLUMN statutory_version          text NOT NULL DEFAULT 'v1';

-- The existing guard allowed only written_sent_on and written_method to change. Extend
-- it: the nurse fields are settable once and then immutable, same as the written ones.
CREATE OR REPLACE FUNCTION disclosure_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'disclosures are permanent records and cannot be deleted';
  END IF;

  IF (NEW.case_id, NEW.disclosed_to, NEW.disclosed_by, NEW.method,
      NEW.disclosed_at, NEW.written_due_on, NEW.timeline_id,
      NEW.nurse_disclosure_required, NEW.statutory_version)
     IS DISTINCT FROM
     (OLD.case_id, OLD.disclosed_to, OLD.disclosed_by, OLD.method,
      OLD.disclosed_at, OLD.written_due_on, OLD.timeline_id,
      OLD.nurse_disclosure_required, OLD.statutory_version) THEN
    RAISE EXCEPTION
      'disclosure record is immutable; only the delivery fields may be set';
  END IF;

  -- Settable once. A delivery date that can be moved is not evidence of a delivery.
  IF OLD.written_sent_on IS NOT NULL AND NEW.written_sent_on IS DISTINCT FROM OLD.written_sent_on THEN
    RAISE EXCEPTION 'written_sent_on has already been recorded and cannot be changed';
  END IF;
  IF OLD.nurse_disclosure_sent_on IS NOT NULL
     AND NEW.nurse_disclosure_sent_on IS DISTINCT FROM OLD.nurse_disclosure_sent_on THEN
    RAISE EXCEPTION 'nurse_disclosure_sent_on has already been recorded and cannot be changed';
  END IF;
  IF OLD.complaint_contacts_sent_on IS NOT NULL
     AND NEW.complaint_contacts_sent_on IS DISTINCT FROM OLD.complaint_contacts_sent_on THEN
    RAISE EXCEPTION 'complaint_contacts_sent_on has already been recorded and cannot be changed';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- A nursing case cannot go active until the residence disclosure has gone out. This is
-- the § 1812.533(b)(4) timing, and it is a gate rather than a reminder because the
-- statute's deadline is "before they are under the care of any nursing personnel" —
-- a date that passes silently if nothing blocks on it.
CREATE OR REPLACE FUNCTION assert_nurse_disclosure() RETURNS trigger AS $$
DECLARE needed boolean; sent date;
BEGIN
  IF NEW.status = 'active'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    SELECT d.nurse_disclosure_required, d.nurse_disclosure_sent_on INTO needed, sent
      FROM disclosures d
     WHERE d.case_id = NEW.id
     ORDER BY d.disclosed_at DESC
     LIMIT 1;
    IF coalesce(needed, false) AND sent IS NULL THEN
      RAISE EXCEPTION
        'Case % cannot start: nurses'' registry disclosure not yet delivered to the patient',
        NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_nurse_disclosure
  BEFORE INSERT OR UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION assert_nurse_disclosure();

-- ---------------------------------------------------------------------------
-- § 5 Rate ranges — operator-maintained, queried by the marketing pages.
--
-- Never written into page content: a published rate that has drifted from reality is
-- both a conversion problem and, under § 1812.533(b)(1), a misleading-advertising one.
-- ---------------------------------------------------------------------------

CREATE TABLE rate_ranges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_key      text NOT NULL,
  credential_level text NOT NULL CHECK (
    credential_level IN ('companion','hca','cna','lvn','rn')),
  low              numeric(6,2) NOT NULL CHECK (low > 0),
  high             numeric(6,2) NOT NULL,
  effective_from   date NOT NULL,
  note             text,
  UNIQUE (service_key, credential_level, effective_from),
  CONSTRAINT rate_range_ordered CHECK (high >= low)
);

-- ---------------------------------------------------------------------------
-- § 1812.530 — no registration fee of any kind may be charged to a nurse.
-- I6 already says the referral fee is charged to the household. This is the nurses'
-- chapter saying it again, more absolutely, so there is nowhere a provider-side charge
-- could be recorded even by accident.
-- ---------------------------------------------------------------------------

DO $$
DECLARE offending text;
BEGIN
  SELECT string_agg(table_name || '.' || column_name, ', ')
    INTO offending
    FROM information_schema.columns
   WHERE table_schema = current_schema()
     AND (column_name LIKE '%provider_fee%'
       OR column_name LIKE '%registration_fee%'
       OR column_name LIKE '%provider_charge%');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      'A provider-side charge column exists (%), which § 1812.530 forbids outright',
      offending;
  END IF;
END $$;

-- RLS for the new tables: operator only, same default as everything else.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'assignment_log','fee_schedules','fee_schedule_deliveries','advertising_log','rate_ranges'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY operator_all ON %I FOR ALL USING (is_operator()) WITH CHECK (is_operator())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO ccn_app', t);
  END LOOP;
END $$;

-- A provider may read the fee schedule posted to them, and only that. § 1812.527.
CREATE POLICY fee_schedules_provider_select ON fee_schedules
  FOR SELECT USING (
    current_role_name() = 'provider'
    AND EXISTS (
      SELECT 1 FROM fee_schedule_deliveries d
       WHERE d.schedule_id = fee_schedules.id AND d.provider_id = current_provider()));

CREATE POLICY fee_schedule_deliveries_provider_select ON fee_schedule_deliveries
  FOR SELECT USING (
    current_role_name() = 'provider' AND provider_id = current_provider());
