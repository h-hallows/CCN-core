/** Spec § 3.8 and architecture spec § 3.4 — who may sign in, and as what. */
import { check, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { userRole } from './enums';
import { households } from './households';
import { providers } from './providers';

/**
 * One users table for all four audiences. `role` became an enum in migration 0002, and
 * `disabledAt` is how access is withdrawn — rows are never deleted, because an invite,
 * an audit entry and a shortlist request all point at them.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  role: userRole('role').notNull().default('operator'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
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

/**
 * A household may have several users. The son in New York and the daughter in London
 * both need access, and in this business that is the common case, not an edge one.
 */
export const householdUsers = pgTable('household_users', {
  userId: uuid('user_id').notNull().references(() => users.id),
  householdId: uuid('household_id').notNull().references(() => households.id),
  relationship: text('relationship'),
}, (t) => [primaryKey({ columns: [t.userId, t.householdId] })]);

export const providerUsers = pgTable('provider_users', {
  userId: uuid('user_id').primaryKey().references(() => users.id),
  providerId: uuid('provider_id').notNull().unique().references(() => providers.id),
});

/**
 * Invite only. There is no public client signup, because the bench is curated and the
 * referral requires a call; and no public provider signup, because applications are
 * reviewed first.
 */
export const portalInvites = pgTable('portal_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  role: userRole('role').notNull(),
  householdId: uuid('household_id').references(() => households.id),
  providerId: uuid('provider_id').references(() => providers.id),
  tokenHash: text('token_hash').notNull(),
  issuedBy: text('issued_by').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('portal_invites_token').on(t.tokenHash),
  check('portal_invites_subject_matches_role', sql`
    (${t.role} = 'household' AND ${t.householdId} IS NOT NULL AND ${t.providerId} IS NULL) OR
    (${t.role} = 'provider'  AND ${t.providerId}  IS NOT NULL AND ${t.householdId} IS NULL) OR
    (${t.role} IN ('operator','partner'))`),
]);
