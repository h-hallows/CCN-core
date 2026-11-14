-- `service_failure` joins the audit vocabulary.
--
-- § 8 counts these to measure capacity: the question is whether the operator can hold
-- twelve concurrent cases where she held six WITHOUT one of these, which is the only
-- honest way to measure the tool's effect. A self-reported time metric would read as
-- failure for the first three months, while records are being entered and habits change.
--
-- But a row in `service_failures` is not only a denominator. It is the record of a day
-- somebody did not get the care they were expecting, named by case, and reading it is
-- reading identifiable information about that household. So it is an audited entity and
-- it sits in the household's span — a missed shift turns up when someone asks what
-- happened to this family, not only in a count on an instrumentation screen.
--
-- Dropped and re-added rather than widened, because Postgres has no ALTER CONSTRAINT for
-- a CHECK. NOT VALID again, for the reason 0021 gives: the rows already written are the
-- drift, the table is append-only because that is what makes it evidence, and a
-- migration that normalised them would have to disable the trigger the table exists for.

ALTER TABLE audit_log DROP CONSTRAINT audit_log_entity_vocabulary;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_entity_vocabulary CHECK (entity IN (
    'audit_log', 'case', 'compliance', 'consent', 'credential',
    'credential_submission', 'disclosure', 'disclosure_log_export', 'document',
    'fee_schedule', 'fee_schedule_delivery', 'household', 'inquiry',
    'operator_session', 'provider', 'provider_application', 'published_shortlist',
    'referral', 'referral_feedback', 'referral_partner', 'service_failure',
    'shortlist_request', 'timeline_entry', 'today', 'unattributed_referral', 'user'
  )) NOT VALID;

-- § 8 reads service failures by case and by month. Both go through the case.
CREATE INDEX IF NOT EXISTS service_failures_case_idx
  ON service_failures (case_id, on_date DESC);

-- And the leakage series is read per case, oldest first, for every open case at once.
CREATE INDEX IF NOT EXISTS case_month_hours_month_idx
  ON case_month_hours (month DESC);
