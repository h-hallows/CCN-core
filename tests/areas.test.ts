/**
 * One vocabulary for where the registry works.
 *
 * The bug this exists to prevent is silent: the matcher compares a household's area to
 * a provider's by string equality, so a household stored as `santa_monica` rather than
 * `Santa Monica` never matches anybody — and an empty shortlist is a legitimate answer,
 * so nothing distinguishes "nobody covers that area" from "the area was never
 * translated".
 */
import { describe, expect, it } from 'vitest';
import {
  AREAS, areaLabel, areaSlug, isAreaSlug, looksLikeUntranslatedSlug,
} from '../src/domain/areas';

describe('translating between the two', () => {
  it('round-trips every area', () => {
    for (const slug of AREAS) {
      const label = areaLabel(slug);
      expect(label, slug).not.toBe(slug);
      expect(label.length, slug).toBeGreaterThan(2);
      if (slug !== 'other') expect(areaSlug(label), slug).toBe(slug);
    }
  });

  it('leaves what a person wrote exactly as they wrote it', () => {
    /*
     * `providers.areas` and `households.cr_area` are free text on purpose. A registry
     * that cannot record a household two streets outside its usual patch is worse than
     * one with a tidy vocabulary, so anything unrecognised passes through untouched
     * rather than being corrected into a slug.
     */
    expect(areaLabel('La Cañada')).toBe('La Cañada');
    expect(areaLabel('Pasadena')).toBe('Pasadena');
    expect(areaSlug('Pasadena')).toBeNull();
  });

  it('handles nothing at all', () => {
    expect(areaLabel(null)).toBe('');
    expect(areaLabel(undefined)).toBe('');
    expect(areaSlug('')).toBeNull();
    expect(isAreaSlug(undefined)).toBe(false);
  });

  it('matches a label whatever case it was typed in', () => {
    expect(areaSlug('santa monica')).toBe('santa_monica');
    expect(areaSlug('  BEVERLY HILLS ')).toBe('beverly_hills');
  });

  it('spots a value that was stored without being translated', () => {
    expect(looksLikeUntranslatedSlug('santa_monica')).toBe(true);
    expect(looksLikeUntranslatedSlug('Santa Monica')).toBe(false);
    // 'other' is a real choice on the form rather than a place, so a household
    // recorded against it is not evidence of a missing translation.
    expect(looksLikeUntranslatedSlug('other')).toBe(false);
  });
});
