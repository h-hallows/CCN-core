-- Where the work is. Web build spec § 4.2, milestone W9.
--
-- An open opportunity has to tell a provider the area, alongside the pattern, the
-- hours and the household's stated needs (§ 4.2). The pattern, hours and needs are
-- columns on `cases`, which `cases_provider_select` already grants for a case they
-- have been referred to. The area is not: it is `households.cr_area`, and there is no
-- provider policy on `households` at all.
--
-- Adding one would be the wrong fix. That row carries the decision maker's name and
-- phone, the care recipient's name and age, the address, access notes, the payment
-- method, the long-term care policy number and the physician's details. A provider
-- deciding whether to take a Tuesday morning needs none of it, and a SELECT policy
-- narrow enough to be safe would have to be a column list the next migration forgets
-- to maintain.
--
-- So: one function returning one text value, and only to somebody already referred to
-- that case. SECURITY DEFINER because the caller cannot read `households` — that is
-- the point — and STABLE because it reads nothing it writes.
--
-- The provider learns the neighbourhood of a case they have been put forward for,
-- which they would learn at the door in any event.

CREATE OR REPLACE FUNCTION case_area_for_provider(c uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT h.cr_area
      FROM cases k
      JOIN households h ON h.id = k.household_id
     WHERE k.id = c
       AND provider_referred_to_case(c);
  $$;
