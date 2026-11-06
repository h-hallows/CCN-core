/**
 * Documents. Migration 0015.
 *
 * The thing worth testing is not that bytes round-trip — it is that the row cannot lie
 * about them, that nobody can quietly rewrite or remove one, and that the bytes sit
 * behind the same row-level security as everything else a household owns.
 */
import { createHash, randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '../src/db/client';
import { asClaims, expectDenied, expectRejection, seededDb } from '../src/testing/db';

let db: DbHandle;
let providerId: string;
let householdId: string;
let caseId: string;
let otherHouseholdId: string;
let householdUserId: string;
let providerUserId: string;

const hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await db.query<T>(sql, params);
  if (!row) throw new Error(`fixture query returned no rows: ${sql}`);
  return row;
}

/** A document the operator filed, with whatever overrides a test needs. */
async function file(
  columns: Record<string, unknown>,
  body = randomBytes(64),
): Promise<string> {
  const base: Record<string, unknown> = {
    kind: 'other',
    filename: 'scan.pdf',
    content_type: 'application/pdf',
    byte_size: body.length,
    sha256_hex: hex(body),
    bytes: body,
    uploaded_by: 'operator',
    ...columns,
  };
  const keys = Object.keys(base);
  const row = await one<{ id: string }>(
    `INSERT INTO documents (${keys.join(', ')})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING id`,
    keys.map((k) => base[k]),
  );
  return row.id;
}

beforeAll(async () => {
  db = await seededDb();
  providerId = (await one<{ id: string }>(
    `SELECT id FROM providers WHERE deleted_at IS NULL ORDER BY id LIMIT 1`)).id;
  const kase = await one<{ id: string; household_id: string }>(
    `SELECT id, household_id FROM cases WHERE deleted_at IS NULL ORDER BY id LIMIT 1`);
  caseId = kase.id;
  householdId = kase.household_id;
  otherHouseholdId = (await one<{ id: string }>(
    `SELECT id FROM households WHERE id <> $1 ORDER BY id LIMIT 1`, [householdId])).id;

  householdUserId = (await one<{ id: string }>(
    `INSERT INTO users (email, display_name, role)
     VALUES ('doc-household@example.com', 'Family', 'household') RETURNING id`)).id;
  await db.query(
    `INSERT INTO household_users (household_id, user_id) VALUES ($1, $2)`,
    [householdId, householdUserId]);

  providerUserId = (await one<{ id: string }>(
    `INSERT INTO users (email, display_name, role)
     VALUES ('doc-provider@example.com', 'Nurse', 'provider') RETURNING id`)).id;
  await db.query(
    `INSERT INTO provider_users (provider_id, user_id) VALUES ($1, $2)`,
    [providerId, providerUserId]);
});

const household = () => ({
  ccn_role: 'household', ccn_household_id: householdId, ccn_user_id: householdUserId,
});
const provider = () => ({
  ccn_role: 'provider', ccn_provider_id: providerId, ccn_user_id: providerUserId,
});

describe('a row cannot lie about its bytes', () => {
  it('round-trips the file and the digest the database computed for itself', async () => {
    const body = Buffer.from('a scanned Live Scan result');
    const id = await file({ kind: 'credential', provider_id: providerId }, body);

    const row = await one<{ sha256_hex: string; byte_size: number; bytes: Buffer }>(
      `SELECT sha256_hex, byte_size, bytes FROM documents WHERE id = $1`, [id]);
    expect(row.sha256_hex).toBe(hex(body));
    expect(row.byte_size).toBe(body.length);
    expect(Buffer.from(row.bytes).equals(body)).toBe(true);
  });

  it('refuses a digest that does not match the bytes', async () => {
    const body = Buffer.from('the real file');
    await expectRejection(
      () => file(
        { provider_id: providerId, sha256_hex: hex(Buffer.from('a different file')) },
        body,
      ),
      /documents_bytes_match|violates check/i,
    );
  });

  it('refuses a size that does not match the bytes', async () => {
    await expectRejection(
      () => file({ provider_id: providerId, byte_size: 999 }),
      /documents_bytes_match|violates check/i,
    );
  });

  it('refuses a digest that is not a hex SHA-256 at all', async () => {
    await expectRejection(
      () => file({ provider_id: providerId, sha256_hex: 'not-a-digest' }),
      /documents_digest_format|violates check/i,
    );
  });

  it('refuses an empty file — the lower end of the same constraint', async () => {
    await expectRejection(
      () => file({ provider_id: providerId }, Buffer.alloc(0)),
      /documents_size|violates check/i,
    );
  });

  /*
   * The upper bound is asserted from the catalogue rather than by sending 10 MB.
   *
   * PGlite is Postgres compiled to WASM with a fixed heap, and a parameter that size
   * takes the instance down with "memory access out of bounds" — which fails the whole
   * file, not just this test, and says nothing about the constraint. The real engine
   * exercise is below, and runs when the suite is pointed at a real Postgres.
   */
  it('declares the 10 MB ceiling', async () => {
    const row = await one<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'documents_size'`);
    expect(row.def).toContain('10485760');
  });

  it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
    'refuses something over the ceiling, on an engine that can be handed one',
    async () => {
      const body = randomBytes(10 * 1024 * 1024 + 1);
      await expectRejection(
        () => file({ provider_id: providerId }, body),
        /documents_size|violates check/i,
      );
    });

  it('insists a document belongs to exactly one subject', async () => {
    await expectRejection(
      () => file({}),
      /documents_one_subject|violates check/i,
    );
    await expectRejection(
      () => file({ provider_id: providerId, household_id: householdId }),
      /documents_one_subject|violates check/i,
    );
  });

  it('a credential document must name the provider it belongs to', async () => {
    const credential = await one<{ id: string; provider_id: string }>(
      `SELECT id, provider_id FROM credentials ORDER BY id LIMIT 1`);
    await expectRejection(
      () => file({ household_id: householdId, credential_id: credential.id }),
      /documents_credential_needs_provider|documents_one_subject|violates check/i,
    );
    const ok = await file({
      kind: 'credential',
      provider_id: credential.provider_id,
      credential_id: credential.id,
    });
    expect(ok).toBeTruthy();
  });
});

describe('a document is evidence', () => {
  it('cannot be deleted, by anyone', async () => {
    const id = await file({ provider_id: providerId });
    await expectRejection(
      () => db.query(`DELETE FROM documents WHERE id = $1`, [id]),
      /evidence|redact/i,
    );
  });

  it('can be shared and unshared, because that is a permission and not the file', async () => {
    /*
     * 0015 froze this flag at insert, which meant an operator who ticked "share" by
     * mistake could only correct it by destroying the file. 0016 separates the two: the
     * document is evidence and cannot change; who may currently see it is live, and the
     * audit log carries the before and after of every change to it.
     */
    const id = await file({ case_id: caseId });

    await db.query(`UPDATE documents SET visible_to_subject = true WHERE id = $1`, [id]);
    await db.query(`UPDATE documents SET visible_to_subject = false WHERE id = $1`, [id]);

    const row = await one<{ visible_to_subject: boolean; bytes: Buffer | null }>(
      `SELECT visible_to_subject, bytes FROM documents WHERE id = $1`, [id]);
    expect(row.visible_to_subject).toBe(false);
    expect(row.bytes).not.toBeNull();
  });

  it('cannot be unshared and rewritten in the same breath', async () => {
    const other = randomBytes(16);
    const id = await file({ case_id: caseId });
    await expectRejection(
      () => db.query(
        `UPDATE documents SET visible_to_subject = true, bytes = $2,
                              sha256_hex = $3, byte_size = $4
          WHERE id = $1`,
        [id, other, hex(other), other.length]),
      /immutable/i,
    );
  });

  it('a redacted document cannot stay shared', async () => {
    const id = await file({ case_id: caseId, visible_to_subject: true });
    await expectRejection(
      () => db.query(
        `UPDATE documents SET redacted_at = now(), redacted_by = 'operator',
                              redaction_reason = 'wrong family', bytes = NULL
          WHERE id = $1`, [id]),
      /cannot stay shared/i,
    );
    // Unshared first, then redacted. Both steps are recorded.
    await db.query(`UPDATE documents SET visible_to_subject = false WHERE id = $1`, [id]);
    await db.query(
      `UPDATE documents SET redacted_at = now(), redacted_by = 'operator',
                            redaction_reason = 'wrong family', bytes = NULL
        WHERE id = $1`, [id]);
    const row = await one<{ bytes: Buffer | null }>(
      `SELECT bytes FROM documents WHERE id = $1`, [id]);
    expect(row.bytes).toBeNull();
  });

  it('cannot be rewritten — not the bytes, not the name, not who filed it', async () => {
    const other = randomBytes(32);
    const id = await file({ provider_id: providerId });

    for (const [sql, params] of [
      [`UPDATE documents SET filename = 'other.pdf' WHERE id = $1`, [id]],
      [`UPDATE documents SET uploaded_by = 'somebody else' WHERE id = $1`, [id]],
      [`UPDATE documents SET kind = 'registry_agreement' WHERE id = $1`, [id]],
      [`UPDATE documents SET bytes = $2, sha256_hex = $3, byte_size = $4 WHERE id = $1`,
        [id, other, hex(other), other.length]],
    ] as [string, unknown[]][]) {
      await expectRejection(() => db.query(sql, params), /immutable|redaction/i);
    }
  });

  it('can be redacted, which keeps the record and drops the file', async () => {
    const body = Buffer.from('filed against the wrong household');
    const id = await file({ household_id: householdId }, body);

    await db.query(
      `UPDATE documents
          SET redacted_at = now(), redacted_by = 'operator',
              redaction_reason = 'Filed against the wrong household.', bytes = NULL
        WHERE id = $1`,
      [id]);

    const row = await one<{
      bytes: Buffer | null; sha256_hex: string; byte_size: number;
      uploaded_by: string; redaction_reason: string;
    }>(
      `SELECT bytes, sha256_hex, byte_size, uploaded_by, redaction_reason
         FROM documents WHERE id = $1`, [id]);

    // The file is gone. What it was, who filed it and why it went are not.
    expect(row.bytes).toBeNull();
    expect(row.sha256_hex).toBe(hex(body));
    expect(row.byte_size).toBe(body.length);
    expect(row.uploaded_by).toBe('operator');
    expect(row.redaction_reason).toBe('Filed against the wrong household.');
  });

  it('refuses a redaction that keeps the bytes, or gives no reason, or repeats', async () => {
    const id = await file({ household_id: householdId });

    await expectRejection(
      () => db.query(
        `UPDATE documents SET redacted_at = now(), redacted_by = 'operator',
                              redaction_reason = 'changed my mind'
          WHERE id = $1`, [id]),
      /drop the bytes|violates check/i,
    );
    await expectRejection(
      () => db.query(
        `UPDATE documents SET redacted_at = now(), redacted_by = 'operator', bytes = NULL
          WHERE id = $1`, [id]),
      /documents_bytes_match|violates check/i,
    );

    await db.query(
      `UPDATE documents SET redacted_at = now(), redacted_by = 'operator',
                            redaction_reason = 'wrong file', bytes = NULL
        WHERE id = $1`, [id]);
    await expectRejection(
      () => db.query(
        `UPDATE documents SET redacted_at = now(), redacted_by = 'operator',
                              redaction_reason = 'again', bytes = NULL
          WHERE id = $1`, [id]),
      /already redacted/i,
    );
  });
});

describe('who may read one', () => {
  it('a household sees only what was shared with it, and the bytes come with it', async () => {
    const shared = Buffer.from('the written statement we sent you');
    const sharedId = await file(
      { kind: 'written_statement', case_id: caseId, visible_to_subject: true }, shared);
    const privateId = await file({ kind: 'other', case_id: caseId });

    const rows = await asClaims(db, household(), (tx) => tx.query<{ id: string; bytes: Buffer }>(
      `SELECT id, bytes FROM documents WHERE id = ANY($1::uuid[])`, [[sharedId, privateId]]));

    expect(rows.map((r) => r.id)).toEqual([sharedId]);
    expect(Buffer.from(rows[0]!.bytes).equals(shared)).toBe(true);
  });

  it('another household sees neither', async () => {
    const id = await file({ case_id: caseId, visible_to_subject: true });
    const rows = await asClaims(
      db,
      { ccn_role: 'household', ccn_household_id: otherHouseholdId, ccn_user_id: householdUserId },
      (tx) => tx.query(`SELECT id FROM documents WHERE id = $1`, [id]));
    expect(rows).toEqual([]);
  });

  it('a redacted document is not readable by its subject at all', async () => {
    const id = await file({ case_id: caseId, visible_to_subject: true });
    await db.query(`UPDATE documents SET visible_to_subject = false WHERE id = $1`, [id]);
    await db.query(
      `UPDATE documents SET redacted_at = now(), redacted_by = 'operator',
                            redaction_reason = 'wrong family', bytes = NULL
        WHERE id = $1`, [id]);
    const rows = await asClaims(db, household(), (tx) =>
      tx.query(`SELECT id FROM documents WHERE id = $1`, [id]));
    expect(rows).toEqual([]);
  });

  it('a provider sees their own shared documents and nobody else\'s', async () => {
    const mine = await file(
      { kind: 'registry_agreement', provider_id: providerId, visible_to_subject: true });
    const minePrivate = await file({ kind: 'other', provider_id: providerId });
    const theirs = await file({ case_id: caseId, visible_to_subject: true });

    const rows = await asClaims(db, provider(), (tx) => tx.query<{ id: string }>(
      `SELECT id FROM documents WHERE id = ANY($1::uuid[])`,
      [[mine, minePrivate, theirs]]));
    expect(rows.map((r) => r.id)).toEqual([mine]);
  });
});

describe('what a provider may hand in', () => {
  /*
   * NOTE FOR THE UPLOAD CODE: no `RETURNING`.
   *
   * Under row-level security, `INSERT ... RETURNING` also needs a SELECT policy that
   * matches the new row — and a provider's SELECT policy requires `visible_to_subject`,
   * which their own INSERT is forbidden from setting. So the insert succeeds and the
   * RETURNING is refused, which reads as "the upload failed" and is not. The portal
   * inserts a client-generated id instead of asking for one back.
   */
  it('can file a credential document against themselves', async () => {
    const body = Buffer.from('my renewed TB clearance');
    await asClaims(db, provider(), (tx) => tx.query(
      `INSERT INTO documents (kind, provider_id, filename, content_type, byte_size,
                              sha256_hex, bytes, uploaded_by)
       VALUES ('credential', $1, 'tb.pdf', 'application/pdf', $2, $3, $4, 'provider')`,
      [providerId, body.length, hex(body), body]));

    const row = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM documents
        WHERE provider_id = $1 AND sha256_hex = $2 AND uploaded_by = 'provider'`,
      [providerId, hex(body)]);
    expect(Number(row.n)).toBe(1);
  });

  it('cannot read back what it just filed, which is why the upload asks for no id', async () => {
    const body = Buffer.from('handed in, not shared back');
    await expectDenied(() => asClaims(db, provider(), (tx) => tx.query(
      `INSERT INTO documents (kind, provider_id, filename, content_type, byte_size,
                              sha256_hex, bytes, uploaded_by)
       VALUES ('credential', $1, 'x.pdf', 'application/pdf', $2, $3, $4, 'provider')
       RETURNING id`,
      [providerId, body.length, hex(body), body])));
  });

  it('cannot file one against another provider, or against a household', async () => {
    const body = Buffer.from('not mine to file');
    const otherProvider = await one<{ id: string }>(
      `SELECT id FROM providers WHERE id <> $1 ORDER BY id LIMIT 1`, [providerId]);

    await expectDenied(() => asClaims(db, provider(), (tx) => tx.query(
      `INSERT INTO documents (kind, provider_id, filename, content_type, byte_size,
                              sha256_hex, bytes, uploaded_by)
       VALUES ('credential', $1, 'x.pdf', 'application/pdf', $2, $3, $4, 'provider')`,
      [otherProvider.id, body.length, hex(body), body])));

    await expectDenied(() => asClaims(db, provider(), (tx) => tx.query(
      `INSERT INTO documents (kind, household_id, filename, content_type, byte_size,
                              sha256_hex, bytes, uploaded_by)
       VALUES ('credential', $1, 'x.pdf', 'application/pdf', $2, $3, $4, 'provider')`,
      [householdId, body.length, hex(body), body])));
  });

  it('cannot decide that what they handed in is shared back to them', async () => {
    /*
     * `visible_to_subject` governs what the registry shares, not what the subject wants
     * to see. Letting the uploader set it would make the subject the author of their
     * own permissions — and the next document filed against them, by the operator,
     * would inherit a flag nobody chose.
     */
    const body = Buffer.from('marked as shared by me');
    await expectDenied(() => asClaims(db, provider(), (tx) => tx.query(
      `INSERT INTO documents (kind, provider_id, filename, content_type, byte_size,
                              sha256_hex, bytes, uploaded_by, visible_to_subject)
       VALUES ('credential', $1, 'x.pdf', 'application/pdf', $2, $3, $4, 'provider', true)`,
      [providerId, body.length, hex(body), body])));
  });

  it('cannot file something that is not a credential document', async () => {
    const body = Buffer.from('a registry agreement I wrote myself');
    await expectDenied(() => asClaims(db, provider(), (tx) => tx.query(
      `INSERT INTO documents (kind, provider_id, filename, content_type, byte_size,
                              sha256_hex, bytes, uploaded_by)
       VALUES ('registry_agreement', $1, 'x.pdf', 'application/pdf', $2, $3, $4, 'provider')`,
      [providerId, body.length, hex(body), body])));
  });

  it('cannot redact or rewrite what they handed in', async () => {
    /*
     * There is no provider UPDATE policy, so this changes nothing rather than raising.
     * The assertion is on the row, not on an exception: an UPDATE that matches no rows
     * under RLS succeeds quietly, and "it did not throw" would have been a green test
     * for a policy that did not exist.
     */
    const id = await file(
      { kind: 'credential', provider_id: providerId, visible_to_subject: true });

    await asClaims(db, provider(), async (tx) => {
      const changed = await tx.query(
        `UPDATE documents SET redacted_at = now(), redacted_by = 'me',
                              redaction_reason = 'withdrawn', bytes = NULL
          WHERE id = $1 RETURNING id`, [id]);
      expect(changed).toEqual([]);
    });

    const row = await one<{ redacted_at: string | null; bytes: Buffer | null }>(
      `SELECT redacted_at::text, bytes FROM documents WHERE id = $1`, [id]);
    expect(row.redacted_at).toBeNull();
    expect(row.bytes).not.toBeNull();
  });

  it('a household cannot file anything at all', async () => {
    const body = Buffer.from('from the family');
    await expectDenied(() => asClaims(db, household(), (tx) => tx.query(
      `INSERT INTO documents (kind, case_id, filename, content_type, byte_size,
                              sha256_hex, bytes, uploaded_by)
       VALUES ('other', $1, 'x.pdf', 'application/pdf', $2, $3, $4, 'household')`,
      [caseId, body.length, hex(body), body])));
  });
});
