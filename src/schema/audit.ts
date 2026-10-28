/**
 * Spec § 3.8 and § 8 — the audit log, and the instrumentation that answers whether the
 * platform is worth funding.
 */
import { check, index, jsonb, numeric, pgTable, primaryKey, text, timestamp, uuid, date } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { metricEvent, serviceFailureKind } from './enums';
import { cases } from './households';
import { providers } from './providers';

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
