-- Every single-column foreign key gets a leading index.
--
-- Postgres indexes the REFERENCED side of a foreign key, because it has to — the target
-- is a primary or unique key. It indexes the referencing side not at all. That asymmetry
-- is the most reliably forgotten fact about the database, and it costs in three places
-- that do not look alike:
--
--   1. Reading. Every join from a child row to its parent, and every "find the children
--      of this row" — which is most of what the console's screens are.
--   2. Writing to the PARENT. Deleting or key-updating a referenced row makes Postgres
--      check the referencing table for survivors, and with no index that is a sequential
--      scan of the child table per parent row touched.
--   3. Row-level security. `household_users.household_id` is read by policy predicates,
--      which are evaluated per candidate row rather than once per query. An unindexed
--      column there is the slowest kind of unindexed column, and it was one.
--
-- Twenty-three of them, found by asking the live catalogue rather than reading the
-- migrations — `pg_constraint` joined to `pg_index`, which is also what the structural
-- test now does, so the next table added cannot quietly reintroduce the gap.
--
-- Nothing here changes behaviour, and at this size nothing here is observable: the
-- largest table in the database holds a few hundred rows. That is the argument for doing
-- it now. An index added while a table is small is a `CREATE INDEX` in a migration; the
-- same index added once the table matters is a lock held over a table somebody is
-- reading. The one cost is a little write amplification per insert, on tables whose
-- inserts are an operator typing.
--
-- Single-column keys only. A composite foreign key whose leading column is already
-- indexed is covered, and one that is not would want an index chosen rather than
-- generated — there are none in this schema today, and the test says so if that changes.

-- Sign-in and session handling. Every authenticated request reaches `sessions`, and
-- revoking access reaches both by user.
CREATE INDEX IF NOT EXISTS sessions_user_idx          ON sessions (user_id);
CREATE INDEX IF NOT EXISTS auth_tokens_user_idx       ON auth_tokens (user_id);

-- Portal membership. Read by RLS policies, per row, on every portal request.
CREATE INDEX IF NOT EXISTS household_users_household_idx ON household_users (household_id);
CREATE INDEX IF NOT EXISTS partner_users_partner_idx     ON partner_users (partner_id);
CREATE INDEX IF NOT EXISTS portal_invites_household_idx  ON portal_invites (household_id);
CREATE INDEX IF NOT EXISTS portal_invites_provider_idx   ON portal_invites (provider_id);
CREATE INDEX IF NOT EXISTS portal_invites_partner_idx    ON portal_invites (partner_id);

-- The referral record. `referrals.disclosure_id` is the I3 join — no referral without
-- the disclosure that authorised it — so it is followed on every read of a referral.
CREATE INDEX IF NOT EXISTS referrals_disclosure_idx   ON referrals (disclosure_id);
CREATE INDEX IF NOT EXISTS disclosures_timeline_idx   ON disclosures (timeline_id);
CREATE INDEX IF NOT EXISTS disclosures_written_statement_document_idx
  ON disclosures (written_statement_document_id);

-- The assignment log. § 1812.529 corrections form chains, and the register walks them.
CREATE INDEX IF NOT EXISTS assignment_log_corrects_idx ON assignment_log (corrects_id);

-- Intake. `ASSIGNMENT_LOG_INSERT` derives the hour an order arrived with a max() over
-- this column, inside the transaction that makes a nursing referral.
CREATE INDEX IF NOT EXISTS inquiries_household_idx    ON inquiries (household_id);
CREATE INDEX IF NOT EXISTS households_partner_idx     ON households (partner_id);
CREATE INDEX IF NOT EXISTS shortlist_requests_referral_idx ON shortlist_requests (referral_id);
CREATE INDEX IF NOT EXISTS shortlist_requests_requested_by_idx
  ON shortlist_requests (requested_by);

-- Credentials and the documents behind them. The vault screen joins all three.
CREATE INDEX IF NOT EXISTS credentials_document_idx   ON credentials (document_id);
CREATE INDEX IF NOT EXISTS credential_submissions_credential_idx
  ON credential_submissions (credential_id);
CREATE INDEX IF NOT EXISTS credential_submissions_document_idx
  ON credential_submissions (document_id);
CREATE INDEX IF NOT EXISTS provider_applications_provider_idx
  ON provider_applications (provider_id);

-- § 1812.527 deliveries, and the § 8 instrumentation.
CREATE INDEX IF NOT EXISTS fee_schedule_deliveries_schedule_idx
  ON fee_schedule_deliveries (schedule_id);
CREATE INDEX IF NOT EXISTS metric_events_provider_idx ON metric_events (provider_id);

-- Written by nothing yet. Indexed anyway, so the rule has no exceptions to remember —
-- an exception list is a thing somebody has to keep true.
CREATE INDEX IF NOT EXISTS testimonials_household_idx ON testimonials (household_id);
CREATE INDEX IF NOT EXISTS testimonials_consent_idx   ON testimonials (consent_id);
