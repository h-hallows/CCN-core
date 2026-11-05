-- The provider's own words about themselves. Web build spec § 4.1 and § 4.2, W8.
--
-- § 4.2 has /pro/profile writing "bio, preferred name, photo + consent" and § 4.1 has
-- the household's provider page showing a bio. There was no column for one.
--
-- Not `notes`: that is the operator's record about a provider and
-- `providers_provider_update_guard` forbids a provider changing it. This is the
-- opposite — what the provider says, shown to households verbatim, the same posture as
-- `restrictions`. The guard's forbidden list is unchanged, which is what makes this
-- writable by its owner: the guard names what a provider may NOT touch, and a column
-- absent from that list is theirs.
--
-- This is the product expression of § 1812.5095(b)(1)(C): the provider's own
-- presentation of themselves, which they own and can take elsewhere.

ALTER TABLE providers ADD COLUMN bio text;
