/**
 * Documents. Migration 0015.
 *
 * The bytes live in Postgres rather than in object storage, so there is no second store
 * to disagree with the record and no second set of signed-URL semantics to get right;
 * row-level security already governs who may read a household's information, and the
 * bytes sit behind the same policies. `storage` carries one value today and is here so
 * an external backend can be added later without the existing rows meaning something
 * different.
 *
 * Append-only, apart from redaction. A document is evidence: if one is wrong the right
 * answer is to upload the correct one and keep both. Redaction exists because
 * append-only has a worse failure mode than losing history — file one household's
 * paperwork against another and you cannot un-leak it — so it drops the bytes and keeps
 * the row, the digest and the reason.
 *
 * `sha256_hex` is checked by the database against the bytes themselves, which is what
 * lets it be quoted as evidence rather than as something the application asserted.
 */
import { boolean, check, index, integer, pgTable, text, timestamp, uuid, customType } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { documentKind, documentStorage } from './enums';
import { cases, households } from './households';
import { credentials, providers } from './providers';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: documentKind('kind').notNull(),
  storage: documentStorage('storage').notNull().default('postgres'),

  providerId: uuid('provider_id').references(() => providers.id),
  householdId: uuid('household_id').references(() => households.id),
  caseId: uuid('case_id').references(() => cases.id),
  credentialId: uuid('credential_id').references(() => credentials.id),

  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  sha256Hex: text('sha256_hex').notNull(),
  bytes: bytea('bytes'),

  uploadedBy: text('uploaded_by').notNull(),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  note: text('note'),

  /** The operator's deliberate act. A document is the registry's file by default. */
  visibleToSubject: boolean('visible_to_subject').notNull().default(false),

  redactedAt: timestamp('redacted_at', { withTimezone: true }),
  redactedBy: text('redacted_by'),
  redactionReason: text('redaction_reason'),
}, (t) => [
  index('documents_provider').on(t.providerId, t.uploadedAt),
  index('documents_household').on(t.householdId, t.uploadedAt),
  index('documents_case').on(t.caseId, t.uploadedAt),
  index('documents_credential').on(t.credentialId),

  check('documents_one_subject', sql`
    (${t.providerId} IS NOT NULL)::int
  + (${t.householdId} IS NOT NULL)::int
  + (${t.caseId} IS NOT NULL)::int = 1`),

  check('documents_credential_needs_provider', sql`
    ${t.credentialId} IS NULL OR ${t.providerId} IS NOT NULL`),

  check('documents_size', sql`${t.byteSize} BETWEEN 1 AND 10485760`),

  check('documents_digest_format', sql`${t.sha256Hex} ~ '^[0-9a-f]{64}$'`),

  check('documents_bytes_match', sql`
    (${t.redactedAt} IS NULL
      AND ${t.bytes} IS NOT NULL
      AND ${t.byteSize} = octet_length(${t.bytes})
      AND ${t.sha256Hex} = encode(sha256(${t.bytes}), 'hex'))
    OR
    (${t.redactedAt} IS NOT NULL
      AND ${t.bytes} IS NULL
      AND ${t.redactedBy} IS NOT NULL
      AND ${t.redactionReason} IS NOT NULL)`),
]);
