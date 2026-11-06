import { describe, expect, it } from 'vitest';
import {
  credStatus, eligibility, needsReverification, requiredFor, worstRequiredStatus,
  type CredentialLike, type ProviderLike,
} from '../src/domain/credentials';
import { addDays, civilLA, formatISODate } from '../src/domain/dates';

/** A fixed instant, mid-morning in California, so no test straddles a UTC day boundary. */
const TODAY = new Date('2026-10-24T17:00:00.000Z');
const offset = (n: number) => formatISODate(addDays(civilLA(TODAY), n));

const cred = (type: CredentialLike['type'], days: number | null): CredentialLike => ({
  type, expiresOn: days === null ? null : offset(days),
});

describe('§ 7.1 credential expiry boundaries', () => {
  it.each([
    [91, 'valid'], [90, 'upcoming'], [31, 'upcoming'], [30, 'soon'],
    [8, 'soon'], [7, 'critical'], [0, 'critical'], [-1, 'expired'],
  ] as const)('expiry today%+d -> %s', (days, expected) => {
    expect(credStatus(offset(days), TODAY)).toBe(expected);
  });

  it('expires_on NULL -> none', () => {
    expect(credStatus(null, TODAY)).toBe('none');
  });

  it('compares in California, not UTC', () => {
    // 23:30 on 24 Oct in California is already 25 Oct in UTC. A credential expiring
    // on 24 Oct must still read 'critical', not 'expired'.
    const lateEvening = new Date('2026-10-25T06:30:00.000Z');
    expect(credStatus('2026-10-24', lateEvening)).toBe('critical');
  });
});

describe('§ 3.3 required credential matrix', () => {
  it('adds driving credentials only when the provider transports', () => {
    expect(requiredFor({ type: 'HCA', transports: false }))
      .toEqual(['hca_registry', 'tb_clearance', 'live_scan']);
    expect(requiredFor({ type: 'HCA', transports: true }))
      .toEqual(['hca_registry', 'tb_clearance', 'live_scan', 'auto_insurance', 'drivers_license']);
  });
  it('does not require CPR/BLS of an HCA', () => {
    expect(requiredFor({ type: 'HCA', transports: false })).not.toContain('cpr_bls');
  });
});

describe('§ 7.1 eligibility — I12', () => {
  const rn: ProviderLike = { type: 'RN', transports: false, status: 'active' };
  const full: CredentialLike[] = [
    cred('rn_license', 400), cred('tb_clearance', 200), cred('cpr_bls', 300), cred('live_scan', null),
  ];

  it('RN with all four required, none expired, status active -> eligible', () => {
    const e = eligibility(rn, full, TODAY);
    expect(e.eligible).toBe(true);
    expect(e.reason).toBeNull();
    expect(e.blocking).toEqual([]);
  });

  it('RN missing live_scan -> not eligible, reason names Live Scan', () => {
    const e = eligibility(rn, full.filter((c) => c.type !== 'live_scan'), TODAY);
    expect(e.eligible).toBe(false);
    expect(e.reason).toContain('Live Scan');
    expect(e.reason).toContain('missing');
  });

  it('RN with tb_clearance expired yesterday -> not eligible, reason names TB expired', () => {
    const e = eligibility(rn, [...full.filter((c) => c.type !== 'tb_clearance'), cred('tb_clearance', -1)], TODAY);
    expect(e.eligible).toBe(false);
    expect(e.reason).toContain('TB clearance');
    expect(e.reason).toContain('expired');
    expect(e.expired).toEqual(['tb_clearance']);
  });

  it('HCA with no cpr_bls -> eligible, because CPR is not required for HCA', () => {
    const e = eligibility({ type: 'HCA', transports: false, status: 'active' },
      [cred('hca_registry', 300), cred('tb_clearance', 100), cred('live_scan', null)], TODAY);
    expect(e.eligible).toBe(true);
  });

  it('companion who transports, no auto_insurance -> not eligible', () => {
    const e = eligibility({ type: 'companion', transports: true, status: 'active' },
      [cred('live_scan', null), cred('tb_clearance', 100), cred('drivers_license', 500)], TODAY);
    expect(e.eligible).toBe(false);
    expect(e.blocking).toContain('auto_insurance');
  });

  it('companion who does not transport, no auto_insurance -> eligible', () => {
    const e = eligibility({ type: 'companion', transports: false, status: 'active' },
      [cred('live_scan', null), cred('tb_clearance', 100)], TODAY);
    expect(e.eligible).toBe(true);
  });

  it("fully credentialed provider, status inactive -> not eligible, reason 'Marked inactive'", () => {
    const e = eligibility({ ...rn, status: 'inactive' }, full, TODAY);
    expect(e.eligible).toBe(false);
    expect(e.reason).toBe('Marked inactive');
  });

  it("status do_not_refer -> not eligible, reason 'Marked do not refer' (I4 forward-only stop)", () => {
    const e = eligibility({ ...rn, status: 'do_not_refer' }, full, TODAY);
    expect(e.eligible).toBe(false);
    expect(e.reason).toBe('Marked do not refer');
  });

  it('names every blocking credential, not just the first', () => {
    const e = eligibility(rn, [cred('rn_license', 400)], TODAY);
    expect(e.blocking).toEqual(['tb_clearance', 'cpr_bls', 'live_scan']);
    expect(e.reason).toBe('TB clearance missing, CPR/BLS missing, Live Scan missing');
  });

  it('does not count a non-required credential expiring against the provider', () => {
    const e = eligibility(rn, [...full, cred('immunization', -30)], TODAY);
    expect(e.eligible).toBe(true);
  });
});

describe('worst required status drives the Today queue', () => {
  const rn: ProviderLike = { type: 'RN', transports: false, status: 'active' };
  it('reports the nearest expiry among required credentials', () => {
    const s = worstRequiredStatus(rn, [
      cred('rn_license', 400), cred('tb_clearance', 5), cred('cpr_bls', 300), cred('live_scan', null),
    ], TODAY);
    expect(s).toBe('critical');
  });
  it('treats a missing required credential as blocking', () => {
    expect(worstRequiredStatus(rn, [cred('rn_license', 400)], TODAY)).toBe('expired');
  });
});

describe('§ 5 re-verification queue', () => {
  it('flags a verification older than 180 days', () => {
    expect(needsReverification(offset(-181), TODAY)).toBe(true);
    expect(needsReverification(offset(-180), TODAY)).toBe(false);
  });
});

describe('a revoked credential proves nothing', () => {
  const rn = { type: 'RN', transports: false, status: 'active' } as const;
  const today = new Date('2026-11-05T12:00:00Z');
  const live = (type: string, expiresOn: string | null = '2027-01-01') =>
    ({ type, expiresOn } as never);

  it('does not count a soft-deleted row towards a requirement', () => {
    // credentials is soft-delete and its uniqueness index is partial over
    // deleted_at IS NULL, so holding a revoked Live Scan and no live one is a normal
    // state. Counting the revoked one is the 0008 bug a layer up.
    const withRevoked = [
      live('rn_license'), live('tb_clearance'), live('cpr_bls'),
      { type: 'live_scan', expiresOn: null, deletedAt: '2026-01-01' },
    ] as never[];
    const e = eligibility(rn, withRevoked, today);
    expect(e.eligible).toBe(false);
    expect(e.missing).toContain('live_scan');
  });

  it('counts it once it is live again', () => {
    const e = eligibility(rn, [
      live('rn_license'), live('tb_clearance'), live('cpr_bls'), live('live_scan', null),
    ] as never[], today);
    expect(e.eligible).toBe(true);
    expect(e.missing).toEqual([]);
  });

  it('reports a stale verification without blocking on it', () => {
    // Deliberate: I12 blocks on missing or expired, and a stale re-check is neither.
    // Making it blocking would take providers off every shortlist the day their
    // re-verification fell due, which is a decision for the operator and counsel.
    const e = eligibility(rn, [
      { type: 'rn_license', expiresOn: null, verifiedOn: '2016-01-01' },
      live('tb_clearance'), live('cpr_bls'), live('live_scan', null),
    ] as never[], today);
    expect(e.eligible).toBe(true);
    expect(e.stale).toContain('rn_license');
  });

  it('says nothing is stale when everything was checked recently', () => {
    const e = eligibility(rn, [
      { type: 'rn_license', expiresOn: null, verifiedOn: '2026-10-01' },
      live('tb_clearance'), live('cpr_bls'), live('live_scan', null),
    ] as never[], today);
    expect(e.stale).toEqual([]);
  });

  it('worstRequiredStatus ignores revoked rows too', () => {
    const worst = worstRequiredStatus(rn, [
      live('rn_license'), live('tb_clearance'), live('cpr_bls'),
      { type: 'live_scan', expiresOn: null, deletedAt: '2026-01-01' },
    ] as never[], today);
    // The Live Scan is effectively missing, which ranks as expired.
    expect(worst).toBe('expired');
  });
});
