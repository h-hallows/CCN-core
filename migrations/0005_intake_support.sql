-- Support for the public intake surface. Web build spec § 3 and § 7.

-- ---------------------------------------------------------------------------
-- Rate limiting.
--
-- In-memory counters do not work here: every serverless invocation gets its own
-- container, so a per-process map would reset constantly and limit nothing. This has to
-- be shared state, which means the database.
--
-- The key is HASHED. These are people enquiring about care for a parent, and an IP
-- address next to "post-surgical, Beverly Hills, discharging Monday" is identifying.
-- The hash is enough to count against and useless for anything else.
-- ---------------------------------------------------------------------------

CREATE TABLE rate_limit_hits (
  id       bigserial PRIMARY KEY,
  key_hash text NOT NULL,
  route    text NOT NULL,
  at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rate_limit_window ON rate_limit_hits (route, key_hash, at DESC);

-- ---------------------------------------------------------------------------
-- The operator notification outbox.
--
-- Spec § 7 is transactional-only: an enquiry, an application, a referral request. No
-- mail provider is wired yet, and a notification that exists only as a console.log is a
-- notification that was never sent. Writing the row first means nothing is lost when
-- one is wired, and the operator can work the queue from the console meanwhile.
--
-- NOTHING IDENTIFYING IN THE BODY. Spec § 7: no provider name, household name, care
-- recipient name, address or clinical detail in an email body or subject. Email is not
-- a confidential channel and this clientele is discretion-first — the email says
-- something is ready, the portal says what. `subject` and `body` are written under that
-- rule; `payload` holds what the console needs and never reaches an inbox.
-- ---------------------------------------------------------------------------

CREATE TYPE notification_kind AS ENUM (
  'inquiry', 'provider_application', 'partner_referral', 'shortlist_request',
  'shortlist_published', 'written_statement_due', 'nurse_disclosure_outstanding',
  'credential_expiring', 'portal_invite');

CREATE TABLE operator_notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        notification_kind NOT NULL,
  urgency     urgency,
  subject     text NOT NULL,
  body        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  delivery_method text,
  read_at     timestamptz
);

CREATE INDEX operator_notifications_undelivered
  ON operator_notifications (created_at DESC) WHERE delivered_at IS NULL;

-- RLS: operator only, same default as everything else. The public routes insert through
-- a path that runs as the operator claim, because an anonymous caller must be able to
-- cause a notification without being able to read one.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['rate_limit_hits','operator_notifications'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY operator_all ON %I FOR ALL USING (is_operator()) WITH CHECK (is_operator())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO ccn_app', t);
  END LOOP;
END $$;

GRANT USAGE, SELECT ON SEQUENCE rate_limit_hits_id_seq TO ccn_app;

-- A partner may cause a notification without being able to read any.
CREATE POLICY notifications_partner_insert ON operator_notifications
  FOR INSERT WITH CHECK (current_role_name() = 'partner');

-- ---------------------------------------------------------------------------
-- Where an account-less partner referral lands.
--
-- Spec § 11: a partner's first referral needs no account, so there is no
-- referral_partners row to point partner_id at. The operator still needs to know who
-- sent it and how to reach them, and that detail has nowhere else to go — putting it in
-- `message` would lose the structure the console needs to acknowledge the referral.
--
-- Holds the partner block from PartnerReferralSchema: who they are, their role and
-- organisation, the patient's INITIALS only, and their confirmation that the family
-- agreed the contact details could be passed on. Never a full patient name: a discharge
-- planner sending one to a third party before the family has engaged anyone is a
-- privacy problem for the planner, not just for us.
-- ---------------------------------------------------------------------------

ALTER TABLE inquiries ADD COLUMN referrer jsonb;
