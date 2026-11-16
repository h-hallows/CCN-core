-- The advertising record starts being written. Civil Code § 1812.533(c), spec § 9.4.
--
-- "Every nurses' registry shall maintain a record of all advertisements, correlated to
-- show the date and the publication in which the advertisement appeared, retrospectively
-- for a period of one year."
--
-- `advertising_log` was created in migration 0004 and nothing has ever inserted into it.
-- That is the second table in this schema found in that state, three weeks after the
-- assignment log; the note at the head of 0023 on why a present and empty register is
-- worse than an absent one applies here word for word.
--
-- But this one is also the wrong SHAPE, which the assignment log was not. It has a
-- single `published_on` date. The only publication this registry has is a website, and a
-- website does not appear on a date — it runs, continuously, until something replaces
-- it. Asked what was advertised on the third of March and where, a table of single dates
-- cannot answer, and answering that is the whole of what § 1812.533(c) is for. So an
-- entry gets an interval: it appeared from a date, and it appeared until a date or it is
-- still appearing.
--
-- THE ONE PERMITTED MUTATION. An advertisement coming down is new information about a
-- fact, not a correction of a record, so closing an entry sets `appeared_to` in place
-- rather than writing a second row. The trigger permits exactly that transition and
-- nothing else, and it checks the rest of the row by comparing it whole rather than
-- column by column — a column added later is then covered by default instead of being
-- silently mutable until someone remembers to extend a list. Corrections work as they do
-- in the assignment log: a new entry that says what the old one should have said and
-- points at it.
--
-- WHAT THE RECORD REFUSES TO DESCRIBE. § 1812.533(b)(2) requires the registry's correct
-- name and either its street address or its correct telephone number in every
-- advertisement. An entry must therefore say which name and which contact the
-- advertisement carried, and the check below refuses a placeholder. Today this
-- deployment serves PENDING_LEGAL_NAME and "Telephone pending", because the trading name
-- is with counsel under HSC § 1726(b), 22 CCR § 74600(b) and § 1812.533(b)(4). So the
-- record cannot describe an advertisement carrying them — and since the record is
-- mandatory, an advertisement that cannot be recorded is one that cannot lawfully run.
-- The refusal arrives at the only moment it is still cheap.
--
-- NOTHING IS EVER PRUNED. "Retrospectively for a period of one year" is a floor on how
-- far back the record must reach, not a retention schedule. The two read alike until
-- somebody writes a job that deletes rows at 366 days, which satisfies the misreading
-- and breaches the section the first time an inspector asks about thirteen months ago.
-- DELETE is refused here and `tests/advertising.test.ts` refuses one appearing in source.

-- ---------------------------------------------------------------------------
-- The medium vocabulary, and the interval.
-- ---------------------------------------------------------------------------

-- This migration rewrites the table's shape on the assumption that it holds nothing,
-- which is true of every deployment because nothing has ever written to it. Said out
-- loud rather than assumed: a NOT NULL column added to rows that exist would fail
-- confusingly, and a silent default would invent the two facts § 1812.533(b)(2) is about.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM advertising_log) THEN
    RAISE EXCEPTION
      'advertising_log is not empty, and this migration adds columns that cannot be '
      'defaulted without inventing what an advertisement carried. Back-fill by hand.';
  END IF;
END $$;

CREATE TYPE ad_medium AS ENUM (
  -- Continuous: it advertises on every day it is up, so its entry may stay open.
  'website', 'directory', 'paid_search', 'paid_social', 'social_profile', 'signage',
  -- Dated: it appeared and was over. Its entry closes on the day it opened.
  'print', 'broadcast', 'mail'
);

ALTER TABLE advertising_log RENAME COLUMN published_on TO appeared_from;
ALTER INDEX advertising_log_published RENAME TO advertising_log_appeared_from;

ALTER TABLE advertising_log
  ADD COLUMN medium          ad_medium NOT NULL,
  ADD COLUMN appeared_to     date,
  ADD COLUMN carried_name    text NOT NULL,
  ADD COLUMN carried_contact text NOT NULL,
  ADD COLUMN content_hash    text,
  ADD COLUMN corrects_id     uuid REFERENCES advertising_log(id),
  ADD COLUMN correction_note text;

-- 0024's rule. The register walks correction chains.
CREATE INDEX advertising_log_corrects_idx ON advertising_log (corrects_id);

-- ---------------------------------------------------------------------------
-- What an entry may say.
-- ---------------------------------------------------------------------------

ALTER TABLE advertising_log
  -- An advertisement cannot stop appearing before it started.
  ADD CONSTRAINT advertising_log_interval
    CHECK (appeared_to IS NULL OR appeared_to >= appeared_from),

  -- A dated medium is over on the day it ran, so leaving its entry open would claim it
  -- is still appearing in an issue from February. A continuous one may be open or closed.
  --
  -- The IS NOT NULL is the whole of it. `false OR (NULL = date)` is NULL, and a CHECK
  -- passes on NULL because NULL is not false — so the first version of this constraint
  -- accepted exactly the row it was written to refuse: a print advertisement with no end
  -- date. Three-valued logic turns a constraint into a comment unless every disjunct is
  -- made to decide.
  ADD CONSTRAINT advertising_log_dated_media_close
    CHECK (
      medium IN ('website','directory','paid_search','paid_social','social_profile','signage')
      OR (appeared_to IS NOT NULL AND appeared_to = appeared_from)),

  -- § 1812.533(b)(2), recorded rather than assumed. Neither field may be blank, and
  -- neither may be the sentinel this codebase serves while the name is unfiled. See
  -- src/domain/advertising.ts: the TypeScript check is wider and friendlier, and this is
  -- the one that holds against a script.
  ADD CONSTRAINT advertising_log_contact_line
    CHECK (
      btrim(carried_name) <> '' AND btrim(carried_contact) <> ''
      -- '%PENDING%' rather than the sentinel's exact 'PENDING_' prefix: the contact
      -- line this deployment serves today is the prose "Telephone pending", and
      -- matching only the underscore form would wave through the one string this check
      -- exists to catch.
      AND upper(carried_name)    NOT LIKE '%PENDING%'
      AND upper(carried_contact) NOT LIKE '%PENDING%'),

  -- A correction says what was wrong with the entry it replaces. Same rule as the
  -- assignment log: an unexplained replacement is indistinguishable from a second
  -- advertisement nobody can account for.
  ADD CONSTRAINT advertising_log_correction_note
    CHECK (corrects_id IS NULL OR btrim(coalesce(correction_note, '')) <> ''),

  -- A correction cannot correct itself.
  ADD CONSTRAINT advertising_log_correction_not_self
    CHECK (corrects_id IS NULL OR corrects_id <> id);

-- One open entry per publication. Two concurrent website advertisements of the same site
-- is not a thing that can be true, and recording it would make the trailing-year
-- coverage double-count the days they overlap.
CREATE UNIQUE INDEX advertising_log_one_open_per_publication
  ON advertising_log (medium, publication) WHERE appeared_to IS NULL AND corrects_id IS NULL;

-- ---------------------------------------------------------------------------
-- Append-only, with one exception.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION deny_mutation_except_withdrawal() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'append-only: DELETE on % is not permitted. Civil Code 1812.533(c) requires the '
      'record to reach back one year, which is a floor and not a retention schedule',
      TG_TABLE_NAME;
  END IF;

  -- The one permitted change: an advertisement that was running stops. Compared as whole
  -- rows with that single key removed, so a column added to this table in a later
  -- migration is immutable by default rather than until somebody extends a list.
  IF OLD.appeared_to IS NULL AND NEW.appeared_to IS NOT NULL
     AND (to_jsonb(NEW) - 'appeared_to') = (to_jsonb(OLD) - 'appeared_to') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'append-only: the only UPDATE permitted on % is closing an open entry by setting '
    'appeared_to. Correct an entry by recording a new one that points at it',
    TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

DROP TRIGGER trg_advertising_log_append_only ON advertising_log;

CREATE TRIGGER trg_advertising_log_append_only
  BEFORE UPDATE OR DELETE ON advertising_log
  FOR EACH ROW EXECUTE FUNCTION deny_mutation_except_withdrawal();

-- ---------------------------------------------------------------------------
-- The record is readable, so it is an audited entity.
--
-- It holds nothing about a household or a provider — it is what this business said about
-- itself in public — but § 3.8 asks who looked at a statutory register, and who checked
-- the advertising record before an inspection is a fact worth having. Dropped and
-- re-added rather than widened, for the reason 0021 gives.
-- ---------------------------------------------------------------------------

ALTER TABLE audit_log DROP CONSTRAINT audit_log_entity_vocabulary;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_entity_vocabulary CHECK (entity IN (
    'advertisement', 'assignment', 'audit_log', 'case', 'compliance', 'consent',
    'credential', 'credential_submission', 'disclosure', 'disclosure_log_export',
    'document', 'fee_schedule', 'fee_schedule_delivery', 'household', 'inquiry',
    'operator_session', 'provider', 'provider_application', 'published_shortlist',
    'referral', 'referral_feedback', 'referral_partner', 'service_failure',
    'shortlist_request', 'timeline_entry', 'today', 'unattributed_referral', 'user'
  )) NOT VALID;
