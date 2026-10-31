/** Spec § 3.2 — providers, credentials and the append-only renewal history. */
import { boolean, date, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { providerStatus, providerType, credentialType } from './enums';

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
