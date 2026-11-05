-- A provider may read the timeline entries they wrote. Web build spec § 4.2, W9.
--
-- Migration 0003 gave a provider INSERT on `timeline_entries` — architecture spec § 6.4
-- records an opportunity answer as a note on the case, author = provider — and no
-- SELECT. So a provider could write their answer and never see it again, and neither
-- could the screen: /pro had no way to tell an answered opportunity from an unanswered
-- one. In practice that means the same opportunity is offered forever and two clicks
-- write two notes.
--
-- Scoped to entries they are the author of, NOT to the case's timeline. A case's
-- timeline carries the operator's notes, the household's circumstances, the calls and
-- the disclosures; none of that is a provider's to read, and `provider_id` is already
-- on the row because the insert policy requires it.
--
-- Still no UPDATE and no DELETE for anyone: `deny_mutation` on this table makes it
-- append-only regardless of role, which is what a timeline has to be to be worth
-- keeping.

CREATE POLICY timeline_provider_select_own ON timeline_entries
  FOR SELECT USING (
    current_role_name() = 'provider'
    AND provider_id = current_provider()
  );
