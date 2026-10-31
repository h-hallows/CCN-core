/** Support tables for the public intake surface. Web build spec § 3 and § 7. */
import { bigserial, index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { urgency } from './enums';

/** Hashed key: an IP beside "post-surgical, Beverly Hills" is identifying. */
export const rateLimitHits = pgTable('rate_limit_hits', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  keyHash: text('key_hash').notNull(),
  route: text('route').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('rate_limit_window').on(t.route, t.keyHash, t.at)]);

export const notificationKind = pgEnum('notification_kind', [
  'inquiry', 'provider_application', 'partner_referral', 'shortlist_request',
  'shortlist_published', 'written_statement_due', 'nurse_disclosure_outstanding',
  'credential_expiring', 'portal_invite',
]);

/**
 * The outbox. A notification that exists only as a console.log is one that was never
 * sent; writing the row first means nothing is lost before a mail provider is wired.
 *
 * `subject` and `body` carry nothing identifying — spec § 7. The detail the console
 * needs lives in `payload`, which never reaches an inbox.
 */
export const operatorNotifications = pgTable('operator_notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: notificationKind('kind').notNull(),
  urgency: urgency('urgency'),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  deliveryMethod: text('delivery_method'),
  readAt: timestamp('read_at', { withTimezone: true }),
});
