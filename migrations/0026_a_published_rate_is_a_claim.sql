-- The published rate bands become a record. Civil Code § 1812.533(b)(1), spec § 5.
--
-- `rate_ranges` was created in migration 0004 and written by the seed. Nothing else has
-- ever touched it — so the bands on the public pricing page, which say what care costs
-- on the Westside, have been demonstration data that no screen could correct.
--
-- That is a different failure from the two empty registers found this month, and in one
-- way a worse one. An empty table says nothing; this table has been saying something, to
-- the public, in the registry's name, and § 1812.533(b)(1) prohibits publishing false or
-- misleading information. A band nobody can maintain is a band that will eventually be
-- wrong, and the drift is invisible from inside the console because the console never
-- showed it.
--
-- Two things are needed before an operator can be given the screen.
--
-- PROVENANCE. A band is an advertising claim, so the record has to say who made it. The
-- table recorded what was claimed and from when, and not who said so or when they said
-- it — and `effective_from` alone cannot distinguish a band posted in March for April
-- from one written last night and dated March.
--
-- APPEND-ONLY. A band is posted and superseded, never amended. The public query reads
-- the newest row per service and level whose `effective_from` has arrived, so a
-- correction is a new row dated today and a planned change is a new row dated ahead.
-- Editing one in place would make `effective_from` a claim rather than a record of what
-- the page said and when, which is the only thing that can answer the question
-- afterwards.

-- ---------------------------------------------------------------------------
-- Who published this, and when.
-- ---------------------------------------------------------------------------

-- The seeded rows predate the column and have no honest author. 'seed' is the truth
-- about them: nobody posted them, a fixture wrote them. The default is dropped
-- immediately afterwards so that every row written from here on has to name somebody.
ALTER TABLE rate_ranges
  ADD COLUMN posted_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN posted_by text NOT NULL DEFAULT 'seed';

ALTER TABLE rate_ranges ALTER COLUMN posted_by DROP DEFAULT;

ALTER TABLE rate_ranges
  ADD CONSTRAINT rate_ranges_posted_by_named CHECK (btrim(posted_by) <> '');

-- ---------------------------------------------------------------------------
-- A band is quoted for a kind of care.
-- ---------------------------------------------------------------------------

-- The same seven values as `care_type`. Written out rather than read from the enum
-- because a CHECK must be immutable and `enum_range` is only stable;
-- `tests/rates.test.ts` fails if this list and the enum part company.
--
-- NOT VALID, because the constraint is about what may be written from here on and the
-- seeded rows are history. They happen to satisfy it.
ALTER TABLE rate_ranges
  ADD CONSTRAINT rate_ranges_service_vocabulary CHECK (service_key IN (
    'companion', 'personal_care', 'skilled_nursing', 'post_surgical',
    'overnight_newborn', 'respite', 'hospice_support'
  )) NOT VALID;

-- ---------------------------------------------------------------------------
-- Posted and superseded, never amended.
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_rate_ranges_append_only
  BEFORE UPDATE OR DELETE ON rate_ranges
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- The public page reads the newest row per service and level whose date has arrived, and
-- the console reads the same thing plus what is coming. Both are this index.
CREATE INDEX IF NOT EXISTS rate_ranges_in_force
  ON rate_ranges (service_key, credential_level, effective_from DESC);

-- ---------------------------------------------------------------------------
-- The bands are readable, so they are an audited entity.
--
-- Not about a person — it is what this business told the public that care costs — but
-- § 3.8 asks who looked at a statutory record, and a band is the kind of claim somebody
-- will later ask when it changed and on whose say-so. Dropped and re-added rather than
-- widened, for the reason 0021 gives.
-- ---------------------------------------------------------------------------

ALTER TABLE audit_log DROP CONSTRAINT audit_log_entity_vocabulary;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_entity_vocabulary CHECK (entity IN (
    'advertisement', 'assignment', 'audit_log', 'case', 'compliance', 'consent',
    'credential', 'credential_submission', 'disclosure', 'disclosure_log_export',
    'document', 'fee_schedule', 'fee_schedule_delivery', 'household', 'inquiry',
    'operator_session', 'provider', 'provider_application', 'published_shortlist',
    'rate_band', 'referral', 'referral_feedback', 'referral_partner',
    'service_failure', 'shortlist_request', 'timeline_entry', 'today',
    'unattributed_referral', 'user'
  )) NOT VALID;
