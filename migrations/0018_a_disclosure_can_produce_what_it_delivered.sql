-- The § 1812.5095(f) record can now point at what was actually sent.
--
-- `disclosures` records that a written statement went out, on what date and by what
-- method, and `statutory_version` is a column DEFAULT rather than the version actually
-- used — so the compliance record says a statement was delivered and cannot produce it.
-- § 1.6's reason for versioning the texts is exactly that it should be able to.
--
-- Documents exist now (0015), so the honest fix is a reference to the artifact rather
-- than a better version string: a version number is hand-bumped and can drift from the
-- text it names, while a document carries a digest the database checked against its own
-- bytes. "Which wording did this family receive" becomes a file, not an assertion.
--
-- Optional, deliberately. Some statements go out by post from a template and nobody
-- scans the copy; refusing to record the delivery without one would mean the choice is
-- between an unrecorded delivery and a fabricated document.
--
-- AND THE GUARD BECOMES AN ALLOW-LIST.
--
-- `disclosure_guard` enumerates the columns that may NOT change, so every column added
-- since has been mutable by default — `nurse_disclosure_method` has been freely
-- rewritable since 0004, and the column added by this migration would have been too.
-- That is the same shape as the policy 0017 had to fix, and the lesson 0013 wrote down:
-- a list of what is constrained leaves the next column open. Inverted here, so a column
-- added later is immutable until someone says otherwise.

ALTER TABLE disclosures
  ADD COLUMN written_statement_document_id uuid REFERENCES documents(id);

COMMENT ON COLUMN disclosures.written_statement_document_id IS
  'The copy of the § 1812.5095(f) statement that was sent, if one was kept. Settable '
  'once, alongside written_sent_on.';

CREATE OR REPLACE FUNCTION disclosure_guard() RETURNS trigger AS $$
DECLARE settable text[] := ARRAY[
  'written_sent_on', 'written_method', 'written_statement_document_id',
  'nurse_disclosure_sent_on', 'nurse_disclosure_method', 'complaint_contacts_sent_on'
];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'disclosures are permanent records and cannot be deleted';
  END IF;

  -- Everything that is not a delivery field. An allow-list, so a column added by a
  -- later migration is refused until it is named here on purpose.
  IF (SELECT to_jsonb(NEW) - settable) IS DISTINCT FROM (SELECT to_jsonb(OLD) - settable) THEN
    RAISE EXCEPTION
      'disclosure record is immutable; only the delivery fields may be set';
  END IF;

  -- Settable once. A delivery date that can be moved is not evidence of a delivery, and
  -- neither is a copy that can be swapped for a different one afterwards.
  IF OLD.written_sent_on IS NOT NULL THEN
    IF NEW.written_sent_on IS DISTINCT FROM OLD.written_sent_on THEN
      RAISE EXCEPTION 'written_sent_on has already been recorded and cannot be changed';
    END IF;
    /*
     * And the method with it. 0004 locked the date and said nothing about the method,
     * so "sent by post on the 3rd" could become "sent by hand on the 3rd" afterwards —
     * a delivery fact restated after the fact is the thing these locks exist to stop.
     */
    IF NEW.written_method IS DISTINCT FROM OLD.written_method THEN
      RAISE EXCEPTION 'written_method was recorded with the delivery and cannot be changed';
    END IF;
  END IF;
  IF OLD.written_statement_document_id IS NOT NULL
     AND NEW.written_statement_document_id IS DISTINCT FROM OLD.written_statement_document_id THEN
    RAISE EXCEPTION 'the sent statement has already been recorded and cannot be replaced';
  END IF;
  IF OLD.nurse_disclosure_sent_on IS NOT NULL THEN
    IF NEW.nurse_disclosure_sent_on IS DISTINCT FROM OLD.nurse_disclosure_sent_on THEN
      RAISE EXCEPTION 'nurse_disclosure_sent_on has already been recorded and cannot be changed';
    END IF;
    IF NEW.nurse_disclosure_method IS DISTINCT FROM OLD.nurse_disclosure_method THEN
      RAISE EXCEPTION 'nurse_disclosure_method was recorded with the delivery and cannot be changed';
    END IF;
  END IF;
  IF OLD.complaint_contacts_sent_on IS NOT NULL
     AND NEW.complaint_contacts_sent_on IS DISTINCT FROM OLD.complaint_contacts_sent_on THEN
    RAISE EXCEPTION 'complaint_contacts_sent_on has already been recorded and cannot be changed';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;
