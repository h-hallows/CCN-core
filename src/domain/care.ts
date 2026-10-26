/**
 * Care-type vocabulary, shared by every surface.
 *
 * These live in the library rather than in a component because the marketing site, the
 * client portal and the console must describe the same thing with the same words. A
 * second copy of CARE_LABEL is how "Post-surgical" becomes "Post surgical" on one page.
 */
import type { CareType, CaseStatusValue, UrgencyValue, EndReasonValue } from '../schema';

export const CARE_LABEL: Record<CareType, string> = {
  companion: 'Companion',
  personal_care: 'Personal care',
  skilled_nursing: 'Skilled nursing',
  post_surgical: 'Post-surgical',
  overnight_newborn: 'Overnight newborn',
  respite: 'Respite',
  hospice_support: 'Hospice support',
};

/**
 * Care types that are private duty nursing under Civil Code § 1812.524, and so cannot be
 * referred without an ordering physician on the household record (I11).
 */
export const SKILLED: readonly CareType[] =
  ['skilled_nursing', 'post_surgical', 'hospice_support'] as const;

export function isSkilled(care: string): boolean {
  return (SKILLED as readonly string[]).includes(care);
}

export const URGENCY_LABEL: Record<UrgencyValue, string> = {
  discharge: 'Discharge',
  same_day: 'Same day',
  next_day: 'Next day',
  routine: 'Routine',
};

/** Queue order. Discharge first; it is the one with a hospital bed waiting on it. */
export const URGENCY_ORDER: Record<UrgencyValue, number> = {
  discharge: 0, same_day: 1, next_day: 2, routine: 3,
};

export const STATUS_LABEL: Record<CaseStatusValue, string> = {
  inquiry: 'Enquiry',
  matching: 'Matching',
  referred: 'Referred',
  active: 'Active',
  paused: 'Paused',
  ended: 'Ended',
};

/**
 * § 8: a fixed list, one option of which is the direct-arrangement case. As free text it
 * would be left blank, and the number that matters most would not exist.
 */
export const END_REASON_LABEL: Record<EndReasonValue, string> = {
  moved_to_direct_arrangement: 'Moved to a direct arrangement with the referred provider',
  care_no_longer_needed: 'Care no longer needed',
  hospitalized: 'Hospitalised',
  moved_to_facility: 'Moved to a facility',
  deceased: 'Care recipient died',
  cost: 'Cost',
  household_dissatisfied: 'Household dissatisfied',
  provider_unavailable: 'Referred provider no longer available',
  moved_to_another_agency: 'Moved to another agency',
  other: 'Other',
};
