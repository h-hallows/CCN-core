/**
 * The assignment log — Civil Code § 1812.529. Spec § 9.1.
 *
 * WHAT THE STATUTE ASKS FOR, AND WHY IT IS A GATE RATHER THAN A FORM.
 *
 * A nurses' registry must keep permanent log sheets of every order for nursing service
 * and every assignment made from it, each entry naming the patient and their address,
 * the attending physician, the nurse referred, the hour the order arrived, the dates of
 * service and the fee charged — and § 1812.529 forbids false entries in them.
 *
 * `assignment_log` has existed since migration 0004 and nothing wrote to it. A register
 * nobody writes is worse than no register: the table's presence reads as compliance to
 * anyone who looks at the schema, while the shelf it stands for is empty. So the row is
 * now a product of the referral transaction, enforced at COMMIT by a constraint trigger
 * rather than by this module — a referral for private duty nursing that reaches the
 * database without its log sheet is rolled back.
 *
 * That makes the log's required columns into referral preconditions, which is the point.
 * Four of them are facts about the household the registry must already hold before
 * sending a nurse to someone's home: who the patient is, where they live, when care
 * begins, and what the registry charges. Three were nullable and unchecked. A referral
 * recorded without them was never lawful; it only looked complete.
 *
 * AND WHY THE MISSING-FIELD CHECK IS HERE, NOT IN THE MODAL. The operator gives the
 * spoken disclosure out loud, to a person, and then records it. If the referral then
 * failed on a missing address the spoken act would have happened with nothing to show
 * for it, and § 1812.5095(f) asks for the record of the act, not a second attempt. So
 * the blockers are computed from the same facts in two places — on the match screen
 * before the modal opens, and inside the transaction — from this one list.
 *
 * Nothing here invents a value. A fee basis derived from a schedule maximum nobody
 * agreed to, or a service date defaulted to today because the household never said,
 * would be exactly the false entry the section names.
 */
import { isSkilled } from './care';


/** One of the entries § 1812.529 enumerates, and where this registry keeps it. */
export interface AssignmentFieldDef {
  /** The column of `assignment_log` that holds it. */
  column: string;
  /** What the statute asks for, in its terms. */
  label: string;
  /** Where it comes from in the record, in the operator's terms. */
  source: string;
  /**
   * True where a referral is refused without it. The others are derived from rows that
   * must exist by the time a referral does, or are legitimately open-ended.
   */
  blocking: boolean;
  /** What the operator does about it, where it is blocking. */
  fix?: string;
}

export const ASSIGNMENT_FIELDS = {
  patient_name: {
    column: 'patient_name',
    label: 'The name of the patient',
    source: 'The care recipient on the household record',
    blocking: true,
    fix: 'Add the care recipient’s name to the household.',
  },
  patient_address: {
    column: 'patient_address',
    label: 'The address of the patient',
    source: 'The care recipient’s address on the household record',
    blocking: true,
    fix: 'Add the address care is given at to the household.',
  },
  attending_physician: {
    column: 'attending_physician',
    label: 'The name of the attending physician',
    source: 'The physician of record on the household',
    blocking: true,
    fix: 'Add the ordering physician to the household record.',
  },
  provider_id: {
    column: 'provider_id',
    label: 'The nurse referred',
    source: 'The referral itself',
    blocking: false,
  },
  order_received_at: {
    column: 'order_received_at',
    label: 'The date and hour the order was received',
    // Derived, never typed: the enquiry that produced this case, or the case record
    // itself where the operator opened it directly. Both are server-set timestamps.
    source: 'The enquiry this case came from, or when the case was opened',
    blocking: false,
  },
  service_from: {
    column: 'service_from',
    label: 'The date service begins',
    source: 'The start date on the case',
    blocking: true,
    fix: 'Record the date care is to begin on the case.',
  },
  service_to: {
    column: 'service_to',
    label: 'The date service ends, where one is known',
    // Open-ended assignments are the normal kind. A null here says the assignment has
    // not ended, which is true, and `endEngagement` is what closes it.
    source: 'The end date on the case, if the household gave one',
    blocking: false,
  },
  fee_basis: {
    column: 'fee_basis',
    label: 'The fee charged',
    source: 'The referral fee percentage agreed on the case',
    blocking: true,
    fix: 'Record the fee percentage on the case before referring.',
  },
} as const satisfies Record<string, AssignmentFieldDef>;

export type AssignmentField = keyof typeof ASSIGNMENT_FIELDS;

export const BLOCKING_ASSIGNMENT_FIELDS: readonly AssignmentField[] =
  (Object.keys(ASSIGNMENT_FIELDS) as AssignmentField[])
    .filter((f) => ASSIGNMENT_FIELDS[f].blocking);

/** The facts a log sheet is written from, as they sit on the household and the case. */
export interface AssignmentFacts {
  care: string;
  patientName: string | null | undefined;
  patientAddress: string | null | undefined;
  attendingPhysician: string | null | undefined;
  startsOn: string | null | undefined;
  /** `cases.fee_pct`. Numeric comes back from Postgres as a string. */
  feePct: number | string | null | undefined;
}

function present(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * The fee charged, worded as it is charged. I6: a fixed percentage of job cost, billed
 * to the household, never deducted from what a provider earns — and § 1812.530 forbids
 * charging a nurse anything at all, so the log says who pays rather than leaving it to
 * be inferred from a bare number.
 *
 * Returns null where no percentage is agreed. There is no schedule-maximum fallback: a
 * maximum is what the registry may charge, not what it did.
 */
export function feeBasisOf(feePct: number | string | null | undefined): string | null {
  if (feePct === null || feePct === undefined || feePct === '') return null;
  const pct = typeof feePct === 'string' ? Number(feePct) : feePct;
  if (!Number.isFinite(pct) || pct <= 0) return null;
  const shown = Number.isInteger(pct) ? String(pct) : String(Number(pct.toFixed(2)));
  return `${shown}% of job cost, billed to the household`;
}

/**
 * Which § 1812.529 entries cannot be filled from these facts.
 *
 * Empty for a care type outside Chapter 7: the log is the nurses' registry obligation,
 * and a companion referral has no attending physician to name. `isSkilled` decides it,
 * and `tests/assignment.test.ts` fails if that list and the one the constraint trigger
 * uses in SQL ever part company — two definitions of "private duty nursing" would mean
 * referrals the trigger demands a log sheet for and this check waves through.
 */
export function assignmentMissing(facts: AssignmentFacts): AssignmentField[] {
  if (!isSkilled(facts.care)) return [];
  const missing: AssignmentField[] = [];
  if (!present(facts.patientName)) missing.push('patient_name');
  if (!present(facts.patientAddress)) missing.push('patient_address');
  if (!present(facts.attendingPhysician)) missing.push('attending_physician');
  if (!present(facts.startsOn)) missing.push('service_from');
  if (feeBasisOf(facts.feePct) === null) missing.push('fee_basis');
  return missing;
}

/** One sentence naming what is missing, for a refusal the operator can act on. */
export function assignmentBlockedReason(missing: readonly AssignmentField[]): string {
  if (missing.length === 0) return '';
  const list = missing.map((f) => ASSIGNMENT_FIELDS[f].label.replace(/^The /, 'the ')).join(', ');
  return 'Civil Code § 1812.529 requires an assignment log entry for a private duty '
    + `nursing referral, and this record is missing ${list}.`;
}

/**
 * The log sheet, written from the rows it describes.
 *
 * One statement, in core, because the seed and `makeReferral` must produce identical
 * entries — a seeded register that differs in shape from a real one is a register that
 * has never actually been tested. It derives every statutory field from the referral it
 * is given rather than accepting them as arguments, so no caller can pass a patient
 * address that is not the one on the household record.
 *
 * `order_received_at` is the one field with a choice in it: § 1812.529 wants the hour the
 * order arrived, which is when the household asked, not when the operator got round to
 * opening the case. So it is the enquiry that produced this case — the latest one
 * received at or before the case was opened, since a household may come back years later
 * with a second order — and the case's own creation only where no enquiry exists,
 * because the operator opened it from a phone call. Both are server-set.
 *
 * $1 referral id · $2 fee basis · $3 recorded by.
 */
export const ASSIGNMENT_LOG_INSERT = `
  INSERT INTO assignment_log
    (case_id, referral_id, provider_id, order_received_at, patient_name,
     patient_address, attending_physician, service_from, service_to, fee_basis,
     recorded_by)
  SELECT c.id, r.id, r.provider_id,
         COALESCE(
           (SELECT max(i.received_at) FROM inquiries i
             WHERE i.household_id = h.id AND i.received_at <= c.created_at),
           c.created_at),
         h.cr_name, h.cr_address, h.physician_name,
         c.starts_on, c.ends_on, $2, $3
    FROM referrals r
    JOIN cases c    ON c.id = r.case_id
    JOIN households h ON h.id = c.household_id
   WHERE r.id = $1
  RETURNING id`;

/**
 * A correction. § 1812.529 forbids false entries and the table is append-only, so the
 * way to fix one is a new sheet that says what the old one should have said and points
 * at it. The original stays legible; the register shows both, with the superseded entry
 * struck through and the note that replaced it.
 *
 * The derived fields are copied from the row being corrected rather than re-derived:
 * the order did arrive when it arrived, and a correction to the address is not an
 * occasion to silently restate the hour.
 *
 * $1 the entry being corrected · $2 patient name · $3 patient address ·
 * $4 attending physician · $5 service from · $6 service to · $7 fee basis ·
 * $8 recorded by · $9 the note saying what was wrong.
 */
export const ASSIGNMENT_LOG_CORRECTION = `
  INSERT INTO assignment_log
    (case_id, referral_id, provider_id, order_received_at, patient_name,
     patient_address, attending_physician, service_from, service_to, fee_basis,
     recorded_by, corrects_id, correction_note)
  SELECT a.case_id, a.referral_id, a.provider_id, a.order_received_at,
         $2, $3, $4, $5::date, $6::date, $7, $8, a.id, $9
    FROM assignment_log a
   WHERE a.id = $1
  RETURNING id`;
