/** Spec § 3.4 — households and cases, plus the referral partners households arrive from. */
import { check, date, index, integer, numeric, pgTable, text, timestamp, uuid, boolean } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { careType, caseStatus, endReason, endedBy, paymentMethod, shiftBlock, urgency } from './enums';
import { providers } from './providers';

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
