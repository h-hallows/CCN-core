-- The partner portal. Web build spec § 4.3, milestone W11.
--
-- A partner could hand us a referral and never hear anything again. `inquiries` had a
-- partner INSERT policy and no SELECT, and there was no way to identify a partner at
-- all: no partner_users table, no ccn_partner_id claim, and portal_invites could carry
-- a 'partner' role pointing at nothing.
--
-- WHAT THIS DELIBERATELY DOES NOT ADD. No compensation of any kind — no commission,
-- no rate, no rewards tier, no column that could hold one. § 1812.531 prohibits a
-- nurses' registry from dividing fees with "any physician, surgeon, nurse, hospital,
-- patient, or their agents or employees", which covers most of the people this portal
-- is for: discharge planners, surgical practices, concierge physicians. Spec § 0.1 is
-- explicit that there must be "no schema column that could hold one", and the reason
-- to enforce it here rather than in the UI is that a column, once it exists, gets
-- filled in. A test asserts the absence across the whole schema.
--
-- The portal is a convenience and service tool: one-step referral, acknowledgement,
-- and an outcome loop bounded by what the household has agreed to share.

-- ---------------------------------------------------------------------------
-- Who a partner is.
-- ---------------------------------------------------------------------------

CREATE TABLE partner_users (
  user_id    uuid NOT NULL REFERENCES users(id),
  partner_id uuid NOT NULL REFERENCES referral_partners(id),
  PRIMARY KEY (user_id, partner_id)
);

ALTER TABLE partner_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_users FORCE ROW LEVEL SECURITY;
CREATE POLICY partner_users_operator_all ON partner_users
  FOR ALL USING (is_operator()) WITH CHECK (is_operator());
CREATE POLICY partner_users_own_select ON partner_users
  FOR SELECT USING (user_id = current_user_id());
GRANT SELECT, INSERT, UPDATE ON partner_users TO ccn_app;

CREATE OR REPLACE FUNCTION current_partner() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT nullif(ccn_claims() ->> 'ccn_partner_id', '')::uuid;
  $$;

-- An invite can now name the partner it is for, the same way a household or provider
-- invite does. The old CHECK let a 'partner' invite point at nothing at all.
ALTER TABLE portal_invites ADD COLUMN partner_id uuid REFERENCES referral_partners(id);

ALTER TABLE portal_invites DROP CONSTRAINT IF EXISTS portal_invites_check;
ALTER TABLE portal_invites ADD CONSTRAINT portal_invite_names_its_subject CHECK (
  (role = 'household' AND household_id IS NOT NULL AND provider_id IS NULL AND partner_id IS NULL) OR
  (role = 'provider'  AND provider_id  IS NOT NULL AND household_id IS NULL AND partner_id IS NULL) OR
  (role = 'partner'   AND partner_id   IS NOT NULL AND household_id IS NULL AND provider_id IS NULL) OR
  (role = 'operator'  AND household_id IS NULL AND provider_id IS NULL AND partner_id IS NULL)
);

-- ---------------------------------------------------------------------------
-- What a household has agreed the partner may be told.
--
-- § 4.3: a partner sees what happened to each referral "within the limits of household
-- consent". Without a consent record the honest answer is that we received it and
-- picked it up — which is about us — and nothing about whether the family went ahead,
-- which is about them.
--
-- Reusing `consents` rather than adding a flag to `households` means revocation,
-- evidence and the granting party come for free, and a withdrawn consent closes the
-- loop immediately rather than when somebody remembers.
-- ---------------------------------------------------------------------------

ALTER TABLE consents DROP CONSTRAINT IF EXISTS consents_kind_check;
ALTER TABLE consents ADD CONSTRAINT consents_kind_check
  CHECK (kind IN ('photo', 'testimonial', 'case_study', 'partner_outcome'));

CREATE OR REPLACE FUNCTION household_shares_outcome_with_partner(h uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
      SELECT 1 FROM consents
       WHERE subject_type = 'household'
         AND subject_id = h
         AND kind = 'partner_outcome'
         AND revoked_at IS NULL);
  $$;

-- ---------------------------------------------------------------------------
-- What the partner can read.
--
-- A projection, not a table policy. `inquiries` carries `household_id`, and the mere
-- presence of a value there tells a partner the family engaged us — which is the one
-- fact the consent gate exists to protect. A row-level policy would hand it over,
-- because § 4 puts all four audiences on one database role and column grants are not
-- available. So the partner reads a function that returns the columns they are
-- entitled to and computes the outcome through the gate, and `inquiries` itself stays
-- unreadable to them.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION partner_referrals()
  RETURNS TABLE (
    inquiry_id uuid,
    received_at timestamptz,
    patient_initials text,
    care_type text,
    area text,
    urgency text,
    contact_name text,
    acknowledged_at timestamptz,
    outcome text
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT i.id,
           i.received_at,
           i.referrer ->> 'patientInitials',
           i.care_type::text,
           i.area,
           i.urgency::text,
           i.name,
           i.handled_at,
           CASE
             -- Nothing about the household until the household has said so.
             WHEN i.household_id IS NULL THEN NULL
             WHEN household_shares_outcome_with_partner(i.household_id)
               THEN 'care_arranged'
             ELSE NULL
           END
      FROM inquiries i
     WHERE current_role_name() = 'partner'
       AND current_partner() IS NOT NULL
       AND i.partner_id = current_partner()
     ORDER BY i.received_at DESC;
  $$;
