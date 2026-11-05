-- A provider submits a document. A provider does not verify themselves.
-- Web build spec § 4.2, milestone W8.
--
-- WHAT WAS WRONG. Migration 0003 granted providers INSERT on `credentials`:
--
--   CREATE POLICY credentials_provider_insert ON credentials
--     FOR INSERT WITH CHECK (current_role_name() = 'provider'
--                            AND provider_id = current_provider());
--
-- and `eligibility()` in @h-hallows/core treats the PRESENCE of a row of the required
-- type as that requirement being satisfied. Those two facts together mean a provider
-- could make themselves eligible for referral by inserting a row. Demonstrated against
-- the seed before this migration was written: an LVN missing a Live Scan inserted
--
--   (provider_id, type, verified_on, verified_by, verification_source)
--   ('…', 'live_scan', current_date, 'me', 'I checked it myself')
--
-- and went from ineligible to eligible — which is to say, onto a household's shortlist,
-- with no background check. That is I12 ("no override exists, for any role") broken by
-- the role the invariant most exists to constrain, and it is the diligence story this
-- registry sells.
--
-- It had not been exploited because nothing provider-facing had been built yet. W8 is
-- the milestone that would have shipped it. The NOT NULL on verified_on, verified_by
-- and verification_source made a NAIVE insert fail, which is what disguised it; a
-- deliberate one supplies them.
--
-- THE FIX. A provider uploads into a submissions table that eligibility never reads.
-- An operator checks it against the issuing body and creates the `credentials` row.
-- That is what the console's copy already promises — "We verify each credential against
-- the issuing source and record the expiry" — and what 0003's own comment said was
-- happening: "They upload, the operator verifies."
--
-- Keeping a column guard on `credentials` instead was the alternative. It is weaker: it
-- leaves the provider able to create the row at all, and every future column has to be
-- remembered. A table a provider can write and nothing trusts needs no such memory.

DROP POLICY IF EXISTS credentials_provider_insert ON credentials;

-- ---------------------------------------------------------------------------
-- What a provider may send us.
--
-- Deliberately NOT a credential. No expiry, no verified_on, no verification_source,
-- no verified_by: none of those are facts a provider is in a position to assert, and
-- the point of this table is that it holds only what they are.
-- ---------------------------------------------------------------------------

CREATE TYPE credential_submission_state AS ENUM ('submitted', 'accepted', 'rejected');

CREATE TABLE credential_submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   uuid NOT NULL REFERENCES providers(id),
  type          credential_type NOT NULL,
  -- The provider's own reference, e.g. a licence number as they have it. Checked
  -- against the issuing body by the operator; believed by nobody until then.
  identifier    text,
  document_url  text,
  note          text,
  submitted_at  timestamptz NOT NULL DEFAULT now(),

  -- Operator-only from here down.
  state         credential_submission_state NOT NULL DEFAULT 'submitted',
  reviewed_at   timestamptz,
  reviewed_by   text,
  review_note   text,
  -- Set when the operator accepts it and creates the real row, so the audit trail runs
  -- from what was handed in to what was verified.
  credential_id uuid REFERENCES credentials(id),

  CONSTRAINT submission_reviewed_has_reviewer CHECK (
    (state = 'submitted' AND reviewed_at IS NULL AND reviewed_by IS NULL)
    OR (state <> 'submitted' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
  ),
  CONSTRAINT submission_accepted_has_credential CHECK (
    (state = 'accepted' AND credential_id IS NOT NULL)
    OR (state <> 'accepted' AND credential_id IS NULL)
  )
);

CREATE INDEX credential_submissions_pending
  ON credential_submissions (submitted_at DESC) WHERE state = 'submitted';
CREATE INDEX credential_submissions_provider
  ON credential_submissions (provider_id, submitted_at DESC);

ALTER TABLE credential_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_submissions FORCE ROW LEVEL SECURITY;

CREATE POLICY credential_submissions_operator_all ON credential_submissions
  FOR ALL USING (is_operator()) WITH CHECK (is_operator());

CREATE POLICY credential_submissions_provider_select ON credential_submissions
  FOR SELECT USING (
    current_role_name() = 'provider' AND provider_id = current_provider()
  );

-- Insert only, and only in the 'submitted' state with no review attached. A provider
-- cannot hand in something that claims to have already been checked.
CREATE POLICY credential_submissions_provider_insert ON credential_submissions
  FOR INSERT WITH CHECK (
    current_role_name() = 'provider'
    AND provider_id = current_provider()
    AND state = 'submitted'
    AND reviewed_at IS NULL
    AND reviewed_by IS NULL
    AND credential_id IS NULL
  );

-- No provider UPDATE and no DELETE. What was handed in is a record of what was handed
-- in; a submission that can be edited after review is not one.

GRANT SELECT, INSERT, UPDATE ON credential_submissions TO ccn_app;
