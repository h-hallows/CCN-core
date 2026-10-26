-- CCN front door — architecture spec § 3.
--
-- Additive, with one exception: `users` already exists from 0001 with a text `role`, so
-- § 3.4's CREATE TABLE is an ALTER here. The spec's § 5 note that nothing is altered
-- except two constraints is not quite right about that one table.
--
-- § 3.6's photo-consent constraint already exists as `providers_photo_requires_consent`
-- in 0001 and is deliberately not repeated.

-- ---------------------------------------------------------------------------
-- § 3.4 Portal access — invite only
--
-- There is no public client signup, because the bench is curated and the referral
-- requires a call. There is no public provider signup either; applications are reviewed.
-- ---------------------------------------------------------------------------

CREATE TYPE user_role AS ENUM ('operator','household','provider','partner');

ALTER TABLE users ALTER COLUMN role DROP DEFAULT;
ALTER TABLE users ALTER COLUMN role TYPE user_role USING role::user_role;
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'operator';
ALTER TABLE users ADD COLUMN last_seen_at timestamptz;
ALTER TABLE users ADD COLUMN disabled_at  timestamptz;

-- A household may have several users. The son in New York and the daughter in London
-- both need access, and in this business that is the common case, not an edge one.
CREATE TABLE household_users (
  user_id      uuid NOT NULL REFERENCES users(id),
  household_id uuid NOT NULL REFERENCES households(id),
  relationship text,
  PRIMARY KEY (user_id, household_id)
);

CREATE TABLE provider_users (
  user_id     uuid PRIMARY KEY REFERENCES users(id),
  provider_id uuid NOT NULL UNIQUE REFERENCES providers(id)
);

CREATE TABLE portal_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL,
  role         user_role NOT NULL,
  household_id uuid REFERENCES households(id),
  provider_id  uuid REFERENCES providers(id),
  token_hash   text NOT NULL,
  issued_by    text NOT NULL,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  revoked_at   timestamptz,
  CHECK (
    (role = 'household' AND household_id IS NOT NULL AND provider_id IS NULL) OR
    (role = 'provider'  AND provider_id  IS NOT NULL AND household_id IS NULL) OR
    (role IN ('operator','partner'))
  )
);

CREATE UNIQUE INDEX portal_invites_token ON portal_invites (token_hash);
CREATE INDEX portal_invites_open ON portal_invites (email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- § 3.1 Published shortlists
--
-- The client portal shows a curated bench, not a directory, so the bench has to be a
-- real record rather than a timeline note.
-- ---------------------------------------------------------------------------

CREATE TYPE shortlist_request_status AS ENUM
  ('pending','referred','declined_by_household','withdrawn');

CREATE TABLE published_shortlists (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL REFERENCES cases(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by text NOT NULL,
  note         text,                      -- what the operator told the household
  withdrawn_at timestamptz
);

CREATE INDEX published_shortlists_case ON published_shortlists (case_id, published_at DESC);

CREATE TABLE published_shortlist_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shortlist_id uuid NOT NULL REFERENCES published_shortlists(id),
  provider_id  uuid NOT NULL REFERENCES providers(id),
  position     int NOT NULL,
  UNIQUE (shortlist_id, provider_id)
);

-- THE LOAD-BEARING RULE (spec § 3.1): a shortlist_requests row is a request and nothing
-- more. No trigger, job or route may create a `referrals` row from it. Only the console's
-- disclosure transaction (backend spec § 4.6) does that, and it writes referral_id back
-- afterwards. There is deliberately no trigger on this table — a trigger is exactly the
-- mechanism this rule forbids.
CREATE TABLE shortlist_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shortlist_id uuid NOT NULL REFERENCES published_shortlists(id),
  provider_id  uuid NOT NULL REFERENCES providers(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by uuid NOT NULL REFERENCES users(id),
  status       shortlist_request_status NOT NULL DEFAULT 'pending',
  note         text,
  resolved_at  timestamptz,
  referral_id  uuid REFERENCES referrals(id),   -- set only by the console

  -- A request that claims to have become a referral must name one, and one that has not
  -- must not. This does not create a referral; it stops the two records disagreeing.
  CONSTRAINT shortlist_request_referred_has_referral CHECK (
    (status = 'referred' AND referral_id IS NOT NULL)
    OR (status <> 'referred' AND referral_id IS NULL)
  )
);

CREATE INDEX shortlist_requests_pending ON shortlist_requests (requested_at DESC)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- § 3.3 Public intake — two write paths, neither creates a live record
--
-- Public forms write here and nowhere else. No public path creates a households, cases
-- or providers row; the operator converts from the console. That keeps the entire live
-- record set behind one human, which is both the compliance posture and the product.
-- ---------------------------------------------------------------------------

CREATE TABLE inquiries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at    timestamptz NOT NULL DEFAULT now(),
  name           text NOT NULL,
  phone          text,
  email          text,
  relationship   text,
  care_type      care_type,
  area           text,
  pattern_note   text,
  start_note     text,
  urgency        urgency,
  payment_method payment_method,
  message        text,
  source_path    text,                    -- which page it came from
  utm            jsonb,
  partner_id     uuid REFERENCES referral_partners(id),
  household_id   uuid REFERENCES households(id),   -- set when the operator converts
  handled_at     timestamptz,
  handled_by     text
);

CREATE INDEX inquiries_unhandled ON inquiries (received_at DESC) WHERE handled_at IS NULL;

CREATE TABLE provider_applications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at     timestamptz NOT NULL DEFAULT now(),
  full_name       text NOT NULL,
  phone           text,
  email           text,
  type            provider_type,
  license_number  text,
  areas           text[],
  languages       text[],
  specialties     text[],
  experience_note text,
  message         text,
  provider_id     uuid REFERENCES providers(id),   -- set when onboarded
  handled_at      timestamptz,
  handled_by      text
);

CREATE INDEX provider_applications_unhandled ON provider_applications (received_at DESC)
  WHERE handled_at IS NULL;

-- ---------------------------------------------------------------------------
-- § 3.5 Consent and testimonials
-- ---------------------------------------------------------------------------

CREATE TABLE consents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('household','provider')),
  subject_id   uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('photo','testimonial','case_study')),
  granted_at   timestamptz NOT NULL,
  granted_by   text NOT NULL,
  scope_note   text,
  evidence_url text,
  revoked_at   timestamptz
);

CREATE INDEX consents_subject ON consents (subject_type, subject_id);

-- Household-level only, never attributed to a named provider (front door spec § 4.3).
CREATE TABLE testimonials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  consent_id   uuid NOT NULL REFERENCES consents(id),
  body         text NOT NULL,
  attribution  text NOT NULL,      -- "James T., Beverly Hills"
  service_line text,
  published    boolean NOT NULL DEFAULT false
);

-- A testimonial cannot be published on a consent that has been revoked. The spec states
-- the rule; without this it would rest entirely on the application remembering to join.
CREATE OR REPLACE FUNCTION assert_live_consent() RETURNS trigger AS $$
DECLARE revoked timestamptz;
BEGIN
  IF NEW.published THEN
    SELECT revoked_at INTO revoked FROM consents WHERE id = NEW.consent_id;
    IF revoked IS NOT NULL THEN
      RAISE EXCEPTION
        'testimonial % cannot be published: its consent was revoked on %', NEW.id, revoked;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_testimonial_live_consent
  BEFORE INSERT OR UPDATE ON testimonials
  FOR EACH ROW EXECUTE FUNCTION assert_live_consent();

-- ---------------------------------------------------------------------------
-- § 3.2 Staleness — a shortlist published Monday can hold a provider whose TB clearance
-- lapses Tuesday, and the client portal must not show them as available.
--
-- security_invoker is not in the spec and matters: a view defaults to running with its
-- OWNER's rights, which would let a household read provider rows straight through the
-- row-level security that § 4 is about to put on the table. With it, the view is checked
-- as whoever queries it.
--
-- This covers the EXPIRED case only. A MISSING required credential needs the per-type
-- matrix, so the application still calls eligibility() from the shared package. The view
-- exists so a query written in a hurry fails safe rather than failing open.
-- ---------------------------------------------------------------------------

CREATE VIEW v_shortlist_items_client
WITH (security_invoker = true) AS
SELECT i.*, p.full_name, p.type, p.rate_hourly, p.specialties, p.languages,
       p.photo_url, p.photo_consent_on, p.restrictions,
       (p.status = 'active' AND NOT EXISTS (
          SELECT 1 FROM credentials c
          WHERE c.provider_id = p.id
            AND c.deleted_at IS NULL
            AND c.expires_on IS NOT NULL
            AND c.expires_on < (now() AT TIME ZONE 'America/Los_Angeles')::date
       )) AS appears_available
FROM published_shortlist_items i
JOIN providers p ON p.id = i.provider_id
WHERE p.deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Row level security on everything added here, matching 0001. The policies in § 4 that
-- distinguish the four roles land in the next migration, once Supabase Auth is wired and
-- auth.jwt() exists to read.
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'household_users','provider_users','portal_invites',
      'published_shortlists','published_shortlist_items','shortlist_requests',
      'inquiries','provider_applications','consents','testimonials'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY operator_all ON %I FOR ALL
         USING (current_setting(''app.operator_id'', true) IS NOT NULL)
         WITH CHECK (current_setting(''app.operator_id'', true) IS NOT NULL)', t);
  END LOOP;
END $$;
