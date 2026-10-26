/**
 * Migration 0002 — architecture spec § 3.
 *
 * The rule this file exists for: a `shortlist_requests` row is a request and nothing
 * more. No trigger, job or route may turn it into a referral. Only the console's
 * disclosure transaction does that.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '../src/db/client';
import { caseIdWhere, expectRejection, providerIdByName, seededDb } from '../src/testing/db';

let db: DbHandle;
let caseId: string;
let providerId: string;
let userId: string;
let shortlistId: string;

beforeAll(async () => {
  db = await seededDb();
  caseId = await caseIdWhere(db, `c.status = 'active'`);
  providerId = await providerIdByName(db, 'Imelda Santoyo');

  const [user] = await db.query<{ id: string }>(
    `INSERT INTO users (email, display_name, role)
     VALUES ('household@example.com', 'Household member', 'household')
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
  );
  userId = user!.id;

  const [list] = await db.query<{ id: string }>(
    `INSERT INTO published_shortlists (case_id, published_by, note)
     VALUES ($1, 'operator', 'Three people we would send') RETURNING id`,
    [caseId],
  );
  shortlistId = list!.id;

  await db.query(
    `INSERT INTO published_shortlist_items (shortlist_id, provider_id, position)
     VALUES ($1, $2, 1)`,
    [shortlistId, providerId],
  );
});

describe('§ 3.1 a request is a request, not a referral', () => {
  it('records a pending request with no referral attached', async () => {
    const [row] = await db.query<{ status: string; referral_id: string | null }>(
      `INSERT INTO shortlist_requests (shortlist_id, provider_id, requested_by, note)
       VALUES ($1, $2, $3, 'Could we meet her?')
       RETURNING status, referral_id`,
      [shortlistId, providerId, userId],
    );
    expect(row!.status).toBe('pending');
    expect(row!.referral_id).toBeNull();
  });

  it('creates no referral as a side effect — the whole point of the rule', async () => {
    const before = await db.query<{ n: string }>(`SELECT count(*) AS n FROM referrals`);
    await db.query(
      `INSERT INTO shortlist_requests (shortlist_id, provider_id, requested_by)
       VALUES ($1, $2, $3)`,
      [shortlistId, providerId, userId],
    );
    const after = await db.query<{ n: string }>(`SELECT count(*) AS n FROM referrals`);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('carries no trigger at all, because a trigger is the mechanism the rule forbids', async () => {
    const rows = await db.query<{ trigger_name: string }>(
      `SELECT trigger_name FROM information_schema.triggers
        WHERE event_object_table = 'shortlist_requests'`,
    );
    expect(rows).toEqual([]);
  });

  it('cannot claim to be referred without naming the referral', async () => {
    await expectRejection(
      () => db.query(
        `INSERT INTO shortlist_requests (shortlist_id, provider_id, requested_by, status)
         VALUES ($1, $2, $3, 'referred')`,
        [shortlistId, providerId, userId],
      ),
      /shortlist_request_referred_has_referral|check constraint/i,
    );
  });

  it('cannot name a referral while still pending', async () => {
    const [ref] = await db.query<{ id: string }>(`SELECT id FROM referrals LIMIT 1`);
    await expectRejection(
      () => db.query(
        `INSERT INTO shortlist_requests (shortlist_id, provider_id, requested_by, referral_id)
         VALUES ($1, $2, $3, $4)`,
        [shortlistId, providerId, userId, ref!.id],
      ),
      /shortlist_request_referred_has_referral|check constraint/i,
    );
  });

  it('accepts the resolution the console writes: referred, with its referral', async () => {
    const [ref] = await db.query<{ id: string }>(`SELECT id FROM referrals LIMIT 1`);
    const [row] = await db.query<{ status: string }>(
      `INSERT INTO shortlist_requests
         (shortlist_id, provider_id, requested_by, status, referral_id, resolved_at)
       VALUES ($1, $2, $3, 'referred', $4, now())
       RETURNING status`,
      [shortlistId, providerId, userId, ref!.id],
    );
    expect(row!.status).toBe('referred');
  });
});

describe('§ 3.2 the staleness view', () => {
  it('runs as the caller, so row level security is not bypassed by querying through it', async () => {
    const [row] = await db.query<{ opts: string | null }>(
      `SELECT array_to_string(reloptions, ',') AS opts
         FROM pg_class WHERE relname = 'v_shortlist_items_client'`,
    );
    expect(row!.opts).toContain('security_invoker=true');
  });

  it('marks an eligible provider available', async () => {
    const rows = await db.query<{ appears_available: boolean }>(
      `SELECT appears_available FROM v_shortlist_items_client WHERE provider_id = $1`,
      [providerId],
    );
    expect(rows[0]!.appears_available).toBe(true);
  });

  it('marks a provider with a lapsed credential unavailable', async () => {
    const lapsed = await providerIdByName(db, 'Grace Okonkwo');
    await db.query(
      `INSERT INTO published_shortlist_items (shortlist_id, provider_id, position)
       VALUES ($1, $2, 2)`,
      [shortlistId, lapsed],
    );
    const rows = await db.query<{ appears_available: boolean }>(
      `SELECT appears_available FROM v_shortlist_items_client WHERE provider_id = $1`,
      [lapsed],
    );
    expect(rows[0]!.appears_available).toBe(false);
  });

  it('exposes no credential detail — a household has no business seeing the reason', async () => {
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'v_shortlist_items_client'`,
    );
    const names = cols.map((c) => c.column_name);
    for (const leak of ['expires_on', 'verified_on', 'verification_source', 'document_url']) {
      expect(names).not.toContain(leak);
    }
  });
});

describe('§ 3.3 public intake creates no live record', () => {
  it('accepts an inquiry that is attached to no household', async () => {
    const [row] = await db.query<{ household_id: string | null; handled_at: string | null }>(
      `INSERT INTO inquiries (name, phone, care_type, area, urgency, message)
       VALUES ('Dov Rosenthal', '(626) 555-0000', 'companion', 'La Cañada', 'discharge',
               'Mum is discharged tomorrow and nobody is local.')
       RETURNING household_id, handled_at`,
    );
    expect(row!.household_id).toBeNull();
    expect(row!.handled_at).toBeNull();
  });

  it('accepts a provider application that is attached to no provider', async () => {
    const [row] = await db.query<{ provider_id: string | null }>(
      `INSERT INTO provider_applications (full_name, type, areas)
       VALUES ('A Applicant', 'CNA', ARRAY['Pasadena'])
       RETURNING provider_id`,
    );
    expect(row!.provider_id).toBeNull();
  });

  it('leaves the live record counts untouched', async () => {
    const [row] = await db.query<{ households: string; providers: string; cases: string }>(
      `SELECT (SELECT count(*) FROM households)::text AS households,
              (SELECT count(*) FROM providers)::text  AS providers,
              (SELECT count(*) FROM cases)::text      AS cases`,
    );
    expect(row!.households).toBe('12');
    expect(row!.providers).toBe('18');
    expect(row!.cases).toBe('12');
  });
});

describe('§ 3.4 invite-only portal access', () => {
  it('keeps the four roles and rejects anything else', async () => {
    const rows = await db.query<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'user_role' ORDER BY e.enumsortorder`,
    );
    expect(rows.map((r) => r.label)).toEqual(['operator', 'household', 'provider', 'partner']);
  });

  it('migrated the existing operator without losing them', async () => {
    const rows = await db.query(`SELECT 1 FROM users WHERE role = 'operator'`);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('lets one household have several users, which is the common case', async () => {
    const householdId = await db.query<{ household_id: string }>(
      `SELECT household_id FROM cases WHERE id = $1`, [caseId],
    ).then((r) => r[0]!.household_id);

    const [second] = await db.query<{ id: string }>(
      `INSERT INTO users (email, display_name, role)
       VALUES ('sibling@example.com', 'Sibling', 'household') RETURNING id`,
    );
    await db.query(
      `INSERT INTO household_users (user_id, household_id, relationship)
       VALUES ($1, $3, 'Son'), ($2, $3, 'Daughter')`,
      [userId, second!.id, householdId],
    );
    const rows = await db.query(
      `SELECT 1 FROM household_users WHERE household_id = $1`, [householdId],
    );
    expect(rows).toHaveLength(2);
  });

  it('refuses a household invite with no household on it', async () => {
    await expectRejection(
      () => db.query(
        `INSERT INTO portal_invites (email, role, token_hash, issued_by, expires_at)
         VALUES ('x@example.com', 'household', 'hash-a', 'operator', now() + interval '7 days')`,
      ),
      /check constraint|portal_invites/i,
    );
  });

  it('refuses a provider invite that names a household instead', async () => {
    const householdId = await db.query<{ id: string }>(
      `SELECT id FROM households LIMIT 1`,
    ).then((r) => r[0]!.id);
    await expectRejection(
      () => db.query(
        `INSERT INTO portal_invites (email, role, household_id, token_hash, issued_by, expires_at)
         VALUES ('y@example.com', 'provider', $1, 'hash-b', 'operator', now() + interval '7 days')`,
        [householdId],
      ),
      /check constraint|portal_invites/i,
    );
  });
});

describe('§ 3.5 a testimonial cannot outlive its consent', () => {
  it('publishes on a live consent', async () => {
    const householdId = await db.query<{ id: string }>(
      `SELECT id FROM households LIMIT 1`,
    ).then((r) => r[0]!.id);
    const [consent] = await db.query<{ id: string }>(
      `INSERT INTO consents (subject_type, subject_id, kind, granted_at, granted_by)
       VALUES ('household', $1, 'testimonial', now(), 'operator') RETURNING id`,
      [householdId],
    );
    const [t] = await db.query<{ published: boolean }>(
      `INSERT INTO testimonials (household_id, consent_id, body, attribution, published)
       VALUES ($1, $2, 'They found someone my father actually likes.', 'James T., San Marino', true)
       RETURNING published`,
      [householdId, consent!.id],
    );
    expect(t!.published).toBe(true);
  });

  it('refuses to publish on a revoked consent', async () => {
    const householdId = await db.query<{ id: string }>(
      `SELECT id FROM households LIMIT 1`,
    ).then((r) => r[0]!.id);
    const [consent] = await db.query<{ id: string }>(
      `INSERT INTO consents (subject_type, subject_id, kind, granted_at, granted_by, revoked_at)
       VALUES ('household', $1, 'testimonial', now() - interval '1 year', 'operator', now())
       RETURNING id`,
      [householdId],
    );
    await expectRejection(
      () => db.query(
        `INSERT INTO testimonials (household_id, consent_id, body, attribution, published)
         VALUES ($1, $2, 'Should never appear.', 'Anon', true)`,
        [householdId, consent!.id],
      ),
      /consent was revoked/i,
    );
  });

  it('still allows the unpublished record to exist, so revocation is not deletion', async () => {
    const householdId = await db.query<{ id: string }>(
      `SELECT id FROM households LIMIT 1`,
    ).then((r) => r[0]!.id);
    const [consent] = await db.query<{ id: string }>(
      `INSERT INTO consents (subject_type, subject_id, kind, granted_at, granted_by, revoked_at)
       VALUES ('household', $1, 'testimonial', now() - interval '1 year', 'operator', now())
       RETURNING id`,
      [householdId],
    );
    const [t] = await db.query<{ published: boolean }>(
      `INSERT INTO testimonials (household_id, consent_id, body, attribution)
       VALUES ($1, $2, 'Kept, not shown.', 'Anon') RETURNING published`,
      [householdId, consent!.id],
    );
    expect(t!.published).toBe(false);
  });
});

describe('row level security covers the new tables too', () => {
  it('enables RLS on every table added by 0002', async () => {
    const rows = await db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'r' AND NOT c.relrowsecurity`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});
