/**
 * The nurses' registry chapter — Civil Code §§ 1812.524–1812.533.
 *
 * A separate statutory regime from § 1812.5095, which governs CNAs, HCAs and
 * companions. These obligations have no domestic-worker equivalent.
 */
import {
  check, date, index, numeric, pgTable, text, timestamp, unique, uuid, integer, boolean,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { cases, households } from './households';
import { providers } from './providers';
import { referrals } from './compliance';

void households;

/** § 1812.529 — permanent log sheets. Append-only; a correction supersedes, never edits. */
export const assignmentLog = pgTable('assignment_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').notNull().references(() => cases.id),
  referralId: uuid('referral_id').notNull().references(() => referrals.id),
  providerId: uuid('provider_id').notNull().references(() => providers.id),
  orderReceivedAt: timestamp('order_received_at', { withTimezone: true }).notNull(),
  patientName: text('patient_name').notNull(),
  patientAddress: text('patient_address').notNull(),
  /** § 1812.524 predicate, logged per assignment rather than inferred from the household. */
  attendingPhysician: text('attending_physician').notNull(),
  serviceFrom: timestamp('service_from', { withTimezone: true }).notNull(),
  serviceTo: timestamp('service_to', { withTimezone: true }),
  feeBasis: text('fee_basis').notNull(),
  recordedBy: text('recorded_by').notNull(),
  correctsId: uuid('corrects_id'),
  correctionNote: text('correction_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('assignment_log_case').on(t.caseId, t.serviceFrom)]);

/**
 * § 1812.527 — the fee schedule, given to a nurse before the interview. A change takes
 * effect only after seven days of conspicuous posting, enforced by a check constraint
 * rather than by a calendar reminder.
 */
export const feeSchedules = pgTable('fee_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  version: integer('version').notNull().unique(),
  /** Fixed maximum, covering all charges. */
  maxFeePct: numeric('max_fee_pct', { precision: 5, scale: 2 }).notNull(),
  paymentTerms: text('payment_terms').notNull(),
  body: text('body').notNull(),
  postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
  effectiveFrom: date('effective_from').notNull(),
}, (t) => [
  check('fee_schedule_seven_day_embargo', sql`
    ${t.effectiveFrom} >= (${t.postedAt} AT TIME ZONE 'America/Los_Angeles')::date + 7`),
]);

export const feeScheduleDeliveries = pgTable('fee_schedule_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerId: uuid('provider_id').notNull().references(() => providers.id),
  scheduleId: uuid('schedule_id').notNull().references(() => feeSchedules.id),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }).notNull(),
  deliveredBy: text('delivered_by').notNull(),
  /** Must be true for RN and LVN. The statute says before the interview, not at signing. */
  beforeInterview: boolean('before_interview').notNull(),
}, (t) => [unique().on(t.providerId, t.scheduleId)]);

/** § 1812.533(c) — a record of every advertisement. A website is an advertisement. */
export const advertisingLog = pgTable('advertising_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  publishedOn: date('published_on').notNull(),
  publication: text('publication').notNull(),
  reference: text('reference'),
  snapshotUrl: text('snapshot_url'),
  recordedBy: text('recorded_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('advertising_log_published').on(t.publishedOn)]);

/**
 * Operator-maintained rate ranges for the marketing pages. Never written into page
 * content: a published rate that has drifted is a misleading advertisement under
 * § 1812.533(b)(1), not just a conversion problem.
 */
export const rateRanges = pgTable('rate_ranges', {
  id: uuid('id').primaryKey().defaultRandom(),
  serviceKey: text('service_key').notNull(),
  credentialLevel: text('credential_level').notNull(),
  low: numeric('low', { precision: 6, scale: 2 }).notNull(),
  high: numeric('high', { precision: 6, scale: 2 }).notNull(),
  effectiveFrom: date('effective_from').notNull(),
  note: text('note'),
}, (t) => [
  unique().on(t.serviceKey, t.credentialLevel, t.effectiveFrom),
  check('rate_range_ordered', sql`${t.high} >= ${t.low}`),
]);
