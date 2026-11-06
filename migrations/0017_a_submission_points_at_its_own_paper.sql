-- A submission may only point at a document the same provider filed.
--
-- 0015 added `credential_submissions.document_id` so that handing in a credential means
-- handing in the paper rather than a URL. `credential_submissions_provider_insert`
-- (0008) constrains the provider, the state and the review columns — and not that one.
--
-- So a provider could insert a submission naming ANY document id, and the operator's
-- review screen would open it: the submission row is written by the provider and read
-- by the console as "this is the paper for this submission". That is the write-to-read
-- pattern 0008, 0013 and 0014 each closed one instance of, arriving again through a
-- column added two migrations later. A deny-list of constrained columns is why: the new
-- column was unconstrained by default.
--
-- The check has to be SECURITY DEFINER. `documents` is behind RLS, and a provider's own
-- SELECT policy requires `visible_to_subject` — which their own insert is forbidden from
-- setting — so a plain EXISTS inside the policy would see nothing and refuse every
-- submission, including the legitimate ones.

CREATE OR REPLACE FUNCTION document_filed_by_provider(d uuid, pr uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
      SELECT 1 FROM documents
       WHERE id = d
         AND provider_id = pr
         AND kind = 'credential'
         AND redacted_at IS NULL);
  $$;

DROP POLICY IF EXISTS credential_submissions_provider_insert ON credential_submissions;

CREATE POLICY credential_submissions_provider_insert ON credential_submissions
  FOR INSERT WITH CHECK (
    current_role_name() = 'provider'
    AND provider_id = current_provider()
    AND state = 'submitted'
    AND reviewed_at IS NULL
    AND reviewed_by IS NULL
    AND credential_id IS NULL
    -- The new column, constrained in the same statement that would otherwise have
    -- shipped it open.
    AND (document_id IS NULL
         OR document_filed_by_provider(document_id, current_provider()))
  );
