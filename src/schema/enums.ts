/**
 * Every enum in the schema. Spec § 3.1, plus the two the front door added in § 3.4
 * and § 3.1 of the architecture spec.
 */
import { pgEnum } from 'drizzle-orm/pg-core';

export const providerType = pgEnum('provider_type', ['RN', 'LVN', 'CNA', 'HCA', 'companion']);

export const providerStatus = pgEnum('provider_status', ['active', 'inactive', 'do_not_refer']);

export const credentialType = pgEnum('credential_type', [
  'rn_license', 'lvn_license', 'cna_cert', 'hca_registry', 'live_scan',
  'tb_clearance', 'cpr_bls', 'auto_insurance', 'drivers_license', 'immunization', 'other',
]);

export const careType = pgEnum('care_type', [
  'companion', 'personal_care', 'skilled_nursing', 'post_surgical',
  'overnight_newborn', 'respite', 'hospice_support',
]);

export const caseStatus = pgEnum('case_status', [
  'inquiry', 'matching', 'referred', 'active', 'paused', 'ended',
]);

export const urgency = pgEnum('urgency', ['discharge', 'same_day', 'next_day', 'routine']);

export const paymentMethod = pgEnum('payment_method', ['private', 'ltc_policy', 'va', 'other']);

export const timelineType = pgEnum('timeline_type', [
  'inquiry', 'call', 'note', 'shortlist', 'referral', 'disclosure',
  'written_disclosure', 'schedule_change', 'document', 'status_change',
]);

/** I4: no `registry` member. The registry cannot end a relationship. */
export const endedBy = pgEnum('ended_by', ['household', 'provider', 'mutual']);

export const shiftBlock = pgEnum('shift_block', ['AM', 'PM', 'NOC']);

export const endReason = pgEnum('end_reason', [
  'moved_to_direct_arrangement', 'care_no_longer_needed', 'hospitalized',
  'moved_to_facility', 'deceased', 'cost', 'household_dissatisfied',
  'provider_unavailable', 'moved_to_another_agency', 'other',
]);

export const referralOutcome = pgEnum('referral_outcome', [
  'engaged', 'declined_by_household', 'declined_by_provider', 'no_response',
]);

export const metricEvent = pgEnum('metric_event', [
  'inquiry_received', 'first_contact', 'shortlist_generated', 'referral_made',
  'engagement_started', 'engagement_ended', 'operator_session', 'credential_renewed',
  'service_failure', 'billed_hours_recorded',
]);

export const serviceFailureKind = pgEnum('service_failure_kind', [
  'missed_shift', 'unanswered_discharge_call', 'lapsed_credential_reached_household',
  'no_eligible_provider_available', 'other',
]);

/** Architecture spec § 3.4. Four audiences, one users table. */
export const userRole = pgEnum('user_role', ['operator', 'household', 'provider', 'partner']);

/** Architecture spec § 3.1. The status of a household's request against a bench. */
export const shortlistRequestStatus = pgEnum('shortlist_request_status', [
  'pending', 'referred', 'declined_by_household', 'withdrawn',
]);
