/**
 * Tests run against an in-memory PGlite by default, so the invariant triggers in
 * migration 0001 are exercised for real — an append-only trigger that is only asserted
 * in a mock is not asserted at all.
 *
 * Set TEST_DATABASE_URL to run the same suite against a genuine Postgres 16 instead.
 * PGlite is very close to Postgres but not identical, and the invariants are the last
 * thing that should rely on "close":
 *
 *   npm run db:up
 *   TEST_DATABASE_URL=postgres://ccn:ccn@localhost:5433/ccn_registry npm test
 *
 * That database is TRUNCATEd and reseeded by the suite, so point it at a throwaway.
 */
const externalDatabase = process.env.TEST_DATABASE_URL?.trim();

if (externalDatabase) {
  process.env.DATABASE_URL = externalDatabase;
  delete process.env.PGLITE_DIR;
} else {
  process.env.DATABASE_URL = '';
  process.env.PGLITE_DIR = 'memory://';
}

process.env.OPERATOR_EMAILS = 'operator@example.com';
