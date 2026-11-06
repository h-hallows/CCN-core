-- Documents. The thing a record points at when someone asks to see it.
--
-- WHAT WAS MISSING. `credential_submissions.document_url` is a URL, and a URL is not a
-- document: it rots, it can be edited behind your back after the operator checked it,
-- and it can point anywhere — including at a host the registry does not control, which
-- is where a family's paperwork should never live. `providers.agreement_signed_on` and
-- `written_notice_ack_on` are dates with nothing behind them, so the § 1812.5095 file
-- says a provider signed and cannot produce what they signed.
--
-- WHY THE BYTES ARE IN POSTGRES.
--
-- Not because object storage is wrong — because a second store is a second thing that
-- can disagree with the record, a second thing to back up, and a second set of
-- signed-URL semantics to get right. Row-level security already governs who may read a
-- household's information, and putting the bytes behind the same policies means there
-- is no second answer to that question. At this scale — tens of providers, documents
-- that are scanned PDFs — the cost is a few hundred megabytes.
--
-- The limit below is 10 MB, enforced by the database and not only by the upload form.
-- `storage` is a discriminator carrying one value today: it is here so an external
-- backend can be added later as a second value, without the rows that already exist
-- meaning something different.
--
-- WHY IT IS APPEND-ONLY, AND THE ONE EXCEPTION.
--
-- A document is evidence. If one is wrong the right answer is to upload the correct one
-- and keep both, because "what was on file in March" is a question someone may ask in
-- 2029. So there is no UPDATE and no DELETE.
--
-- The exception is redaction, and it exists because append-only has a failure mode that
-- is worse than losing history: upload one household's paperwork against another
-- household and append-only means you cannot un-leak it. Redaction drops the bytes and
-- keeps the row, the digest and the reason — so the record still shows that a document
-- was uploaded, when, by whom, what it hashed to, and that it was removed. That is the
-- evidentiary answer, and it is the only mutation this table permits.
--
-- RETENTION IS DELIBERATELY UNBOUNDED. COUNSEL.md question 4 (HIPAA) is open and the
-- § 1812.533 recordkeeping period is not settled here. Deleting evidence is the
-- irreversible mistake, so nothing expires until someone decides it should.

CREATE TYPE document_kind AS ENUM (
  'credential',          -- a Live Scan result, a TB clearance, a licence
  'registry_agreement',  -- what a provider signed, § 1812.5095
  'written_notice',      -- the § 1812.5095(d) notice, acknowledged
  'written_statement',   -- the § 1812.5095(f) statement delivered to a household
  'nurse_disclosure',    -- the § 1812.533(b)(4) residence disclosure
  'correspondence',
  'other'
);

CREATE TYPE document_storage AS ENUM ('postgres');

CREATE TABLE documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            document_kind NOT NULL,
  storage         document_storage NOT NULL DEFAULT 'postgres',

  -- Exactly one subject. A document belongs to somebody or it is not filed.
  provider_id     uuid REFERENCES providers(id),
  household_id    uuid REFERENCES households(id),
  case_id         uuid REFERENCES cases(id),

  -- Optional, and only alongside a provider: which credential this is the paper for.
  credential_id   uuid REFERENCES credentials(id),

  filename        text NOT NULL,
  content_type    text NOT NULL,
  byte_size       integer NOT NULL,
  /**
   * Hex SHA-256 of the bytes, checked by the database against the bytes themselves.
   * `sha256()` is a core function, not an extension, so this needs no pgcrypto.
   */
  sha256_hex      text NOT NULL,
  bytes           bytea,

  uploaded_by     text NOT NULL,
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  note            text,

  /**
   * Whether the household or provider this belongs to may read it from their own
   * screen. Default false: the operator's file is not the family's file, and I12 keeps
   * the diligence record away from both of them.
   */
  visible_to_subject boolean NOT NULL DEFAULT false,

  redacted_at     timestamptz,
  redacted_by     text,
  redaction_reason text,

  CONSTRAINT documents_one_subject CHECK (
    (provider_id  IS NOT NULL)::int
  + (household_id IS NOT NULL)::int
  + (case_id      IS NOT NULL)::int = 1),

  CONSTRAINT documents_credential_needs_provider CHECK (
    credential_id IS NULL OR provider_id IS NOT NULL),

  CONSTRAINT documents_size CHECK (byte_size BETWEEN 1 AND 10485760),

  CONSTRAINT documents_digest_format CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),

  /**
   * The recorded digest and size cannot disagree with the bytes. This is what lets the
   * digest be quoted as evidence rather than as something the application asserted.
   */
  CONSTRAINT documents_bytes_match CHECK (
    (redacted_at IS NULL
      AND bytes IS NOT NULL
      AND byte_size = octet_length(bytes)
      AND sha256_hex = encode(sha256(bytes), 'hex'))
    OR
    (redacted_at IS NOT NULL
      AND bytes IS NULL
      AND redacted_by IS NOT NULL
      AND redaction_reason IS NOT NULL))
);

CREATE INDEX documents_provider ON documents (provider_id, uploaded_at DESC);
CREATE INDEX documents_household ON documents (household_id, uploaded_at DESC);
CREATE INDEX documents_case ON documents (case_id, uploaded_at DESC);
CREATE INDEX documents_credential ON documents (credential_id);

-- ---------------------------------------------------------------------------
-- Append-only, apart from redaction.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION documents_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a document is evidence; redact it rather than deleting it';
  END IF;

  -- An allow-list, not a deny-list: a column added later is refused by default, which
  -- is the way round that survives the next migration.
  IF (to_jsonb(NEW) - 'redacted_at' - 'redacted_by' - 'redaction_reason' - 'bytes')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'redacted_at' - 'redacted_by' - 'redaction_reason' - 'bytes') THEN
    RAISE EXCEPTION 'a document is immutable; only redaction may change one';
  END IF;

  IF OLD.redacted_at IS NOT NULL THEN
    RAISE EXCEPTION 'that document is already redacted';
  END IF;

  IF NEW.redacted_at IS NULL OR NEW.bytes IS NOT NULL THEN
    RAISE EXCEPTION 'redaction must set redacted_at and drop the bytes';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_documents_guard
  BEFORE UPDATE OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_guard();

-- ---------------------------------------------------------------------------
-- Who may see one.
-- ---------------------------------------------------------------------------

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;

CREATE POLICY documents_operator_all ON documents
  FOR ALL USING (is_operator()) WITH CHECK (is_operator());

-- A provider sees their own, and only the ones marked shared. `visible_to_subject` is
-- the operator's deliberate act: the default is that a document is the registry's file
-- and not the subject's.
CREATE POLICY documents_provider_select ON documents
  FOR SELECT USING (
    current_role_name() = 'provider'
    AND visible_to_subject
    AND redacted_at IS NULL
    AND provider_id = current_provider()
  );

-- A household sees documents filed against them or against one of their cases.
CREATE POLICY documents_household_select ON documents
  FOR SELECT USING (
    current_role_name() = 'household'
    AND visible_to_subject
    AND redacted_at IS NULL
    AND (
      household_id = current_household()
      OR (case_id IS NOT NULL AND household_owns_case(case_id))
    )
  );

/**
 * A provider hands in the paper for a credential. Four things are forced:
 * it is theirs, it is a credential document, it names no case or household, and it is
 * NOT visible_to_subject — because that flag governs what the registry shares back, and
 * letting the uploader set it would make the subject the author of their own permissions.
 *
 * The same rule as credential_submissions: handing a document in is not the same as the
 * document being accepted, and nothing computes eligibility from one. A submission is
 * still the record of what was handed in; this is the paper it refers to.
 */
CREATE POLICY documents_provider_insert ON documents
  FOR INSERT WITH CHECK (
    current_role_name() = 'provider'
    AND provider_id = current_provider()
    AND household_id IS NULL
    AND case_id IS NULL
    AND kind = 'credential'
    AND visible_to_subject = false
    AND redacted_at IS NULL
    AND uploaded_by = 'provider'
  );

GRANT SELECT, INSERT, UPDATE ON documents TO ccn_app;

-- ---------------------------------------------------------------------------
-- A submission can now point at a document that is actually held.
-- ---------------------------------------------------------------------------

ALTER TABLE credential_submissions
  ADD COLUMN document_id uuid REFERENCES documents(id);

ALTER TABLE credentials
  ADD COLUMN document_id uuid REFERENCES documents(id);

COMMENT ON COLUMN credential_submissions.document_url IS
  'Deprecated by document_id. A URL is not a document: it rots and it can be edited '
  'behind you after the operator checked it. Kept for rows written before 0015.';

COMMENT ON COLUMN credentials.document_url IS
  'Deprecated by document_id, same reasoning. A verified credential should be able to '
  'produce the paper it was verified against, years later, unchanged.';
