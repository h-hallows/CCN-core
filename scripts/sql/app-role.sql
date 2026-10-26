-- Application role for CCN Registry OS.
--
-- Run this ONCE, after `npm run db:deploy` has created the schema, in the Supabase SQL
-- editor (or any psql session connected as the owner).
--
-- WHY A SEPARATE ROLE: row level security is enabled on every table from migration 0001,
-- but Postgres lets a table's OWNER bypass RLS entirely. Connecting the application as
-- the owner — which is what Supabase's default `postgres` user is — means the policies
-- are present and inert. This role owns nothing, so they actually apply.
--
-- Replace the password before running. Generate one with: openssl rand -base64 24

CREATE ROLE ccn_app LOGIN PASSWORD 'REPLACE_ME';

GRANT USAGE ON SCHEMA public TO ccn_app;

-- No DELETE, anywhere. The compliance record is append-only by design: timeline entries,
-- referrals, disclosures, credential events, audit rows and metric events are all
-- protected by triggers, and withholding the privilege means a mistake cannot even
-- reach them. Soft deletes use the `deleted_at` columns, which are an UPDATE.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ccn_app;

-- Future tables created by later migrations get the same treatment, so adding a table
-- never silently leaves the application unable to read it.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO ccn_app;

-- The RLS policies in migration 0001 check a custom setting, which the application sets
-- as a connection startup parameter. Setting a custom GUC needs no special privilege,
-- but the grant below is what lets this role see the policies apply to it rather than
-- be skipped.
--
-- Verify afterwards, connected AS ccn_app:
--
--   SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user;
--     -> ccn_app, false
--
--   SELECT count(*) FROM providers;
--     -> 0 rows if app.operator_id is unset, which is the policy working.
