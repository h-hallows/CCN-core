/**
 * The schema, and the types derived from it. Architecture spec § 2.1.
 *
 * Split by subject rather than by migration: a reader looking for "how is a credential
 * stored" should not have to know which migration added it.
 */
export * from './enums';
export * from './providers';
export * from './households';
export * from './compliance';
export * from './auth';
export * from './portal';
export * from './intake';
export * from './audit';
export * from './nurses';

import { providers, credentials } from './providers';
import { households, cases } from './households';
import { timelineEntries, disclosures, referrals } from './compliance';
import {
  careType, caseStatus, credentialType, endReason, providerType, urgency,
} from './enums';

// --- inferred types ---------------------------------------------------------

export type Provider = typeof providers.$inferSelect;
export type Credential = typeof credentials.$inferSelect;
export type Household = typeof households.$inferSelect;
export type Case = typeof cases.$inferSelect;
export type TimelineEntry = typeof timelineEntries.$inferSelect;
export type Disclosure = typeof disclosures.$inferSelect;
export type Referral = typeof referrals.$inferSelect;
export type ProviderType = (typeof providerType.enumValues)[number];
export type CredentialType = (typeof credentialType.enumValues)[number];
export type CareType = (typeof careType.enumValues)[number];
export type CaseStatusValue = (typeof caseStatus.enumValues)[number];
export type UrgencyValue = (typeof urgency.enumValues)[number];
export type EndReasonValue = (typeof endReason.enumValues)[number];
