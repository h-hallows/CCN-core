/**
 * Architecture spec § 3.3 — public intake. Two write paths, neither creates a live
 * record.
 *
 * Public forms write here and nowhere else. No public path creates a `households`,
 * `cases` or `providers` row; the operator converts from the console. That keeps the
 * entire live record set behind one human, which is both the compliance posture and the
 * product.
 */
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { careType, paymentMethod, providerType, urgency } from './enums';
import { households, referralPartners } from './households';
import { providers } from './providers';

export const inquiries = pgTable('inquiries', {
  id: uuid('id').primaryKey().defaultRandom(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  relationship: text('relationship'),
  careType: careType('care_type'),
  area: text('area'),
  patternNote: text('pattern_note'),
  startNote: text('start_note'),
  urgency: urgency('urgency'),
  paymentMethod: paymentMethod('payment_method'),
  message: text('message'),
  /** Which page it came from, so the front door can be measured page by page. */
  sourcePath: text('source_path'),
  utm: jsonb('utm'),
  partnerId: uuid('partner_id').references(() => referralPartners.id),
  /**
   * The partner block for an account-less referral: who sent it, their role, the
   * patient's initials, and their confirmation that the family agreed. Never a full
   * patient name. See migration 0005.
   */
  referrer: jsonb('referrer'),
  /** Set when the operator converts this into a household. */
  householdId: uuid('household_id').references(() => households.id),
  handledAt: timestamp('handled_at', { withTimezone: true }),
  handledBy: text('handled_by'),
}, (t) => [index('inquiries_unhandled').on(t.receivedAt)]);

export const providerApplications = pgTable('provider_applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  fullName: text('full_name').notNull(),
  phone: text('phone'),
  email: text('email'),
  type: providerType('type'),
  licenseNumber: text('license_number'),
  areas: text('areas').array(),
  languages: text('languages').array(),
  specialties: text('specialties').array(),
  experienceNote: text('experience_note'),
  message: text('message'),
  /** Set when the operator onboards them. Applications are reviewed, never self-serve. */
  providerId: uuid('provider_id').references(() => providers.id),
  handledAt: timestamp('handled_at', { withTimezone: true }),
  handledBy: text('handled_by'),
}, (t) => [index('provider_applications_unhandled').on(t.receivedAt)]);
