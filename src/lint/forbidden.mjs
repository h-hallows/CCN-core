/**
 * The I9 ruleset, as data. One copy, every consumer.
 *
 * § 1812.5095(g): a nurses' registry must not hold itself out as the employer of the
 * providers it refers, and must not characterise them as its contractors either.
 * Providers are *referred providers*.
 *
 * Architecture spec § 2.5 adds five terms to this list and moves bare `employee` to a
 * path exception. That merge is deliberately NOT part of the move into this package —
 * it is a change to what the lint catches, and it belongs in its own reviewable change.
 */

/** Forbidden in any operator-, provider- or client-facing copy. */
export const FORBIDDEN_COPY = [
  'independent contractor',
  'self-employed',
  'our nurses',
  'our caregivers',
  'our staff',
  'our employees',
  'employee',
];

/**
 * Forbidden identifiers: I1 training, I2 work direction, I7 correction, I8 equipment.
 *
 * KNOWN GAP: these are word-bounded, so `tasks` and `training_modules` are caught but
 * `taskList` and `trainingModules` are not. Widening them is part of the § 2.5 ruleset
 * merge, not of moving the lint into this package. A test pins the current behaviour so
 * the gap stays visible.
 */
export const FORBIDDEN_IDENTIFIERS = [
  { pattern: /\b(?:training|course|module|curriculum|competency)(?:s|_[a-z_]+)?\b/gi, invariant: 'I1' },
  { pattern: /\b(?:care_plan|careplan|task|tasks|duty|duties|checklist)(?:_[a-z_]+)?\b/gi, invariant: 'I2' },
  { pattern: /\b(?:performance_review|coaching|corrective_action|discipline|write_up)\b/gi, invariant: 'I7' },
  { pattern: /\b(?:uniform|badge|equipment_assignment|device_assignment|inventory)\b/gi, invariant: 'I8' },
];

export const LINTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.md', '.json', '.sql']);
