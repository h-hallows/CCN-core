/** § 4.3 hard filters, and the deliberate absence of the § 4.4 soft score. */
import { describe, expect, it } from 'vitest';
import { PERMITTED, overlap, screen, type Candidate } from '../src/domain/match';
import * as matchModule from '../src/domain/match';

const TODAY = new Date('2026-10-24T17:00:00.000Z');

const base: Candidate = {
  id: 'p1', fullName: 'Alma Reyes', type: 'RN', transports: false, status: 'active',
  areas: ['Pasadena', 'Altadena'], availability: ['Mon:AM', 'Tue:AM', 'Wed:AM'],
  specialties: ['wound_care'], languages: ['English', 'Spanish'], rateHourly: '68.00',
  credentials: [
    { type: 'rn_license', expiresOn: '2027-06-01' },
    { type: 'tb_clearance', expiresOn: '2027-01-01' },
    { type: 'cpr_bls', expiresOn: '2027-03-01' },
    { type: 'live_scan', expiresOn: null },
  ],
};

const kase = {
  care: 'skilled_nursing' as const, schedule: ['Mon:AM', 'Tue:AM'], languagePref: 'Spanish',
  rateBandLow: '60.00', rateBandHigh: '72.00', specialtiesWanted: ['wound_care'],
};
const household = { crArea: 'Pasadena', blockedProviderIds: [] as string[] };

describe('§ 4.3 hard filters', () => {
  it('includes a provider who clears every filter', () => {
    const r = screen(base, kase, household, TODAY);
    expect(r.included).toBe(true);
  });

  it('excludes a provider the household asked not to be referred', () => {
    const r = screen(base, kase, { ...household, blockedProviderIds: ['p1'] }, TODAY);
    expect(r.included).toBe(false);
    if (!r.included) expect(r.exclusion.code).toBe('blocked_by_household');
  });

  it('excludes a provider whose required credential has lapsed, and says which', () => {
    const lapsed: Candidate = {
      ...base,
      credentials: base.credentials.map((c) =>
        c.type === 'tb_clearance' ? { ...c, expiresOn: '2026-10-23' } : c),
    };
    const r = screen(lapsed, kase, household, TODAY);
    expect(r.included).toBe(false);
    if (!r.included) {
      expect(r.exclusion.code).toBe('not_eligible');
      expect(r.exclusion.detail).toContain('TB clearance expired');
    }
  });

  it('excludes a provider type outside scope of practice for the care type', () => {
    const r = screen({ ...base, type: 'companion', credentials: [
      { type: 'live_scan', expiresOn: null }, { type: 'tb_clearance', expiresOn: '2027-01-01' },
    ] }, kase, household, TODAY);
    expect(r.included).toBe(false);
    if (!r.included) expect(r.exclusion.code).toBe('type_not_permitted');
  });

  it('excludes a provider who does not cover the area, naming the area', () => {
    const r = screen(base, kase, { ...household, crArea: 'Monrovia' }, TODAY);
    expect(r.included).toBe(false);
    if (!r.included) expect(r.exclusion.detail).toContain('Monrovia');
  });

  it('excludes a provider whose stated availability does not meet the requested pattern', () => {
    const r = screen({ ...base, availability: ['Sat:NOC'] }, kase, household, TODAY);
    expect(r.included).toBe(false);
    if (!r.included) expect(r.exclusion.code).toBe('no_availability_overlap');
  });

  it('keeps a partial availability match, because partial cover is still a conversation', () => {
    const r = screen({ ...base, availability: ['Mon:AM'] }, kase, household, TODAY);
    expect(r.included).toBe(true);
    if (r.included) {
      expect(r.signals.blocksCovered).toBe(1);
      expect(r.signals.blocksRequired).toBe(2);
    }
  });

  it('never excludes a provider for being over the rate band — rates are negotiable (I5)', () => {
    const r = screen({ ...base, rateHourly: '110.00' }, kase, household, TODAY);
    expect(r.included).toBe(true);
    if (r.included) expect(r.signals.rateVsBand).toBe('over');
  });
});

describe('signals are raw observations, not weights', () => {
  it('reports each signal as the number itself', () => {
    const r = screen(base, kase, household, TODAY);
    expect(r.included).toBe(true);
    if (!r.included) return;
    expect(r.signals).toMatchObject({
      specialtyMatches: ['wound_care'],
      blocksRequired: 2,
      blocksCovered: 2,
      languageMet: true,
      areaRank: 0,
      rateVsBand: 'at_or_under',
    });
  });

  it('reports languageMet as null when the case states no preference', () => {
    const r = screen(base, { ...kase, languagePref: null }, household, TODAY);
    if (r.included) expect(r.signals.languageMet).toBeNull();
  });

  it('exports no composite score — § 4.4 is deferred, see /DEFERRED.md', () => {
    for (const name of Object.keys(matchModule)) {
      expect(name).not.toMatch(/score|weight|rank(?!ing)/i);
    }
    const r = screen(base, kase, household, TODAY);
    if (r.included) {
      expect(Object.keys(r.signals)).not.toContain('total');
      expect(Object.keys(r.signals)).not.toContain('score');
    }
  });
});

describe('scope of practice', () => {
  it('limits skilled nursing and post-surgical care to RN and LVN', () => {
    expect(PERMITTED.skilled_nursing).toEqual(['RN', 'LVN']);
    expect(PERMITTED.post_surgical).toEqual(['RN', 'LVN']);
  });
  it('does not let a companion take personal care', () => {
    expect(PERMITTED.personal_care).not.toContain('companion');
  });
});

describe('overlap', () => {
  it('returns the intersection in the order of the first list', () => {
    expect(overlap(['a', 'b', 'c'], ['c', 'a'])).toEqual(['a', 'c']);
    expect(overlap([], ['a'])).toEqual([]);
  });
});
