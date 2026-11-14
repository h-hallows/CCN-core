-- The audit log's `entity` is a closed vocabulary, enforced here.
--
-- § 3.8 exists so that "who looked at this household" has an answer. It had none. The
-- column is free text, every call site chose its own words, and the result was rows
-- saying `document` beside rows saying `documents`, `case` beside `cases`. A query for
-- either silently missed the other, which is the worst shape this can take: the screen
-- shows a short, clean history for a household that was read all afternoon.
--
-- NOT VALID, DELIBERATELY. The rows already written are the drift. `audit_log` is
-- append-only — trg_audit_append_only refuses UPDATE and DELETE — and that is the
-- property that makes it evidence rather than a note. A migration that normalised those
-- rows would have to disable the trigger, which is precisely the thing the table exists
-- to prevent. So history stays exactly as it was written, the constraint binds every
-- row inserted from here on, and the read side translates the old names
-- (AUDIT_ENTITY_ALIASES in @h-hallows/core/domain) rather than rewriting them.
--
-- The list is duplicated from src/domain/audit.ts on purpose: TypeScript stops a call
-- site inventing a name, the database stops anything that is not a call site. A test
-- asserts the two lists are identical, so they cannot drift apart.

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_entity_vocabulary CHECK (entity IN (
    'audit_log', 'case', 'compliance', 'consent', 'credential',
    'credential_submission', 'disclosure', 'disclosure_log_export', 'document',
    'fee_schedule', 'fee_schedule_delivery', 'household', 'inquiry',
    'operator_session', 'provider', 'provider_application', 'published_shortlist',
    'referral', 'referral_feedback', 'referral_partner', 'shortlist_request',
    'timeline_entry', 'today', 'unattributed_referral', 'user'
  )) NOT VALID;

-- Reading the log is itself a read of identifiable data, so the audit screen writes its
-- own row. That makes `actor` the most-queried column on the table by far once anyone
-- starts asking who has been looking at what.
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor, at DESC);
