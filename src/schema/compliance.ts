/** Spec § 3.6 and § 3.7 — the compliance record. Append-only at the database level. */
import { boolean, check, date, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { referralOutcome, timelineType } from './enums';
import { cases, households } from './households';
import { providers } from './providers';

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
