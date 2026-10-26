/**
 * Drizzle schema. Mirrors lib/db/migrations/0001_init.sql, which is authoritative.
 * The SQL file owns constraints and triggers; this file owns the TypeScript types.
 */
import {
  boolean, check, date, index, integer, jsonb, numeric, pgEnum, pgTable,
  primaryKey, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// --- § 3.1 enums -----------------------------------------------------------

export const providerType = pgEnum('provider_type', ['RN', 'LVN', 'CNA', 'HCA', 'companion']);
export const providerStatus = pgEnum('provider_status', ['active', 'inactive', 'do_not_refer']);
export const credentialType = pgEnum('credential_type', [
  'rn_license', 'lvn_license', 'cna_cert', 'hca_registry', 'live_scan',
  'tb_clearance', 'cpr_bls', 'auto_insurance', 'drivers_license', 'immunization', 'other',
]);
export const careType = pgEnum('care_type', [
  'companion', 'personal_care', 'skilled_nursing', 'post_surgical',
  'overnight_newborn', 'respite', 'hospice_support',
]);
export const caseStatus = pgEnum('case_status', [
  'inquiry', 'matching', 'referred', 'active', 'paused', 'ended',
]);
export const urgency = pgEnum('urgency', ['discharge', 'same_day', 'next_day', 'routine']);
export const paymentMethod = pgEnum('payment_method', ['private', 'ltc_policy', 'va', 'other']);
export const timelineType = pgEnum('timeline_type', [
  'inquiry', 'call', 'note', 'shortlist', 'referral', 'disclosure',
  'written_disclosure', 'schedule_change', 'document', 'status_change',
]);
/** I4: no `registry` member. The registry cannot end a relationship. */
export const endedBy = pgEnum('ended_by', ['household', 'provider', 'mutual']);
export const shiftBlock = pgEnum('shift_block', ['AM', 'PM', 'NOC']);
export const endReason = pgEnum('end_reason', [
  'moved_to_direct_arrangement', 'care_no_longer_needed', 'hospitalized',
  'moved_to_facility', 'deceased', 'cost', 'household_dissatisfied',
  'provider_unavailable', 'moved_to_another_agency', 'other',
]);
export const referralOutcome = pgEnum('referral_outcome', [
  'engaged', 'declined_by_household', 'declined_by_provider', 'no_response',
]);
export const metricEvent = pgEnum('metric_event', [
  'inquiry_received', 'first_contact', 'shortlist_generated', 'referral_made',
  'engagement_started', 'engagement_ended', 'operator_session', 'credential_renewed',
  'service_failure', 'billed_hours_recorded',
]);
export const serviceFailureKind = pgEnum('service_failure_kind', [
  'missed_shift', 'unanswered_discharge_call', 'lapsed_credential_reached_household',
  'no_eligible_provider_available', 'other',
]);

// --- § 3.8 partners, users, auth -------------------------------------------

export const referralPartners = pgTable('referral_partners', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  org: text('org'),
  role: text('role'),
  phone: text('phone'),
  email: text('email'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  role: text('role').notNull().default('operator'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authTokens = pgTable('auth_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// --- § 3.2 providers and credentials ---------------------------------------

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

// --- § 3.4 households and cases --------------------------------------------

export const households = pgTable('households', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
  status: text('status').notNull().default('inquiry'),
  dmName: text('dm_name').notNull(),
  dmRelationship: text('dm_relationship'),
  dmPhone: text('dm_phone'),
  dmEmail: text('dm_email'),
  dmLocation: text('dm_location'),
  dmTimezone: text('dm_timezone'),
  crName: text('cr_name'),
  crAge: integer('cr_age'),
  crArea: text('cr_area').notNull(),
  crAddress: text('cr_address'),
  crAccessNotes: text('cr_access_notes'),
  paymentMethod: paymentMethod('payment_method').notNull().default('private'),
  ltcCarrier: text('ltc_carrier'),
  ltcPolicyNumber: text('ltc_policy_number'),
  physicianName: text('physician_name'),
  physicianPractice: text('physician_practice'),
  physicianPhone: text('physician_phone'),
  physicianFax: text('physician_fax'),
  ndaOnFile: boolean('nda_on_file').notNull().default(false),
  source: text('source'),
  partnerId: uuid('partner_id').references(() => referralPartners.id),
  blockedProviderIds: uuid('blocked_provider_ids').array().notNull().default(sql`'{}'`),
  notes: text('notes'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const cases = pgTable('cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: uuid('household_id').notNull().references(() => households.id),
  status: caseStatus('status').notNull().default('inquiry'),
  care: careType('care').notNull(),
  urgency: urgency('urgency').notNull().default('routine'),
  /** I10: the household's own words. */
  needsProfile: text('needs_profile'),
  needsAuthoredBy: text('needs_authored_by').notNull().default('household'),
  adlNeeds: text('adl_needs').array().notNull().default(sql`'{}'`),
  schedule: text('schedule').array().notNull().default(sql`'{}'`),
  hoursPerWeek: integer('hours_per_week'),
  startsOn: date('starts_on'),
  endsOn: date('ends_on'),
  expectedWeeks: integer('expected_weeks'),
  rateAgreed: numeric('rate_agreed', { precision: 6, scale: 2 }),
  /** I6: percentage of job cost, charged to the household. */
  feePct: numeric('fee_pct', { precision: 5, scale: 2 }),
  feeChargedTo: text('fee_charged_to').notNull().default('household'),
  rateBandLow: numeric('rate_band_low', { precision: 6, scale: 2 }),
  rateBandHigh: numeric('rate_band_high', { precision: 6, scale: 2 }),
  languagePref: text('language_pref'),
  primaryProviderId: uuid('primary_provider_id').references(() => providers.id),
  alternateProviderIds: uuid('alternate_provider_ids').array().notNull().default(sql`'{}'`),
  householdProfile: text('household_profile'),
  referredOn: date('referred_on'),
  writtenDueOn: date('written_due_on'),
  writtenSentOn: date('written_sent_on'),
  endedOn: date('ended_on'),
  endedBy: endedBy('ended_by'),
  endReason: endReason('end_reason'),
  endReasonNote: text('end_reason_note'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('cases_status_idx').on(t.status),
  index('cases_household_idx').on(t.householdId),
  check('cases_needs_authored_by_household', sql`${t.needsAuthoredBy} = 'household'`),
  check('cases_fee_charged_to_household', sql`${t.feeChargedTo} = 'household'`),
]);

/**
 * § 3.5 — BLOCKED SURFACE, see /DEFERRED.md. The table exists so the schema accepts
 * the feature later; nothing in the application reads or writes it until the § 0.5
 * nine-factor audit is complete. Confirmation only, never task completion (I2).
 */
export const coverageGaps = pgTable('coverage_gaps', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').notNull().references(() => cases.id),
  onDate: date('on_date').notNull(),
  block: shiftBlock('block').notNull(),
  note: text('note'),
  resolvedProviderId: uuid('resolved_provider_id').references(() => providers.id),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// --- § 3.6 timeline, disclosures, referrals --------------------------------

export const timelineEntries = pgTable('timeline_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').references(() => cases.id),
  householdId: uuid('household_id').references(() => households.id),
  /** Server-set, never client-supplied. */
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  type: timelineType('type').notNull(),
  author: text('author').notNull(),
  body: text('body').notNull(),
  providerId: uuid('provider_id').references(() => providers.id),
}, (t) => [
  index('timeline_case_idx').on(t.caseId, t.at),
  index('timeline_household_idx').on(t.householdId, t.at),
]);

export const disclosures = pgTable('disclosures', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').notNull().references(() => cases.id),
  timelineId: uuid('timeline_id').notNull().references(() => timelineEntries.id),
  disclosedTo: text('disclosed_to').notNull(),
  disclosedBy: text('disclosed_by').notNull(),
  /** Counsel question 1 open: a live human channel is the only permitted method. */
  method: text('method').notNull(),
  disclosedAt: timestamp('disclosed_at', { withTimezone: true }).notNull().defaultNow(),
  writtenDueOn: date('written_due_on').notNull(),
  writtenSentOn: date('written_sent_on'),
  writtenMethod: text('written_method'),
}, (t) => [
  index('disclosures_case_idx').on(t.caseId, t.disclosedAt),
  check('disclosures_method_live', sql`${t.method} IN ('phone','in_person')`),
]);

export const referrals = pgTable('referrals', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').notNull().references(() => cases.id),
  providerId: uuid('provider_id').notNull().references(() => providers.id),
  /** I3: no referral without a disclosure, enforced by the FK. */
  disclosureId: uuid('disclosure_id').notNull().references(() => disclosures.id),
  referredAt: timestamp('referred_at', { withTimezone: true }).notNull().defaultNow(),
  referredBy: text('referred_by').notNull(),
  outcome: referralOutcome('outcome'),
  outcomeNote: text('outcome_note'),
  outcomeAt: timestamp('outcome_at', { withTimezone: true }),
}, (t) => [
  index('referrals_case_idx').on(t.caseId, t.referredAt),
  index('referrals_provider_idx').on(t.providerId, t.referredAt),
]);

// --- § 3.7 feedback, constrained by I7 -------------------------------------

export const referralFeedback = pgTable('referral_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  referralId: uuid('referral_id').notNull().references(() => referrals.id),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  /** Satisfaction with the REFERRAL SERVICE, per (b)(5)(B). */
  referralServiceRating: integer('referral_service_rating'),
  wouldReferAgain: boolean('would_refer_again'),
  notes: text('notes'),
  /**
   * I7 / § 687.2(e): informs future referral decisions only. It must never drive
   * provider discipline, coaching, training or corrective action.
   */
  useRestriction: text('use_restriction').notNull().default('referral_decisions_only'),
}, (t) => [
  check('referral_feedback_use_restriction', sql`${t.useRestriction} = 'referral_decisions_only'`),
  check('referral_feedback_rating_range', sql`${t.referralServiceRating} BETWEEN 1 AND 5`),
]);

// --- § 3.8 audit, § 8 instrumentation --------------------------------------

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: uuid('entity_id'),
  diff: jsonb('diff'),
  ip: text('ip'),
  userAgent: text('user_agent'),
}, (t) => [
  index('audit_log_entity_idx').on(t.entity, t.entityId, t.at),
  check('audit_log_action', sql`${t.action} IN ('read','create','update','soft_delete')`),
]);

export const metricEvents = pgTable('metric_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  event: metricEvent('event').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  caseId: uuid('case_id').references(() => cases.id),
  providerId: uuid('provider_id').references(() => providers.id),
  payload: jsonb('payload').notNull().default({}),
}, (t) => [index('metric_events_event_idx').on(t.event, t.at)]);

export const serviceFailures = pgTable('service_failures', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').notNull().references(() => cases.id),
  kind: serviceFailureKind('kind').notNull(),
  onDate: date('on_date').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const caseMonthHours = pgTable('case_month_hours', {
  caseId: uuid('case_id').notNull().references(() => cases.id),
  month: date('month').notNull(),
  billedHours: numeric('billed_hours', { precision: 8, scale: 2 }).notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.caseId, t.month] })]);

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
