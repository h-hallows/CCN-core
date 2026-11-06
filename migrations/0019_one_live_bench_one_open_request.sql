-- Two things the application intends and the database permitted.
--
-- 1. ONE LIVE BENCH PER CASE.
--
-- `publishBench` withdraws the live bench and inserts the new one in a transaction, so
-- the ordinary sequence is right. It is check-then-write all the same: the UPDATE locks
-- the rows it finds and nothing stops a concurrent transaction INSERTING a second live
-- row, because there is no row to lock. A double-click does it.
--
-- The household's own screen is where this lands. `currentBenches` returns every bench
-- with `withdrawn_at IS NULL`, newest first, so two live rows render as two short lists
-- stacked on top of each other with nothing to say which one is current — and a family
-- asking about somebody from the stale one is asking about somebody the operator
-- deliberately took away.
--
-- Reproduced before writing this: two interleaved inserts, two live benches.
--
-- 2. ONE OPEN REQUEST PER PROVIDER PER BENCH.
--
-- `lib/request.ts` reads for an existing pending row and returns "you have already
-- asked us" rather than inserting a second. Same shape, same race, and the symptom is
-- the operator's queue showing the same family asking about the same nurse twice, which
-- reads as two people wanting two different things.
--
-- Both are partial: a withdrawn bench and a resolved request are ordinary history, and
-- a family may ask again about someone they declined earlier.

CREATE UNIQUE INDEX published_shortlists_one_live_per_case
  ON published_shortlists (case_id)
  WHERE withdrawn_at IS NULL;

CREATE UNIQUE INDEX shortlist_requests_one_open_per_provider
  ON shortlist_requests (shortlist_id, provider_id)
  WHERE status = 'pending';
