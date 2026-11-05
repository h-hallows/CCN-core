/** Spec § 3.2 — providers, credentials and the append-only renewal history. */
import { boolean, check, date, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { providerStatus, providerType, credentialType, credentialSubmissionState } from './enums';

export const providers = pgTable('providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  status: providerStatus('status').notNull().default('active'),
  fullName: text('full_name').notNull(),
  preferredName: text('preferred_name'),
  phone: text('phone'),
  email: text('email'),
  photoUrl: text('photo_url'),
  photoConsentOn: date('photo_consent_on'),
  type: providerType('type').notNull(),
  licenseNumber: text('license_number'),
  licenseState: text('license_state').default('CA'),
  /** I5: provider-set. No default, no suggestion, no cap. */
  rateHourly: numeric('rate_hourly', { precision: 6, scale: 2 }),
  rateNotes: text('rate_notes'),
  transports: boolean('transports').notNull().default(false),
  areas: text('areas').array().notNull().default(sql`'{}'`),
  maxTravelMin: integer('max_travel_min'),
  availability: text('availability').array().notNull().default(sql`'{}'`),
  /** (b)(2): provider-stated restrictions. */
  restrictions: text('restrictions'),
  /**
   * The provider's own words about themselves, shown to households verbatim. Distinct
   * from `notes`, which is the operator's record and which a provider may not change.
   */
  bio: text('bio'),
  specialties: text('specialties').array().notNull().default(sql`'{}'`),
  languages: text('languages').array().notNull().default(sql`'{}'`),
  notes: text('notes'),
  agreementSignedOn: date('agreement_signed_on'),
  writtenNoticeAckOn: date('written_notice_ack_on'),
  workAuthVerifiedOn: date('work_auth_verified_on'),
  /** I1: voluntary, administrative procedures and the referral agreement only. */
  orientationOn: date('orientation_on'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('providers_status_idx').on(t.status),
  index('providers_type_idx').on(t.type),
]);

export const credentials = pgTable('credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerId: uuid('provider_id').notNull().references(() => providers.id),
  type: credentialType('type').notNull(),
  identifier: text('identifier'),
  issuedOn: date('issued_on'),
  /** NULL = non-expiring. */
  expiresOn: date('expires_on'),
  verifiedOn: date('verified_on').notNull(),
  verifiedBy: text('verified_by').notNull(),
  verificationSource: text('verification_source').notNull(),
  documentUrl: text('document_url'),
  notes: text('notes'),
  /**
   * § 1812.528 — the licence physically inspected, with its expiry noted. A different
   * act from the primary-source lookup in verificationSource, and the statute wants
   * both.
   */
  inspectedAt: date('inspected_at'),
  inspectedBy: text('inspected_by'),
  inspectedExpiryNoted: date('inspected_expiry_noted'),
  experienceVerifiedAt: date('experience_verified_at'),
  experienceVerifiedNote: text('experience_verified_note'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('credentials_one_live_per_type').on(t.providerId, t.type)
    .where(sql`deleted_at IS NULL`),
  index('credentials_provider_idx').on(t.providerId),
  index('credentials_expiry_idx').on(t.expiresOn),
]);

export const credentialEvents = pgTable('credential_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  credentialId: uuid('credential_id').notNull().references(() => credentials.id),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  actor: text('actor').notNull(),
  prevExpiresOn: date('prev_expires_on'),
  newExpiresOn: date('new_expires_on'),
  prevVerifiedOn: date('prev_verified_on'),
  newVerifiedOn: date('new_verified_on'),
  note: text('note'),
});

/**
 * What a provider hands in. Migration 0008, web build spec § 4.2.
 *
 * NOT a credential, deliberately, and the absent columns are the design: no
 * `expiresOn`, no `verifiedOn`, no `verifiedBy`, no `verificationSource`. None of those
 * is a fact a provider is in a position to assert about themselves, and `eligibility()`
 * counts a `credentials` row of the required type as that requirement being met — so a
 * provider who could create one could put themselves on a household's shortlist. They
 * cannot: migration 0008 drops the insert policy that allowed it and routes uploads
 * here, where nothing reads them as proof of anything.
 *
 * The operator checks the document against the issuing body, creates the `credentials`
 * row, and `credentialId` points at it, so the trail runs from what was handed in to
 * what was verified.
 */
export const credentialSubmissions = pgTable('credential_submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerId: uuid('provider_id').notNull().references(() => providers.id),
  type: credentialType('type').notNull(),
  /** The provider's own reference. Believed by nobody until the operator checks it. */
  identifier: text('identifier'),
  documentUrl: text('document_url'),
  note: text('note'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  state: credentialSubmissionState('state').notNull().default('submitted'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedBy: text('reviewed_by'),
  reviewNote: text('review_note'),
  credentialId: uuid('credential_id').references(() => credentials.id),
}, (t) => [
  index('credential_submissions_provider').on(t.providerId, t.submittedAt),
  check('submission_reviewed_has_reviewer', sql`
    (${t.state} = 'submitted' AND ${t.reviewedAt} IS NULL AND ${t.reviewedBy} IS NULL)
    OR (${t.state} <> 'submitted' AND ${t.reviewedAt} IS NOT NULL AND ${t.reviewedBy} IS NOT NULL)`),
  check('submission_accepted_has_credential', sql`
    (${t.state} = 'accepted' AND ${t.credentialId} IS NOT NULL)
    OR (${t.state} <> 'accepted' AND ${t.credentialId} IS NULL)`),
]);
