/**
 * No calendar date may be taken from the server's clock.
 *
 * THE BUG THIS EXISTS FOR, FOUR TIMES OVER. Nothing in this system sets a connection
 * TimeZone, so `current_date` on a managed Postgres is UTC. Between four in the
 * afternoon and midnight Pacific — a third of the working day, every day — the server's
 * date is already tomorrow. Code that asks the database what day it is gets the wrong
 * answer every afternoon, and gets it silently.
 *
 * It has shipped here three times and been caught a fourth:
 *
 *   - the fee schedule decided "in force" from a UTC date, showing a schedule live up to
 *     eight hours early on the screen that exists to make the § 1812.527 seven-day
 *     embargo auditable (V1-REVIEW § 2);
 *   - the coverage window used `current_date`, silently dropping TONIGHT's gaps from
 *     late afternoon Pacific — including the overnight block, which is the one that
 *     matters at that hour (V1-REVIEW § 2);
 *   - the § 8 capacity month series grew a row for a month that had not started in
 *     California, and marked it as the month in progress;
 *   - the § 8 leakage window pulled in an extra month of history, which is the same
 *     mistake wearing a harmless face.
 *
 * Every one was found by reading, not by failing. That is the argument for a rule: the
 * defect is invisible for sixteen hours a day and wrong for eight, and the eight are the
 * hours when an operator is most likely to be looking at the screen.
 *
 * WHAT IS ALLOWED. `now()` as an instant — `expires_at > now()`, `SET handled_at =
 * now()` — is correct and timezone-independent, because an instant is the same instant
 * everywhere. What is refused is turning the server's clock into a CALENDAR DATE. The
 * one permitted way to ask what day it is, in SQL, is
 *
 *     (now() AT TIME ZONE 'America/Los_Angeles')::date
 *
 * and the rules below are written so that form passes and every shorter one does not.
 *
 * This is a source rule rather than a runtime one because there is nothing to check at
 * runtime: the wrong answer is a valid date, eight hours a day.
 */

/** The timezone every calendar question in this system is asked in. */
export const CIVIL_TZ = 'America/Los_Angeles';

export interface ClockRule {
  /** What is refused. */
  pattern: RegExp;
  /** What to write instead, in the message an assertion prints. */
  instead: string;
}

/**
 * Deliberately narrow and literal. A rule that tried to understand the SQL would have to
 * be right about parsing it; these ask only whether a particular spelling appears, and
 * each spelling is one that cannot be correct in this codebase.
 */
export const CLOCK_RULES: readonly ClockRule[] = [
  {
    pattern: /\bcurrent_date\b/i,
    instead: `(now() AT TIME ZONE '${CIVIL_TZ}')::date`,
  },
  {
    pattern: /\bcurrent_timestamp\b/i,
    instead: 'now(), which is the same instant everywhere',
  },
  {
    pattern: /\blocaltimestamp\b|\blocaltime\b/i,
    instead: 'now(), which carries its zone',
  },
  {
    // `now()::date` is the long way of writing current_date and is wrong for the same
    // reason. The parenthesised LA form does not match: there, `::date` follows `)`.
    pattern: /\bnow\s*\(\s*\)\s*::\s*date\b/i,
    instead: `(now() AT TIME ZONE '${CIVIL_TZ}')::date`,
  },
  {
    // Casting away the zone and then reasoning about the result is the same mistake with
    // an extra step. `::timestamptz` is fine, so the negative lookahead matters.
    pattern: /\bnow\s*\(\s*\)\s*::\s*timestamp\b(?!tz)/i,
    instead: `now() AT TIME ZONE '${CIVIL_TZ}' if a civil time is meant`,
  },
  {
    // date_trunc over the raw clock. The LA form reads `(now() AT TIME ZONE …)` and does
    // not match, because this requires `now()` immediately after the comma.
    pattern: /\bdate_trunc\s*\(\s*'[a-z]+'\s*,\s*now\s*\(\s*\)/i,
    instead: `date_trunc('…', (now() AT TIME ZONE '${CIVIL_TZ}')::date)`,
  },
];

export interface ClockViolation {
  path: string;
  /** 1-indexed, so an editor can be pointed at it. */
  line: number;
  text: string;
  instead: string;
}

/**
 * Comments removed, so a rule can be explained without tripping itself.
 *
 * Three kinds, because these files carry all three: JavaScript block and line comments,
 * and SQL `--` comments, which live inside template literals where a JS comment stripper
 * would not look. A line whose first non-space characters are `--`, `//` or `*` is prose
 * in every file this scans.
 */
function withoutComments(text: string): string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('--') || trimmed.startsWith('//') || trimmed.startsWith('*')) {
        return '';
      }
      return line.replace(/\/\/.*$/, '');
    });
}

/**
 * Every place a file asks the server what day it is.
 *
 * Takes the files rather than finding them: each repository knows its own layout, and a
 * scanner that walked a guessed set of directories would silently cover less than the
 * caller thought it did.
 */
export function clockViolations(
  files: readonly { path: string; text: string }[],
): ClockViolation[] {
  const found: ClockViolation[] = [];
  for (const file of files) {
    withoutComments(file.text).forEach((line, i) => {
      for (const rule of CLOCK_RULES) {
        if (rule.pattern.test(line)) {
          found.push({
            path: file.path,
            line: i + 1,
            text: line.trim(),
            instead: rule.instead,
          });
          return;
        }
      }
    });
  }
  return found;
}

/** The sentence an assertion prints, listing every violation with its replacement. */
export function clockReport(found: readonly ClockViolation[]): string {
  if (found.length === 0) return '';
  return [
    'A calendar date taken from the server clock. Nothing sets a connection TimeZone, so',
    `that date is UTC, and from late afternoon Pacific it is already tomorrow. Use`,
    `(now() AT TIME ZONE '${CIVIL_TZ}')::date, or pass the date in as a parameter.`,
    '',
    ...found.map((v) => `  ${v.path}:${v.line}\n    ${v.text}\n    instead: ${v.instead}`),
  ].join('\n');
}
