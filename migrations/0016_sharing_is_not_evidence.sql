-- `visible_to_subject` is a permission, not part of the document.
--
-- 0015's guard allow-listed only the redaction columns, so the flag that decides whether
-- a household can see a file was frozen at insert. That is wrong, and it is wrong in the
-- direction that matters: an operator who ticked "share" by mistake had no way to untick
-- it, and the only tool the table offered was redaction — destroying the file to correct
-- a sharing decision.
--
-- The distinction this draws, and the reason the flag lives on the row at all: the
-- document is evidence and cannot change; who may currently see it is a live permission
-- and must. The audit log carries the before and after of every change to it, so the
-- history of the decision is kept even though the flag itself is not append-only.
--
-- Everything else about a document is still immutable, and the allow-list is still an
-- allow-list, so a column added later is refused by default.

CREATE OR REPLACE FUNCTION documents_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a document is evidence; redact it rather than deleting it';
  END IF;

  IF (to_jsonb(NEW) - 'redacted_at' - 'redacted_by' - 'redaction_reason' - 'bytes'
        - 'visible_to_subject')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'redacted_at' - 'redacted_by' - 'redaction_reason' - 'bytes'
        - 'visible_to_subject') THEN
    RAISE EXCEPTION 'a document is immutable; only sharing and redaction may change one';
  END IF;

  IF OLD.redacted_at IS NOT NULL THEN
    RAISE EXCEPTION 'that document is already redacted';
  END IF;

  -- A change to sharing alone, with the document left intact.
  IF NEW.redacted_at IS NULL AND OLD.redacted_at IS NULL THEN
    IF NEW.bytes IS DISTINCT FROM OLD.bytes THEN
      RAISE EXCEPTION 'a document is immutable; only sharing and redaction may change one';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.redacted_at IS NULL OR NEW.bytes IS NOT NULL THEN
    RAISE EXCEPTION 'redaction must set redacted_at and drop the bytes';
  END IF;

  /*
   * A redacted document is not shared. Leaving the flag set would leave a row that
   * claims the family can see something that no longer exists, and the SELECT policies
   * would have to carry that contradiction instead.
   */
  IF NEW.visible_to_subject THEN
    RAISE EXCEPTION 'a redacted document cannot stay shared';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;
