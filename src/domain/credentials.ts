/**
 * Credential expiry and eligibility. Spec § 4.1, § 4.2, § 3.3.
 *
 * I12: a provider with any required credential missing or expired is excluded from every
 * shortlist. There is no override, for any role. `eligibility` is called from the query
 * layer (lib/queries/match.ts) — if an ineligible provider reaches the client, the
 * invariant is already broken.
 */
import type { CredentialType, Provider, ProviderType } from '../schema';
import { civilLA, daysBetween, parseISODate } from './dates';

export type CredStatus = 'expired' | 'critical' | 'soon' | 'upcoming' | 'valid' | 'none';

export function credStatus(expiresOn: string | null, today: Date): CredStatus {
  if (!expiresOn) return 'none';                       // non-expiring credential
  const d = daysBetween(civilLA(today), parseISODate(expiresOn));
  if (d < 0) return 'expired';
  if (d <= 7) return 'critical';
  if (d <= 30) return 'soon';
  if (d <= 90) return 'upcoming';
  return 'valid';
}

export const SEVERITY: Record<CredStatus, number> = {
  expired: 0, critical: 1, soon: 2, upcoming: 3, valid: 4, none: 5,
};

/**
 * § 3.3 — kept in code, not data. This is a legal and diligence rule, not configuration.
 * Changing it is a reviewed code change, not a settings toggle.
 */
export const REQUIRED: Record<ProviderType, CredentialType[]> = {
  RN: ['rn_license', 'tb_clearance', 'cpr_bls', 'live_scan'],
  LVN: ['lvn_license', 'tb_clearance', 'cpr_bls', 'live_scan'],
  CNA: ['cna_cert', 'tb_clearance', 'cpr_bls', 'live_scan'],
  HCA: ['hca_registry', 'tb_clearance', 'live_scan'],
  companion: ['live_scan', 'tb_clearance'],
};

export function requiredFor(p: Pick<Provider, 'type' | 'transports'>): CredentialType[] {
  return p.transports
    ? [...REQUIRED[p.type], 'auto_insurance', 'drivers_license']
    : REQUIRED[p.type];
}

export const LABEL: Record<CredentialType, string> = {
  rn_license: 'RN license',
  lvn_license: 'LVN license',
  cna_cert: 'CNA certification',
  hca_registry: 'HCA registry',
  live_scan: 'Live Scan',
  tb_clearance: 'TB clearance',
  cpr_bls: 'CPR/BLS',
  auto_insurance: 'Auto insurance',
  drivers_license: "Driver's license",
  immunization: 'Immunization',
  other: 'Other',
};

/**
 * Only the fields eligibility actually reads, so tests need not build whole rows.
 *
 * `deletedAt` is here because leaving it out was a hole of the same shape as the 0008
 * one, a layer up. `credentials` is soft-delete and `credentials_one_live_per_type` is
 * a PARTIAL index over `deleted_at IS NULL`, so a provider can legitimately hold a
 * revoked Live Scan and no live one. With the field absent from the type, nothing
 * discouraged a caller from passing every row — and the revoked clearance then counted
 * as satisfying the requirement. The filter that makes presence meaningful belongs
 * here, once, not in each caller.
 */
export type CredentialLike = {
  type: CredentialType;
  expiresOn: string | null;
  /** Set when the credential has been revoked. A revoked row proves nothing. */
  deletedAt?: string | null;
  /** When it was last checked against the issuing body. Drives `stale`, not blocking. */
  verifiedOn?: string | null;
};
export type ProviderLike = Pick<Provider, 'type' | 'transports' | 'status'>;

export interface Eligibility {
  eligible: boolean;
  missing: CredentialType[];
  expired: CredentialType[];
  blocking: CredentialType[];
  /**
   * Required credentials whose last verification is older than REVERIFY_AFTER_DAYS.
   *
   * REPORTED, NOT BLOCKING, and that is a deliberate line rather than an oversight.
   * I12 blocks on "missing or expired"; a stale verification is neither, and making
   * it blocking would silently take providers off every shortlist the day their
   * re-check fell due — a product and diligence decision for the operator and counsel,
   * not one to slip into a function. A licence marked non-expiring and last verified
   * years ago is eligible today, which is worth knowing; this is how you know.
   */
  stale: CredentialType[];
  reason: string | null;
}

export function eligibility(
  p: ProviderLike,
  creds: CredentialLike[],
  today: Date,
): Eligibility {
  const required = requiredFor(p);
  // A revoked credential proves nothing, whatever the caller passed in.
  const live = creds.filter((c) => !c.deletedAt);
  const present = new Set(live.map((c) => c.type));
  const missing = required.filter((t) => !present.has(t));
  const expired = live
    .filter((c) => required.includes(c.type) && credStatus(c.expiresOn, today) === 'expired')
    .map((c) => c.type);
  const blocking = [...new Set([...missing, ...expired])];
  const stale = live
    .filter((c) => required.includes(c.type)
      && c.verifiedOn != null
      && needsReverification(c.verifiedOn, today))
    .map((c) => c.type);

  return {
    eligible: p.status === 'active' && blocking.length === 0,
    missing,
    expired,
    blocking,
    stale,
    reason:
      p.status === 'inactive' ? 'Marked inactive'
      : p.status === 'do_not_refer' ? 'Marked do not refer'
      : blocking.length
        ? blocking.map((t) => `${LABEL[t]} ${expired.includes(t) ? 'expired' : 'missing'}`).join(', ')
        : null,
  };
}

/** The worst status across a provider's required credentials. Drives the Today queue. */
export function worstRequiredStatus(
  p: ProviderLike,
  creds: CredentialLike[],
  today: Date,
): CredStatus {
  const required = requiredFor(p);
  const present = new Map(
    creds.filter((c) => !c.deletedAt).map((c) => [c.type, c] as const));
  let worst: CredStatus = 'valid';
  for (const t of required) {
    const c = present.get(t);
    const s: CredStatus = c ? credStatus(c.expiresOn, today) : 'expired';  // missing is blocking
    if (SEVERITY[s] < SEVERITY[worst]) worst = s;
  }
  return worst;
}

/** § 5 Compliance: re-verification queue — `verified_on` older than 180 days. */
export const REVERIFY_AFTER_DAYS = 180;

export function needsReverification(verifiedOn: string, today: Date): boolean {
  return daysBetween(parseISODate(verifiedOn), civilLA(today)) > REVERIFY_AFTER_DAYS;
}
