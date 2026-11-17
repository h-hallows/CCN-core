/**
 * Published rate ranges — Civil Code § 1812.533(b)(1). Spec § 5.
 *
 * WHAT THESE ARE, AND WHAT THEY ARE NOT. The public pages show a band per service and
 * credential level: "a certified nursing assistant for overnight newborn care, $48–65 an
 * hour." That is a statement about what care costs on the Westside, made by the registry,
 * on a page anybody can read. It is advertising, and § 1812.533(b)(1) prohibits
 * publishing false or misleading information — so a band that has drifted from what
 * providers actually charge is not a conversion problem, it is the same kind of problem
 * as a wrong name in a footer.
 *
 * It is NOT a price. I5: a provider sets their own rate and it stays negotiable with the
 * household, and nothing in this system computes, suggests, caps or defaults it. That is
 * why the page shows a RANGE and always carries the negotiable marker — a single number
 * would read as a price list, which this is not — and why nothing here derives a band
 * from the roster. The operator types the band. What this module does is let them see
 * what the roster actually charges while they type it.
 *
 * WHY THE CHECK IS A WARNING AND NOT A REFUSAL. The honest comparison available is by
 * CREDENTIAL LEVEL, not by service: the roster records what a nurse charges, not what
 * they charge for hospice support specifically. A CNA may well ask more for overnight
 * newborn work than for daytime companionship, so a band sitting outside the observed
 * spread is a question rather than a proven falsehood. Refusing it would be the system
 * claiming knowledge it does not have, which is the failure this file exists to prevent
 * in the other direction.
 *
 * So the structural things are refused — a service nobody serves, a level that does not
 * exist, a band that is inside out — and the judgement is left with the operator, with
 * the numbers in front of them.
 *
 * `rate_ranges` was written by the seed and by nothing else. The marketing pages have
 * been serving bands from demonstration data that no screen could correct.
 */
import type { CareType } from '../schema';


/**
 * The five levels a band can be quoted at, least clinical first — the order a household
 * reads them in, and the order the public page renders.
 *
 * Lowercase and separate from `provider_type` on purpose. The roster's enum is 'RN',
 * 'LVN', 'CNA', 'HCA', 'companion' because that is how a credential is written on a
 * licence; these are how a band is labelled on a page. `levelOfProviderType` is the one
 * place the two meet.
 */
export const CREDENTIAL_LEVELS = ['companion', 'hca', 'cna', 'lvn', 'rn'] as const;

export type CredentialLevel = (typeof CREDENTIAL_LEVELS)[number];

export const CREDENTIAL_LEVEL_LABEL: Record<CredentialLevel, string> = {
  companion: 'Companion',
  hca: 'Home care aide',
  cna: 'Certified nursing assistant',
  lvn: 'Licensed vocational nurse',
  rn: 'Registered nurse',
};

export function isCredentialLevel(v: unknown): v is CredentialLevel {
  return typeof v === 'string' && (CREDENTIAL_LEVELS as readonly string[]).includes(v);
}

/**
 * A provider's credential as a band label.
 *
 * Returns null rather than guessing for a type it does not know, so a provider type
 * added later shows up as unobserved rather than silently joining the wrong band.
 */
export function levelOfProviderType(type: string): CredentialLevel | null {
  const lower = type.toLowerCase();
  return isCredentialLevel(lower) ? lower : null;
}


/** What the roster charges at one credential level, as observed rather than as quoted. */
export interface ObservedRates {
  level: CredentialLevel;
  /** Active providers at this level with a rate on file. */
  count: number;
  low: number | null;
  high: number | null;
  /** The middle one. Not a mean: one provider at $200 should not move it. */
  median: number | null;
}

/** A band as it would be published. */
export interface RateBand {
  serviceKey: string;
  level: CredentialLevel;
  low: number;
  high: number;
}

export type BandConcern =
  | 'inside_out'
  | 'nobody_at_this_level'
  | 'no_rates_on_file'
  | 'outside_observed'
  | 'wider_than_observed';

export interface BandNote {
  concern: BandConcern;
  /** True where the band cannot be posted at all. */
  blocking: boolean;
  message: string;
}

/**
 * What is wrong, or worth saying, about a band before it goes on a public page.
 *
 * Exactly one blocking concern exists — a band whose top is below its bottom, which the
 * database refuses too. Everything else is said rather than enforced, for the reason at
 * the head of this file: the observation is by credential level and the band is by
 * service, and the gap between those two is a judgement the operator is better placed to
 * make than a rule is.
 *
 * The wording matters more than usual here. These sentences are read at the moment
 * somebody is about to publish a number to the public, and "the roster does not support
 * this" is actionable where "validation failed" is not.
 */
export function bandNotes(band: RateBand, observed: ObservedRates | null): BandNote[] {
  const notes: BandNote[] = [];

  if (band.high < band.low) {
    notes.push({
      concern: 'inside_out',
      blocking: true,
      message: 'The top of the band is below the bottom of it.',
    });
    return notes;
  }

  if (observed === null || observed.count === 0) {
    notes.push({
      concern: 'nobody_at_this_level',
      blocking: false,
      message: `No active ${CREDENTIAL_LEVEL_LABEL[band.level].toLowerCase()} is on the `
        + 'roster, so this band is a claim about care that cannot be referred today. '
        + 'That is legitimate before a service launches and misleading after it.',
    });
    return notes;
  }

  if (observed.low === null || observed.high === null) {
    notes.push({
      concern: 'no_rates_on_file',
      blocking: false,
      message: `There are ${observed.count} at this level and none has a rate on file, `
        + 'so nothing here can be checked against anything. Record their stated rates '
        + 'and this band becomes verifiable.',
    });
    return notes;
  }

  // No overlap at all: the band and the roster describe different money.
  if (band.high < observed.low || band.low > observed.high) {
    notes.push({
      concern: 'outside_observed',
      blocking: false,
      message: `The roster's ${CREDENTIAL_LEVEL_LABEL[band.level].toLowerCase()}s charge `
        + `$${observed.low.toFixed(2)}–${observed.high.toFixed(2)}, and this band does `
        + 'not overlap that at all. It may still be right — a rate on file is what '
        + 'somebody charges generally, not what they charge for this service — but '
        + '§ 1812.533(b)(1) is about what a page tells the public, and this page would '
        + 'be telling them something no provider here has said.',
    });
    return notes;
  }

  // Overlapping but far wider than anything observed: a band that cannot be wrong
  // because it says almost nothing.
  const observedSpread = observed.high - observed.low;
  const bandSpread = band.high - band.low;
  if (bandSpread > Math.max(observedSpread * 3, 40)) {
    notes.push({
      concern: 'wider_than_observed',
      blocking: false,
      message: `This band spans $${bandSpread.toFixed(2)} where the roster spans `
        + `$${observedSpread.toFixed(2)}. A range wide enough to contain any answer is `
        + 'not much of an answer, and a household reading it learns nothing.',
    });
  }

  return notes;
}

/** True where nothing stops this band being posted. */
export function bandIsPostable(notes: readonly BandNote[]): boolean {
  return !notes.some((n) => n.blocking);
}


/**
 * The services a band may be quoted for.
 *
 * The same closed vocabulary as `care_type`, because a band is quoted for a kind of care
 * and a service_key that is not one is a band no page will ever read — published,
 * invisible, and still in the record as a claim. `tests/rates.test.ts` fails if this and
 * the enum part company.
 */
export const BANDED_SERVICES: readonly CareType[] = [
  'companion', 'personal_care', 'skilled_nursing', 'post_surgical',
  'overnight_newborn', 'respite', 'hospice_support',
];

export function isBandedService(v: unknown): v is CareType {
  return typeof v === 'string' && (BANDED_SERVICES as readonly string[]).includes(v);
}

/** The banded services as a SQL array literal. See SKILLED_SQL_ARRAY for why. */
export const BANDED_SERVICES_SQL_ARRAY: string =
  `ARRAY[${BANDED_SERVICES.map((s) => `'${s}'`).join(', ')}]::text[]`;


/**
 * Post a band.
 *
 * Append-only: a band is posted and superseded, never amended. The public query reads
 * the newest row per service and level whose `effective_from` has arrived, so a
 * correction is a new row dated today and a planned change is a new row dated ahead.
 * Editing one in place would make `effective_from` a claim rather than a record of what
 * the page said and when — which is the only thing that can answer a § 1812.533(b)(1)
 * question after the fact.
 *
 * $1 service · $2 credential level · $3 low · $4 high · $5 effective from ·
 * $6 note · $7 posted by.
 */
export const RATE_BAND_INSERT = `
  INSERT INTO rate_ranges
    (service_key, credential_level, low, high, effective_from, note, posted_by)
  VALUES ($1, $2, $3::numeric, $4::numeric, $5::date, $6, $7)
  RETURNING id`;
