/**
 * @ccn/core — owns the database and the rules that must not differ between surfaces.
 *
 * Both the operator console and the public front door consume this package. The reason
 * it exists: eligibility, the credential matrix, the care vocabulary and the forbidden
 * copy list have to be computed the same way everywhere, because a second implementation
 * is a second answer, and one of them will be the wrong one in front of a household.
 */
export * from './domain';
export * as schema from './schema';
export type {
  Provider, Credential, Household, Case, Referral, Disclosure, TimelineEntry,
  ProviderType, CredentialType, CareType, CaseStatusValue, UrgencyValue, EndReasonValue,
} from './schema';
export { ConfigError, resolveDatabaseConfig, resolveMigrationConfig, describeConnection } from './env';
