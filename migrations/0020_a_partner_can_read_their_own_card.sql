-- A partner may read their own contact details, and only those.
--
-- `/refer` asks a partner for their name, organisation, phone and email every time,
-- including when they are signed in and the registry already has all four. Retyping
-- them is how a second version of the same person gets created — and the
-- acknowledgement goes to the operator's copy, not to whatever was typed into the
-- form, so the two disagreeing is a planner who never hears back.
--
-- WHY A FUNCTION RATHER THAN A POLICY. `referral_partners.notes` is the operator's
-- note about the partner — how we know them, whether they send good work, anything
-- said in confidence. A SELECT policy on the table would hand that to its subject,
-- which is the shape of the problem 0007 and I12 are about: the registry's working
-- record is not the subject's to read. The projection returns the four columns a
-- partner is entitled to because they are their own, and nothing else.
--
-- Same posture as `partner_referrals()` in 0012, for the same reason.

CREATE OR REPLACE FUNCTION partner_self()
  RETURNS TABLE (name text, org text, phone text, email text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT p.name, p.org, p.phone, p.email
      FROM referral_partners p
     WHERE current_role_name() = 'partner'
       AND current_partner() IS NOT NULL
       AND p.id = current_partner();
  $$;
