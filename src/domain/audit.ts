/**
 * What an audit row is about. Spec § 3.8.
 *
 * WHY THIS IS SHARED, AND WHY IT IS A CLOSED SET.
 *
 * `audit_log` carries `(entity, entity_id)` as free text and a bare uuid, and every
 * call site chose its own words. By the time anyone looked there were rows saying
 * `document` and rows saying `documents`, rows saying `case` and rows saying `cases` —
 * so a query for one silently missed the other.
 *
 * Worse: `entity_id` did not mean the same thing twice. A read of a case's bench was
 * recorded as `('shortlist', caseId)` and a read of its documents as
 * `('documents', caseId)` — the entity naming one table, the id belonging to another.
 * The pair was not a key into anything, which made the one question § 3.8 exists to
 * answer — WHO LOOKED AT THIS HOUSEHOLD — unanswerable by query. The log was being
 * written faithfully and could not be read.
 *
 * So: `entity` comes from this list and nowhere else, and `entity_id`, when present, is
 * always the primary key of that entity's own table. What was being looked at goes in
 * `diff` (`{ read: 'bench' }`), which is the column for whatever the row needs to say.
 * A read that is about a case is recorded against the case.
 *
 * THE SPANS. An audit row concerns a household if its `(entity, entity_id)` names a row
 * that is about that household — the household itself, its cases, the referrals on
 * those cases, the disclosures on those referrals, and so on down. That relationship is
 * a judgment, not something the foreign-key graph can be walked for: `households` reach
 * `providers` through `referrals`, and a provider is emphatically not "about" one
 * household. So the paths are curated — and the curation is checked. Every table in the
 * schema is either audited through an entity here or listed in UNAUDITED_TABLES with a
 * reason, and CI fails if a new table is neither. A list of what is covered leaves the
 * next table out of the answer; a list that must account for all of them does not.
 *
 * SQL lives in this file although the rest of domain/ is pure. These are declarations
 * about the schema, and core owns the schema. They take no handle and open nothing —
 * the caller runs them, with the subject's id as $1.
 */

/** Rows of this entity's table are about one household, one provider, or neither. */
export interface AuditEntityDef {
  /** The table whose primary key `entity_id` holds. */
  table: string;
  /** What to call it on a screen. */
  label: string;
  /** Selects `id` for the rows of `table` that are about household $1. */
  byHousehold: string | null;
  /** Selects `id` for the rows of `table` that are about provider $1. */
  byProvider: string | null;
  /**
   * True where a read of this entity is routinely recorded with no id — a list screen
   * rather than one record. Such a row names an actor and a time and nothing narrower.
   */
  collection?: boolean;
}

const CASES_OF = `SELECT id FROM cases WHERE household_id = $1`;

export const AUDIT_ENTITIES = {
  household: {
    table: 'households',
    label: 'Household',
    byHousehold: `SELECT id FROM households WHERE id = $1`,
    byProvider: null,
  },
  case: {
    table: 'cases',
    label: 'Case',
    byHousehold: CASES_OF,
    byProvider: null,
  },
  inquiry: {
    table: 'inquiries',
    label: 'Enquiry',
    // An enquiry that was converted belongs to the household it became. One that was
    // not belongs to nobody yet, which is why the queue read is recorded without an id.
    byHousehold: `SELECT id FROM inquiries WHERE household_id = $1`,
    byProvider: null,
    collection: true,
  },
  provider: {
    table: 'providers',
    label: 'Provider',
    byHousehold: null,
    byProvider: `SELECT id FROM providers WHERE id = $1`,
    collection: true,
  },
  provider_application: {
    table: 'provider_applications',
    label: 'Application',
    byHousehold: null,
    byProvider: `SELECT id FROM provider_applications WHERE provider_id = $1`,
    collection: true,
  },
  credential: {
    table: 'credentials',
    label: 'Credential',
    byHousehold: null,
    byProvider: `SELECT id FROM credentials WHERE provider_id = $1`,
  },
  credential_submission: {
    table: 'credential_submissions',
    label: 'Credential submission',
    byHousehold: null,
    byProvider: `SELECT id FROM credential_submissions WHERE provider_id = $1`,
    collection: true,
  },
  document: {
    table: 'documents',
    label: 'Document',
    byHousehold:
      `SELECT id FROM documents
        WHERE household_id = $1 OR case_id IN (${CASES_OF})`,
    byProvider: `SELECT id FROM documents WHERE provider_id = $1`,
  },
  rate_band: {
    table: 'rate_ranges',
    label: 'Published rate band',
    /*
     * § 1812.533(b)(1). What the public pages tell a household that care costs here.
     * About the business rather than about a person, like the advertising record, and
     * audited for the same reason: somebody will later ask when a band changed and on
     * whose say-so.
     */
    byHousehold: null,
    byProvider: null,
    collection: true,
  },
  advertisement: {
    table: 'advertising_log',
    label: 'Advertising record entry',
    /*
     * Civil Code § 1812.533(c). The only register in this schema that is about the
     * business rather than about a person: it holds what CCN said about itself in
     * public, which is why it appears in neither span below. It is audited all the same,
     * because who checked the advertising record and when is a fact worth having when
     * somebody later asks whether an advertisement was known about.
     */
    byHousehold: null,
    byProvider: null,
    collection: true,
  },
  assignment: {
    table: 'assignment_log',
    label: 'Assignment log entry',
    /*
     * Civil Code § 1812.529. A log sheet names the patient, the address care is given
     * at and the attending physician, so reading the register is reading identifiable
     * information about those households — and about the nurse referred, which is why
     * it sits in both spans rather than only the household's.
     */
    byHousehold:
      `SELECT a.id FROM assignment_log a
         JOIN cases c ON c.id = a.case_id
        WHERE c.household_id = $1`,
    byProvider: `SELECT id FROM assignment_log WHERE provider_id = $1`,
    collection: true,
  },
  referral: {
    table: 'referrals',
    label: 'Referral',
    byHousehold:
      `SELECT r.id FROM referrals r
         JOIN cases c ON c.id = r.case_id
        WHERE c.household_id = $1`,
    byProvider: `SELECT id FROM referrals WHERE provider_id = $1`,
  },
  disclosure: {
    table: 'disclosures',
    label: 'Disclosure',
    byHousehold:
      `SELECT d.id FROM disclosures d
         JOIN cases c ON c.id = d.case_id
        WHERE c.household_id = $1`,
    // A disclosure is made to a household about a provider. The link runs through the
    // referral it was written with.
    byProvider:
      `SELECT d.id FROM disclosures d
         JOIN referrals r ON r.disclosure_id = d.id
        WHERE r.provider_id = $1`,
  },
  referral_feedback: {
    table: 'referral_feedback',
    label: 'Feedback',
    byHousehold:
      `SELECT f.id FROM referral_feedback f
         JOIN referrals r ON r.id = f.referral_id
         JOIN cases c ON c.id = r.case_id
        WHERE c.household_id = $1`,
    byProvider:
      `SELECT f.id FROM referral_feedback f
         JOIN referrals r ON r.id = f.referral_id
        WHERE r.provider_id = $1`,
  },
  published_shortlist: {
    table: 'published_shortlists',
    label: 'Bench',
    byHousehold: `SELECT id FROM published_shortlists WHERE case_id IN (${CASES_OF})`,
    byProvider: null,
  },
  shortlist_request: {
    table: 'shortlist_requests',
    label: 'Request',
    byHousehold:
      `SELECT q.id FROM shortlist_requests q
         JOIN published_shortlists p ON p.id = q.shortlist_id
        WHERE p.case_id IN (${CASES_OF})`,
    byProvider: `SELECT id FROM shortlist_requests WHERE provider_id = $1`,
    collection: true,
  },
  timeline_entry: {
    table: 'timeline_entries',
    label: 'Timeline entry',
    byHousehold:
      `SELECT id FROM timeline_entries
        WHERE household_id = $1 OR case_id IN (${CASES_OF})`,
    byProvider: `SELECT id FROM timeline_entries WHERE provider_id = $1`,
  },
  consent: {
    table: 'consents',
    label: 'Consent',
    byHousehold: `SELECT id FROM consents WHERE subject_type = 'household' AND subject_id = $1`,
    byProvider: `SELECT id FROM consents WHERE subject_type = 'provider' AND subject_id = $1`,
  },
  service_failure: {
    table: 'service_failures',
    label: 'Service failure',
    /*
     * A missed shift is a household's missed shift. § 8 counts these to measure
     * capacity, but each row is also the record of a day somebody did not get the care
     * they were expecting — so it belongs on that household's trail, not only in a
     * denominator.
     */
    byHousehold:
      `SELECT f.id FROM service_failures f
         JOIN cases c ON c.id = f.case_id
        WHERE c.household_id = $1`,
    byProvider: null,
    collection: true,
  },
  fee_schedule: {
    table: 'fee_schedules',
    label: 'Fee schedule',
    // § 1812.527 applies to every covered nurse at once. A schedule is about nobody in
    // particular; who was given one is fee_schedule_delivery.
    byHousehold: null,
    byProvider: null,
    collection: true,
  },
  fee_schedule_delivery: {
    table: 'fee_schedule_deliveries',
    label: 'Fee schedule delivery',
    byHousehold: null,
    byProvider: `SELECT id FROM fee_schedule_deliveries WHERE provider_id = $1`,
    collection: true,
  },
  referral_partner: {
    table: 'referral_partners',
    label: 'Referral partner',
    // A partner is about themselves. The household they sent is not what the partner
    // row is, and treating it that way would put a partner's card in every one of their
    // families' audit trails.
    byHousehold: null,
    byProvider: null,
    collection: true,
  },
  user: {
    table: 'users',
    label: 'Portal account',
    byHousehold: `SELECT user_id AS id FROM household_users WHERE household_id = $1`,
    byProvider: `SELECT user_id AS id FROM provider_users WHERE provider_id = $1`,
    collection: true,
  },
  operator_session: {
    table: 'sessions',
    label: 'Operator sign-in',
    // An operator signing in is about the operator, not about anybody they then read.
    byHousehold: null,
    byProvider: null,
  },
} as const satisfies Record<string, AuditEntityDef>;

export type AuditEntity = keyof typeof AUDIT_ENTITIES;

export const AUDIT_ENTITY_NAMES = Object.keys(AUDIT_ENTITIES) as AuditEntity[];

export function isAuditEntity(value: unknown): value is AuditEntity {
  return typeof value === 'string' && value in AUDIT_ENTITIES;
}

/**
 * Names written before this vocabulary existed.
 *
 * `audit_log` is append-only at the database level, and that is the point of it — a
 * table whose history can be tidied is not evidence. So the drifted rows stay exactly as
 * they were written and the READ side translates. This map is closed: a name in neither
 * it nor AUDIT_ENTITIES is reported as unrecognised rather than quietly dropped.
 */
export const AUDIT_ENTITY_ALIASES: Record<string, AuditEntity> = {
  cases: 'case',
  documents: 'document',
  document_bytes: 'document',
  providers: 'provider',
  credential_submissions: 'credential_submission',
  shortlist_requests: 'shortlist_request',
  portal_user: 'user',
  portal_access: 'user',
  session: 'operator_session',
  // A read of a case's bench, recorded against the bench but carrying the case's id.
  // Translating the name does not make the id right; see unmatchedIds on the screen.
  shortlist: 'published_shortlist',
};

/** The canonical entity for whatever is stored, or null if the name is unrecognised. */
export function canonicalAuditEntity(stored: string | null | undefined): AuditEntity | null {
  if (!stored) return null;
  if (isAuditEntity(stored)) return stored;
  return AUDIT_ENTITY_ALIASES[stored] ?? null;
}

export function auditEntityLabel(stored: string | null | undefined): string {
  const entity = canonicalAuditEntity(stored);
  return entity ? AUDIT_ENTITIES[entity].label : (stored ?? 'Unknown');
}

/**
 * Reads of a whole screen rather than of one record. These carry no id by design, so
 * they answer "who was working" and never "who looked at this household" — which is why
 * they are named here rather than being given a made-up entity.
 */
export const AUDIT_VIEWS = {
  today: "Today's queues",
  compliance: 'Compliance screen',
  audit_log: 'Audit log',
  unattributed_referral: 'Unattributed referrals',
  disclosure_log_export: 'Disclosure log export',
} as const;

export type AuditView = keyof typeof AUDIT_VIEWS;

export const AUDIT_VIEW_NAMES = Object.keys(AUDIT_VIEWS) as AuditView[];

export function isAuditView(value: unknown): value is AuditView {
  return typeof value === 'string' && value in AUDIT_VIEWS;
}

/**
 * Every table nothing audits, and why.
 *
 * This is the half of the list that does the work. A table added to the schema and not
 * mentioned here fails CI, which forces the question "does a read of this need
 * recording?" at the time the table is written rather than after an incident.
 */
export const UNAUDITED_TABLES: Record<string, string> = {
  audit_log:
    'The log itself. Reading it IS audited — as the audit_log view, not as a row of it.',
  _migrations: 'Infrastructure. Exempt from RLS for the same reason.',

  // Join tables. Reached through the entity they attach to, never read on their own.
  household_users: 'Membership. Audited as the user it grants.',
  provider_users: 'Membership. Audited as the user it grants.',
  partner_users: 'Membership. Audited as the user it grants.',
  published_shortlist_items:
    'The rows of a bench. Audited as the published_shortlist that holds them.',
  credential_events:
    'The history of one credential. Audited as the credential it belongs to.',

  // Credential material. Deliberately never surfaced by id.
  auth_tokens: 'Hashed sign-in tokens. Nothing may read one back; see lib/auth.',
  portal_invites:
    'Hashed invite tokens. The grant is audited as the user; the token is not readable.',
  rate_limit_hits: 'Hashed keys and a route. Holds nothing about a person.',

  // Instrumentation and aggregates. § 8, not § 3.8.
  metric_events:
    'Instrumentation. An enum, a timestamp and a foreign key; the screen that reads it\n     only ever counts and never names anybody, so there is no row to audit a read of.',
  case_month_hours:
    'A composite key, so no entity_id can name a row. Reads of it are recorded against\n     the case instead, which is the subject anyway.',
  operator_notifications: 'Operator-facing queue. Superseded by the specific queues.',

  // Written by nothing yet. Each will need an entity above when a screen touches it.
  coverage_gaps: 'Blocked on the nine-factor audit; deliberately unread (V1-REVIEW § 7).',
  testimonials: 'Blocked on the consent it requires. No screen reads it yet.',
};
