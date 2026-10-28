/**
 * Architecture spec § 3.1 and § 3.5 — the published bench, what a household may ask of
 * it, and the consent that governs anything shown publicly.
 */
import { boolean, check, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { shortlistRequestStatus } from './enums';
import { cases, households } from './households';
import { providers } from './providers';
import { referrals } from './compliance';
import { users } from './auth';

/** The client portal shows a curated bench, not a directory, so the bench is a record. */
export const publishedShortlists = pgTable('published_shortlists', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').notNull().references(() => cases.id),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  publishedBy: text('published_by').notNull(),
  /** What the operator told the household when sending it. */
  note: text('note'),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
}, (t) => [index('published_shortlists_case').on(t.caseId, t.publishedAt)]);

export const publishedShortlistItems = pgTable('published_shortlist_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  shortlistId: uuid('shortlist_id').notNull().references(() => publishedShortlists.id),
  providerId: uuid('provider_id').notNull().references(() => providers.id),
  position: integer('position').notNull(),
}, (t) => [unique().on(t.shortlistId, t.providerId)]);

/**
 * THE LOAD-BEARING RULE (architecture spec § 3.1): a row here is a request and nothing
 * more. No trigger, job or route may create a `referrals` row from it — only the
 * console's disclosure transaction does that, and it writes `referralId` back
 * afterwards. This table deliberately carries no trigger at all, because a trigger is
 * exactly the mechanism the rule forbids.
 */
export const shortlistRequests = pgTable('shortlist_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  shortlistId: uuid('shortlist_id').notNull().references(() => publishedShortlists.id),
  providerId: uuid('provider_id').notNull().references(() => providers.id),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  requestedBy: uuid('requested_by').notNull().references(() => users.id),
  status: shortlistRequestStatus('status').notNull().default('pending'),
  note: text('note'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  /** Set only by the console, after the referral exists. */
  referralId: uuid('referral_id').references(() => referrals.id),
}, (t) => [
  // Keeps the two records from disagreeing. It does not create a referral.
  check('shortlist_request_referred_has_referral', sql`
    (${t.status} = 'referred' AND ${t.referralId} IS NOT NULL)
    OR (${t.status} <> 'referred' AND ${t.referralId} IS NULL)`),
]);

export const consents = pgTable('consents', {
  id: uuid('id').primaryKey().defaultRandom(),
  subjectType: text('subject_type').notNull(),
  subjectId: uuid('subject_id').notNull(),
  kind: text('kind').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull(),
  grantedBy: text('granted_by').notNull(),
  scopeNote: text('scope_note'),
  evidenceUrl: text('evidence_url'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  index('consents_subject').on(t.subjectType, t.subjectId),
  check('consents_subject_type', sql`${t.subjectType} IN ('household','provider')`),
  check('consents_kind', sql`${t.kind} IN ('photo','testimonial','case_study')`),
]);

/**
 * Household-level only, never attributed to a named provider (front door spec § 4.3).
 * A trigger refuses to publish one whose consent has been revoked.
 */
export const testimonials = pgTable('testimonials', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: uuid('household_id').notNull().references(() => households.id),
  consentId: uuid('consent_id').notNull().references(() => consents.id),
  body: text('body').notNull(),
  /** "James T., San Marino" — never a full name, never a provider. */
  attribution: text('attribution').notNull(),
  serviceLine: text('service_line'),
  published: boolean('published').notNull().default(false),
});
