/**
 * Where the registry works, in one vocabulary. Front door spec § 4.
 *
 * WHY THIS IS SHARED. There were two. The public forms and the crossed pages speak in
 * slugs — `santa_monica` — because they come from URLs and enum fields. The roster and
 * the household record speak in names a person typed — `Santa Monica` — because an
 * operator typed them. Nothing reconciled the two, and the matcher compares a
 * household's area to a provider's by string equality.
 *
 * So an enquiry converted with its area carried straight across produced a household
 * whose `cr_area` was `santa_monica`, which matches no provider, ever, silently. The
 * case looks right on every screen and simply never has anybody eligible — the worst
 * shape of bug this system can have, because an empty shortlist is a legitimate
 * answer and nothing distinguishes the two.
 *
 * NOT AN ENUM IN THE DATABASE, deliberately. `providers.areas` and `households.cr_area`
 * are free text the operator writes, and a registry that cannot record a household two
 * streets outside its usual patch is worse than one with a tidy vocabulary. This is the
 * canonical list for everything the software generates — forms, URLs, prefills — and a
 * translation for everything a person wrote.
 */

export const AREAS = [
  'century_city', 'beverly_hills', 'westwood', 'brentwood', 'bel_air',
  'holmby_hills', 'santa_monica', 'pacific_palisades', 'malibu', 'other',
] as const;

export type AreaSlug = (typeof AREAS)[number];

const LABEL: Record<AreaSlug, string> = {
  century_city: 'Century City',
  beverly_hills: 'Beverly Hills',
  westwood: 'Westwood',
  brentwood: 'Brentwood',
  bel_air: 'Bel Air',
  holmby_hills: 'Holmby Hills',
  santa_monica: 'Santa Monica',
  pacific_palisades: 'Pacific Palisades',
  malibu: 'Malibu',
  other: 'Elsewhere in the area',
};

export function isAreaSlug(value: unknown): value is AreaSlug {
  return typeof value === 'string' && (AREAS as readonly string[]).includes(value);
}

/**
 * The name a person would write, from whatever was stored.
 *
 * Anything that is not a known slug comes back as it went in. A household recorded as
 * "La Cañada" by an operator is not a mistake to be corrected into a slug — it is a
 * place, written by the person who spoke to them.
 */
export function areaLabel(value: string | null | undefined): string {
  if (!value) return '';
  return isAreaSlug(value) ? LABEL[value] : value;
}

/** The slug for a label, where one exists. Used for links, never for storage. */
export function areaSlug(label: string | null | undefined): AreaSlug | null {
  if (!label) return null;
  const wanted = label.trim().toLowerCase();
  const found = (AREAS as readonly AreaSlug[])
    .find((slug) => LABEL[slug].toLowerCase() === wanted);
  return found ?? null;
}

/**
 * Whether a stored area still looks like a slug.
 *
 * The specific mistake worth catching: a value that went into a household record
 * without being translated. `cr_area` holding `santa_monica` is never something an
 * operator typed.
 */
export function looksLikeUntranslatedSlug(value: string | null | undefined): boolean {
  return isAreaSlug(value) && value !== 'other';
}
