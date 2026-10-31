/**
 * The I9 ruleset, as data. One copy, every consumer.
 *
 * § 1812.5095(g): a nurses' registry must not hold itself out as the employer of the
 * providers it refers, and must not characterise them as its contractors either.
 * Providers are *referred providers*.
 *
 * Two of these terms are about licensure rather than employment, and matter most on the
 * public surface:
 *
 *  - "home health" implies a Home Health Agency licence. A registry is exempt from that
 *    licensure under HSC § 1726(c) precisely because it is not one, and describing
 *    itself in those words forfeits the exemption it relies on.
 *  - the bond and licence terms are forbidden by § 1812.5095(i)–(j), which bars a
 *    registry from advertising its surety bond or any licensure at all.
 */

/** Forbidden in any operator-, provider- or client-facing copy. */
export const FORBIDDEN_COPY = [
  'independent contractor',
  'self-employed',
  'self employed',
  'our nurses',
  'our caregivers',
  'our staff',
  'our employees',
  'home health',
  'surety bond',
  'bonded and insured',
  'licensed and bonded',
];

/**
 * The statutory texts are the one place these words may appear, and the exception
 * covers ALL of them rather than `employee` alone.
 *
 * § 1812.5095(f)'s written statement contains "independent contractor" verbatim, and the
 * § 1812.533(b)(4) residence disclosure contains both "self-employed" and "home health
 * agency" — the statute puts them there. Meanwhile § 1812.5095(g) bars CCN from using
 * those same labels in its own copy.
 *
 * The distinction the build has to hold: statutory text is reproduced exactly; CCN's own
 * copy never uses those labels. Scoping the exception to one directory is what keeps
 * those two facts from collapsing into each other.
 *
 * Paths are matched as substrings of the path relative to the linted root, so the
 * exception travels with the files rather than with a filename convention.
 */
export const STATUTORY_ALLOWED_IN = [
  'content/statutory/',
  'components/content/statutory/',
];

/** Forbidden everywhere, including the statutory directory. No statute requires these. */
export const NEVER_ALLOWED = [
  'surety bond',
  'bonded and insured',
  'licensed and bonded',
];

export const EMPLOYEE_TERM = 'employee';

/** @deprecated kept for callers that have not moved to STATUTORY_ALLOWED_IN. */
export const EMPLOYEE_ALLOWED_IN = STATUTORY_ALLOWED_IN;

export function isStatutoryPath(relativePath) {
  return STATUTORY_ALLOWED_IN.some((allowed) => relativePath.includes(allowed));
}

/** The copy terms that apply to a given file. */
export function copyTermsFor(relativePath) {
  if (isStatutoryPath(relativePath)) {
    // Reproducing the statute is the whole job of these files. What stays banned is the
    // advertising § 1812.5095(i)-(j) forbids outright, which no statutory text contains.
    return NEVER_ALLOWED;
  }
  return [...FORBIDDEN_COPY, EMPLOYEE_TERM];
}

/**
 * Forbidden identifiers: I1 training, I2 work direction, I7 correction, I8 equipment.
 *
 * The earlier form was word-bounded and so missed camelCase entirely — `tasks` was
 * caught but `taskList` was not, which is exactly how one of these would reach the
 * codebase in practice.
 */
const IDENTIFIER_RULES = [
  { alternation: 'training|course|courses|module|modules|curriculum|competency|competencies', invariant: 'I1' },
  { alternation: 'care_?plan|task|tasks|duty|duties|checklist|checklists', invariant: 'I2' },
  { alternation: 'performance_?review|coaching|corrective_?action|discipline|write_?up', invariant: 'I7' },
  { alternation: 'uniform|uniforms|badge|badges|equipment_?assignment|device_?assignment|inventory', invariant: 'I8' },
];

/**
 * Longest alternative first. Regex alternation is ordered, so with `task|tasks` the
 * shorter one wins at the same position, the trailing `s` then reads as part of a longer
 * word, and `tasks` slips through. Sorting here rather than by hand means adding a term
 * later cannot reintroduce that.
 */
function longestFirst(alternation) {
  return alternation.split('|').sort((a, b) => b.length - a.length).join('|');
}

export const FORBIDDEN_IDENTIFIERS = IDENTIFIER_RULES.map(({ alternation, invariant }) => ({
  pattern: new RegExp(`(?:^|[^a-zA-Z])(${longestFirst(alternation)})`, 'gi'),
  invariant,
}));

/**
 * Every forbidden identifier in `text`, as {index, match, invariant}.
 *
 * The trailing boundary is checked here rather than as a lookahead, because the patterns
 * carry the `i` flag for the term itself and under that flag `(?![a-z])` would reject an
 * uppercase letter too — which is precisely the camelCase case this is meant to catch.
 * A following lowercase letter means the term is part of a longer word (`multitasking`),
 * so it is not a hit; anything else (`taskList`, `task_list`, `tasks `) is.
 */
export function findIdentifierHits(text) {
  const hits = [];
  for (const { pattern, invariant } of FORBIDDEN_IDENTIFIERS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const term = m[1];
      const after = text[m.index + m[0].length];
      if (after !== undefined && after >= 'a' && after <= 'z') continue;
      hits.push({ index: m.index + m[0].length - term.length, match: term, invariant });
    }
  }
  return hits;
}

export const LINTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.md', '.json', '.sql']);
