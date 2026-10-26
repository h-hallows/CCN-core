/**
 * Match assist. Spec § 4.3 hard filters.
 *
 * The § 4.4 soft score is deliberately NOT implemented — see /DEFERRED.md. The spec's
 * own instruction: those weights are invented, there is no placement-outcome data to
 * calibrate them against, and a confident-looking ranking that disagrees with the
 * operator's judgment on day one is the fastest way to lose her trust in the tool.
 *
 * What ships instead is the valuable half: hard filters that enforce eligibility and
 * stop a lapsed credential reaching a household, plus the raw observed signals as
 * sortable columns. No composite total is computed anywhere in this file.
 */
import type { CareType, ProviderType } from '../schema';
import { eligibility, type CredentialLike, type ProviderLike } from './credentials';

/**
 * Which provider types may be referred for which care type. A scope-of-practice rule,
 * so it lives in code alongside the credential matrix.
 */
export const PERMITTED: Record<CareType, ProviderType[]> = {
  companion: ['companion', 'HCA', 'CNA', 'LVN', 'RN'],
  personal_care: ['HCA', 'CNA', 'LVN', 'RN'],
  respite: ['HCA', 'CNA', 'LVN', 'RN'],
  overnight_newborn: ['CNA', 'LVN', 'RN'],
  hospice_support: ['CNA', 'LVN', 'RN'],
  skilled_nursing: ['RN', 'LVN'],
  post_surgical: ['RN', 'LVN'],
};

export type ExclusionCode =
  | 'not_eligible'
  | 'type_not_permitted'
  | 'area_not_served'
  | 'no_availability_overlap'
  | 'blocked_by_household';

export interface Exclusion {
  code: ExclusionCode;
  /** Shown verbatim next to the provider on the excluded list. § 5: a specific reason. */
  detail: string;
}

/** Only the fields the filters read. */
export interface Candidate extends ProviderLike {
  id: string;
  fullName: string;
  areas: string[];
  availability: string[];
  specialties: string[];
  languages: string[];
  rateHourly: string | null;
  credentials: CredentialLike[];
}

export interface MatchCase {
  care: CareType;
  schedule: string[];
  languagePref: string | null;
  rateBandLow: string | null;
  rateBandHigh: string | null;
  specialtiesWanted?: string[];
}

export interface MatchHousehold {
  crArea: string;
  blockedProviderIds: string[];
}

/**
 * Raw observed signals. Each is the number itself, never a weighted contribution.
 * The operator sorts on whichever column matters for this case.
 */
export interface MatchSignals {
  specialtyMatches: string[];
  blocksRequired: number;
  blocksCovered: number;
  /** null when the case states no language preference. */
  languageMet: boolean | null;
  /** How many times this provider has been referred to this household before. */
  priorReferrals: number;
  priorEngagementsEndedWell: number;
  /** Mean engagement length across this provider's ended engagements, in weeks. */
  avgEngagementWeeks: number | null;
  /** 0 = the case area is the provider's first listed area. */
  areaRank: number;
  rateVsBand: 'at_or_under' | 'slightly_over' | 'over' | 'unstated';
}

export interface History {
  priorReferrals: number;
  priorEngagementsEndedWell: number;
  avgEngagementWeeks: number | null;
}

export const NO_HISTORY: History = {
  priorReferrals: 0, priorEngagementsEndedWell: 0, avgEngagementWeeks: null,
};

export type Screened =
  | { included: true; candidate: Candidate; signals: MatchSignals }
  | { included: false; candidate: Candidate; exclusion: Exclusion };

/** § 4.3 — exclude, and record the reason for display. Order matters: most specific first. */
export function screen(
  candidate: Candidate,
  kase: MatchCase,
  household: MatchHousehold,
  today: Date,
  history: History = NO_HISTORY,
): Screened {
  if (household.blockedProviderIds.includes(candidate.id)) {
    return excluded(candidate, 'blocked_by_household',
      'Household asked not to be referred this provider');
  }

  const elig = eligibility(candidate, candidate.credentials, today);
  if (!elig.eligible) {
    return excluded(candidate, 'not_eligible', elig.reason ?? 'Not eligible');
  }

  if (!PERMITTED[kase.care].includes(candidate.type)) {
    return excluded(candidate, 'type_not_permitted',
      `${candidate.type} is not referred for ${kase.care.replace(/_/g, ' ')}`);
  }

  if (!candidate.areas.includes(household.crArea)) {
    return excluded(candidate, 'area_not_served', `Does not cover ${household.crArea}`);
  }

  const covered = overlap(candidate.availability, kase.schedule);
  if (kase.schedule.length > 0 && covered.length === 0) {
    return excluded(candidate, 'no_availability_overlap',
      `Stated availability does not meet the requested pattern (${kase.schedule.join(', ')})`);
  }

  return {
    included: true,
    candidate,
    signals: {
      specialtyMatches: overlap(candidate.specialties, kase.specialtiesWanted ?? []),
      blocksRequired: kase.schedule.length,
      blocksCovered: covered.length,
      languageMet: kase.languagePref ? candidate.languages.includes(kase.languagePref) : null,
      priorReferrals: history.priorReferrals,
      priorEngagementsEndedWell: history.priorEngagementsEndedWell,
      avgEngagementWeeks: history.avgEngagementWeeks,
      areaRank: candidate.areas.indexOf(household.crArea),
      rateVsBand: rateVsBand(candidate.rateHourly, kase.rateBandHigh),
    },
  };
}

function excluded(candidate: Candidate, code: ExclusionCode, detail: string): Screened {
  return { included: false, candidate, exclusion: { code, detail } };
}

export function overlap(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return a.filter((x) => set.has(x));
}

/**
 * I5: rates are provider-set and always negotiable. This classifies for display only.
 * Nothing here feeds a ranking, and nothing excludes a provider for being over band —
 * the operator negotiates.
 */
function rateVsBand(rate: string | null, bandHigh: string | null): MatchSignals['rateVsBand'] {
  if (!rate || !bandHigh) return 'unstated';
  const r = Number(rate);
  const high = Number(bandHigh);
  if (!Number.isFinite(r) || !Number.isFinite(high) || high <= 0) return 'unstated';
  if (r <= high) return 'at_or_under';
  if (r <= high * 1.15) return 'slightly_over';
  return 'over';
}

/**
 * Default ordering of the eligible list: availability coverage, then specialty overlap,
 * then prior success with this household, then name. A transparent sort the operator can
 * read off the columns — not a score.
 */
export function compareEligible(a: MatchSignals, b: MatchSignals, aName: string, bName: string): number {
  const coverage = (s: MatchSignals) => (s.blocksRequired ? s.blocksCovered / s.blocksRequired : 1);
  return (
    coverage(b) - coverage(a)
    || b.specialtyMatches.length - a.specialtyMatches.length
    || b.priorEngagementsEndedWell - a.priorEngagementsEndedWell
    || a.areaRank - b.areaRank
    || aName.localeCompare(bName)
  );
}
