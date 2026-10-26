-- CCN Registry OS — initial schema
-- Spec § 3. Every timestamp is timestamptz; every date that is a date is `date`.
-- All expiry comparison happens in America/Los_Angeles (lib/domain/credentials.ts).

-- ---------------------------------------------------------------------------
-- § 3.1 Enums
-- ---------------------------------------------------------------------------

CREATE TYPE provider_type   AS ENUM ('RN','LVN','CNA','HCA','companion');
CREATE TYPE provider_status AS ENUM ('active','inactive','do_not_refer');
CREATE TYPE credential_type AS ENUM (
  'rn_license','lvn_license','cna_cert','hca_registry','live_scan',
  'tb_clearance','cpr_bls','auto_insurance','drivers_license','immunization','other');
CREATE TYPE care_type       AS ENUM (
  'companion','personal_care','skilled_nursing','post_surgical',
  'overnight_newborn','respite','hospice_support');
CREATE TYPE case_status     AS ENUM ('inquiry','matching','referred','active','paused','ended');
CREATE TYPE urgency         AS ENUM ('discharge','same_day','next_day','routine');
CREATE TYPE payment_method  AS ENUM ('private','ltc_policy','va','other');
CREATE TYPE timeline_type   AS ENUM (
  'inquiry','call','note','shortlist','referral','disclosure',
  'written_disclosure','schedule_change','document','status_change');

-- I4: deliberately no 'registry'. The registry cannot end a relationship.
CREATE TYPE ended_by        AS ENUM ('household','provider','mutual');

CREATE TYPE shift_block     AS ENUM ('AM','PM','NOC');   -- 07-15, 15-23, 23-07

-- § 8: end_reason must be a required field with a fixed option list. As free text it
-- will be left blank, and the number that matters most will not exist. One option has
-- to be the direct-arrangement case — that is the leakage measure.
CREATE TYPE end_reason AS ENUM (
  'moved_to_direct_arrangement',
  'care_no_longer_needed',
  'hospitalized',
  'moved_to_facility',
  'deceased',
  'cost',
  'household_dissatisfied',
  'provider_unavailable',
  'moved_to_another_agency',
  'other');

CREATE TYPE referral_outcome AS ENUM (
  'engaged','declined_by_household','declined_by_provider','no_response');

-- ---------------------------------------------------------------------------
-- § 3.8 Partners and users (created first: households references partners)
-- ---------------------------------------------------------------------------

CREATE TABLE referral_partners (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  org        text,
  role       text,
  phone      text,
  email      text,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text UNIQUE NOT NULL,
  display_name text NOT NULL,
  role         text NOT NULL DEFAULT 'operator',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Email magic link. Single-use, short-lived, hash stored rather than the token.
CREATE TABLE auth_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- § 3.2 Providers and credentials
-- ---------------------------------------------------------------------------

CREATE TABLE providers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status           provider_status NOT NULL DEFAULT 'active',
  full_name        text NOT NULL,
  preferred_name   text,
  phone            text,
  email            text,
  photo_url        text,                           -- consent-gated; null until consent recorded
  photo_consent_on date,
  type             provider_type NOT NULL,
  license_number   text,
  license_state    text DEFAULT 'CA',
  rate_hourly      numeric(6,2),                   -- provider-set, no default (I5)
  rate_notes       text,
  transports       boolean NOT NULL DEFAULT false,
  areas            text[] NOT NULL DEFAULT '{}',
  max_travel_min   int,
  availability     text[] NOT NULL DEFAULT '{}',   -- 'Mon:AM' .. 'Sun:NOC'
  restrictions     text,                           -- provider-stated (b)(2)
  specialties      text[] NOT NULL DEFAULT '{}',
  languages        text[] NOT NULL DEFAULT '{}',
  notes            text,
  agreement_signed_on   date,                      -- (b)(1)
  written_notice_ack_on date,                      -- (d)
  work_auth_verified_on date,                      -- (e)
  orientation_on        date,                      -- voluntary, admin procedures only (I1)
  deleted_at       timestamptz,                    -- soft delete only
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT providers_photo_requires_consent
    CHECK (photo_url IS NULL OR photo_consent_on IS NOT NULL)
);

CREATE INDEX providers_status_idx ON providers(status) WHERE deleted_at IS NULL;
CREATE INDEX providers_type_idx   ON providers(type)   WHERE deleted_at IS NULL;
CREATE INDEX providers_areas_idx  ON providers USING gin(areas);

CREATE TABLE credentials (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id         uuid NOT NULL REFERENCES providers(id),
  type                credential_type NOT NULL,
  identifier          text,
  issued_on           date,
  expires_on          date,                        -- NULL = non-expiring
  verified_on         date NOT NULL,
  verified_by         text NOT NULL,
  verification_source text NOT NULL,
  document_url        text,
  notes               text,
  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Spec § 3.2 writes this as UNIQUE (provider_id, type). With soft deletes that would
-- permanently block re-adding a credential someone removed by mistake, so it is a
-- partial unique index over live rows instead. History lives in credential_events.
CREATE UNIQUE INDEX credentials_one_live_per_type
  ON credentials (provider_id, type) WHERE deleted_at IS NULL;

CREATE INDEX credentials_provider_idx ON credentials(provider_id) WHERE deleted_at IS NULL;
CREATE INDEX credentials_expiry_idx   ON credentials(expires_on)  WHERE deleted_at IS NULL;

CREATE TABLE credential_events (                   -- append-only renewal history
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id    uuid NOT NULL REFERENCES credentials(id),
  at               timestamptz NOT NULL DEFAULT now(),
  actor            text NOT NULL,
  prev_expires_on  date,
  new_expires_on   date,
  prev_verified_on date,
  new_verified_on  date,
  note             text
);

CREATE INDEX credential_events_cred_idx ON credential_events(credential_id, at DESC);

-- ---------------------------------------------------------------------------
-- § 3.4 Households and cases
-- ---------------------------------------------------------------------------

CREATE TABLE households (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name    text NOT NULL,
  status          text NOT NULL DEFAULT 'inquiry',
  dm_name         text NOT NULL,                   -- the person engaging care
  dm_relationship text,
  dm_phone        text,
  dm_email        text,
  dm_location     text,                            -- often not local
  dm_timezone     text,                            -- keep their timezone legible
  cr_name         text,
  cr_age          int,
  cr_area         text NOT NULL,                   -- matched against providers.areas
  cr_address      text,
  cr_access_notes text,
  payment_method  payment_method NOT NULL DEFAULT 'private',
  ltc_carrier     text,
  ltc_policy_number text,
  physician_name  text,
  physician_practice text,
  physician_phone text,
  physician_fax   text,
  nda_on_file     boolean NOT NULL DEFAULT false,
  source          text,
  partner_id      uuid REFERENCES referral_partners(id),
  blocked_provider_ids uuid[] NOT NULL DEFAULT '{}',  -- household asked not to be referred these
  notes           text,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id   uuid NOT NULL REFERENCES households(id),
  status         case_status NOT NULL DEFAULT 'inquiry',
  care           care_type NOT NULL,
  urgency        urgency NOT NULL DEFAULT 'routine',

  -- I10: the household's own words. No generation endpoint exists.
  needs_profile  text,
  needs_authored_by text NOT NULL DEFAULT 'household'
                 CHECK (needs_authored_by = 'household'),

  adl_needs      text[] NOT NULL DEFAULT '{}',
  schedule       text[] NOT NULL DEFAULT '{}',     -- same 'Day:BLOCK' vocabulary
  hours_per_week int,
  starts_on      date,
  ends_on        date,
  expected_weeks int,
  rate_agreed    numeric(6,2),

  -- I6: fixed percentage of job cost, charged to the household. Never a provider deduction.
  fee_pct        numeric(5,2),
  fee_charged_to text NOT NULL DEFAULT 'household'
                 CHECK (fee_charged_to = 'household'),

  rate_band_low  numeric(6,2),
  rate_band_high numeric(6,2),
  language_pref  text,
  primary_provider_id    uuid REFERENCES providers(id),
  alternate_provider_ids uuid[] NOT NULL DEFAULT '{}',   -- target 2
  household_profile text,                          -- routine/access/preferences; travels to substitutes
  referred_on    date,
  written_due_on date,                             -- 3 CA business days from referred_on
  written_sent_on date,
  ended_on       date,
  ended_by       ended_by,                         -- no 'registry' (I4)
  end_reason     end_reason,                       -- fixed option list (§ 8)
  end_reason_note text,
  deleted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- § 8: both fields are required once an engagement has ended, or leakage is unmeasurable.
  CONSTRAINT cases_ended_requires_reason CHECK (
    status <> 'ended'
    OR (ended_by IS NOT NULL AND end_reason IS NOT NULL AND ended_on IS NOT NULL)
  )
);

CREATE INDEX cases_status_idx    ON cases(status) WHERE deleted_at IS NULL;
CREATE INDEX cases_household_idx ON cases(household_id);

-- I11: a skilled case cannot be referred without a physician of record.
CREATE OR REPLACE FUNCTION assert_physician_for_skilled() RETURNS trigger AS $$
DECLARE phys text;
BEGIN
  -- Fire only on a TRANSITION into referred/active. Firing on every update would
  -- permanently lock any imported or legacy skilled case that lacks a physician:
  -- the record could never be edited again, including to add the physician.
  IF NEW.care IN ('skilled_nursing','post_surgical','hospice_support')
     AND NEW.status IN ('referred','active')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    SELECT physician_name INTO phys FROM households WHERE id = NEW.household_id;
    IF phys IS NULL OR btrim(phys) = '' THEN
      RAISE EXCEPTION
        'Skilled case % cannot be referred: no ordering physician on household record', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_physician_skilled
  BEFORE INSERT OR UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION assert_physician_for_skilled();

-- ---------------------------------------------------------------------------
-- § 3.5 Coverage gaps
--
-- BLOCKED SURFACE. The table exists so the schema accepts the feature later (§ 9),
-- but nothing in the application reads or writes it. Per § 0.5 item 2 the scheduling
-- and coverage surface waits for the nine-factor audit: "coordinate schedules" is the
-- exact activity § 1812.5095(b)(5) and § 687.2(e) constrain. See /DEFERRED.md.
--
-- Records confirmation only. No task attestation, ever (I2).
-- ---------------------------------------------------------------------------

CREATE TABLE coverage_gaps (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    uuid NOT NULL REFERENCES cases(id),
  on_date    date NOT NULL,
  block      shift_block NOT NULL,
  note       text,
  resolved_provider_id uuid REFERENCES providers(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- § 3.6 Timeline, disclosures, referrals — the compliance record.
-- Append-only at the database level, not just in the UI.
-- ---------------------------------------------------------------------------

CREATE TABLE timeline_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid REFERENCES cases(id),
  household_id uuid REFERENCES households(id),
  at           timestamptz NOT NULL DEFAULT now(),   -- server-set, never client-supplied
  type         timeline_type NOT NULL,
  author       text NOT NULL,
  body         text NOT NULL,
  provider_id  uuid REFERENCES providers(id),
  CHECK (case_id IS NOT NULL OR household_id IS NOT NULL)
);

CREATE INDEX timeline_case_idx      ON timeline_entries(case_id, at DESC);
CREATE INDEX timeline_household_idx ON timeline_entries(household_id, at DESC);

CREATE TABLE disclosures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         uuid NOT NULL REFERENCES cases(id),
  timeline_id     uuid NOT NULL REFERENCES timeline_entries(id),
  disclosed_to    text NOT NULL,
  disclosed_by    text NOT NULL,
  -- Counsel question 1 is open, so a live human channel is the only permitted method.
  method          text NOT NULL CHECK (method IN ('phone','in_person')),
  disclosed_at    timestamptz NOT NULL DEFAULT now(),
  written_due_on  date NOT NULL,
  written_sent_on date,
  written_method  text
);

CREATE INDEX disclosures_case_idx ON disclosures(case_id, disclosed_at DESC);
CREATE INDEX disclosures_written_due_idx ON disclosures(written_due_on) WHERE written_sent_on IS NULL;

CREATE TABLE referrals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES cases(id),
  provider_id   uuid NOT NULL REFERENCES providers(id),
  disclosure_id uuid NOT NULL REFERENCES disclosures(id),   -- I3: no referral without a disclosure
  referred_at   timestamptz NOT NULL DEFAULT now(),
  referred_by   text NOT NULL,
  outcome       referral_outcome,
  outcome_note  text,
  outcome_at    timestamptz
);

CREATE INDEX referrals_case_idx     ON referrals(case_id, referred_at DESC);
CREATE INDEX referrals_provider_idx ON referrals(provider_id, referred_at DESC);

-- Append-only enforcement
CREATE OR REPLACE FUNCTION deny_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on % is not permitted', TG_OP, TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tl_append_only
  BEFORE UPDATE OR DELETE ON timeline_entries
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TRIGGER trg_ref_append_only
  BEFORE DELETE ON referrals
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TRIGGER trg_cred_events_append_only
  BEFORE UPDATE OR DELETE ON credential_events
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- Referrals may be updated only to record an outcome. Nothing else ever changes.
CREATE OR REPLACE FUNCTION referral_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW.case_id, NEW.provider_id, NEW.disclosure_id, NEW.referred_at, NEW.referred_by)
     IS DISTINCT FROM
     (OLD.case_id, OLD.provider_id, OLD.disclosure_id, OLD.referred_at, OLD.referred_by) THEN
    RAISE EXCEPTION 'referral record is immutable; only outcome fields may be set';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_referral_guard
  BEFORE UPDATE ON referrals
  FOR EACH ROW EXECUTE FUNCTION referral_guard();

-- Disclosures: only the written follow-up fields may ever change.
CREATE OR REPLACE FUNCTION disclosure_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'disclosures are permanent records and cannot be deleted';
  END IF;
  IF (NEW.case_id, NEW.disclosed_to, NEW.disclosed_by, NEW.method,
      NEW.disclosed_at, NEW.written_due_on, NEW.timeline_id)
     IS DISTINCT FROM
     (OLD.case_id, OLD.disclosed_to, OLD.disclosed_by, OLD.method,
      OLD.disclosed_at, OLD.written_due_on, OLD.timeline_id) THEN
    RAISE EXCEPTION 'disclosure record is immutable; only written_sent_on and written_method may be set';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_disclosure_guard
  BEFORE UPDATE OR DELETE ON disclosures
  FOR EACH ROW EXECUTE FUNCTION disclosure_guard();

-- ---------------------------------------------------------------------------
-- § 3.7 Feedback — constrained by I7
-- ---------------------------------------------------------------------------

CREATE TABLE referral_feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id uuid NOT NULL REFERENCES referrals(id),
  at          timestamptz NOT NULL DEFAULT now(),
  -- Satisfaction with the REFERRAL SERVICE, per (b)(5)(B).
  referral_service_rating int CHECK (referral_service_rating BETWEEN 1 AND 5),
  would_refer_again boolean,
  notes       text,
  -- I7 / § 687.2(e): this record informs future referral decisions only.
  -- It must never drive provider discipline, coaching, training or corrective action.
  use_restriction text NOT NULL DEFAULT 'referral_decisions_only'
                  CHECK (use_restriction = 'referral_decisions_only')
);

CREATE INDEX referral_feedback_referral_idx ON referral_feedback(referral_id);

-- ---------------------------------------------------------------------------
-- § 3.8 Audit log
--
-- Audit every read as well as every write. The data is health-adjacent information
-- about private individuals in a discretion-first market; read logging is the thing
-- that answers "who looked at this household" later.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text NOT NULL,
  action     text NOT NULL CHECK (action IN ('read','create','update','soft_delete')),
  entity     text NOT NULL,
  entity_id  uuid,
  diff       jsonb,
  ip         text,
  user_agent text
);

CREATE INDEX audit_log_entity_idx ON audit_log(entity, entity_id, at DESC);
CREATE INDEX audit_log_at_idx     ON audit_log(at DESC);

CREATE TRIGGER trg_audit_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- ---------------------------------------------------------------------------
-- § 8 Instrumentation — write from day one.
-- One row per event. Keep it raw and derive later.
-- ---------------------------------------------------------------------------

CREATE TYPE metric_event AS ENUM (
  'inquiry_received','first_contact','shortlist_generated','referral_made',
  'engagement_started','engagement_ended','operator_session','credential_renewed',
  'service_failure','billed_hours_recorded');

CREATE TABLE metric_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event       metric_event NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  case_id     uuid REFERENCES cases(id),
  provider_id uuid REFERENCES providers(id),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX metric_events_event_idx ON metric_events(event, at DESC);
CREATE INDEX metric_events_case_idx  ON metric_events(case_id, at DESC);

CREATE TRIGGER trg_metric_append_only
  BEFORE UPDATE OR DELETE ON metric_events
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- § 8 capacity measure: active cases held concurrently WITHOUT a service failure.
-- A missed shift, an unanswered discharge call, a lapsed credential reaching a
-- household. Observable from the system, needs no timer. Self-reported time per case
-- is the first thing abandoned in any tool, and admin time rises for the first two or
-- three months while records are entered, so a time metric reads as failure exactly
-- when the tool is working.
CREATE TYPE service_failure_kind AS ENUM (
  'missed_shift','unanswered_discharge_call','lapsed_credential_reached_household',
  'no_eligible_provider_available','other');

CREATE TABLE service_failures (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    uuid NOT NULL REFERENCES cases(id),
  kind       service_failure_kind NOT NULL,
  on_date    date NOT NULL,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX service_failures_case_idx ON service_failures(case_id, on_date DESC);

-- § 8 leakage leading indicator: billed hours per case per month, as a series.
-- Leakage in home care rarely arrives as a cancellation. It arrives as a case quietly
-- reducing hours while the household shifts them to a direct hire and keeps the
-- registry for fill-in. That shows up monthly, not annually.
CREATE TABLE case_month_hours (
  case_id      uuid NOT NULL REFERENCES cases(id),
  month        date NOT NULL,                      -- first day of the month, LA
  billed_hours numeric(8,2) NOT NULL CHECK (billed_hours >= 0),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, month)
);

-- ---------------------------------------------------------------------------
-- Row level security on every table from the first migration, even with one operator.
--
-- The application sets `app.operator_id` on each connection (lib/db/client.ts). On a
-- hosted Postgres the app must connect as a NON-OWNER role, because a table owner
-- bypasses RLS. See README "Deploying".
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = current_schema()
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY operator_all ON %I FOR ALL
         USING (current_setting(''app.operator_id'', true) IS NOT NULL)
         WITH CHECK (current_setting(''app.operator_id'', true) IS NOT NULL)', t);
  END LOOP;
END $$;
