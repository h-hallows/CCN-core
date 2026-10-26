/**
 * California business-day arithmetic. Spec § 4.5.
 *
 * Load-bearing: this computes the § 1812.5095(f) three-business-day deadline for the
 * written statement that must follow an oral disclosure. Getting it wrong is a missed
 * statutory deadline, at $2,500 per violation under § 1812.5095(k).
 *
 * Holidays are generated rather than pasted in, so the table never silently runs out.
 * Observed dates, not nominal: a California state holiday falling on a Saturday is
 * observed the preceding Friday, and one falling on a Sunday the following Monday.
 * 4 July 2026 is a Saturday and is observed Friday 3 July 2026.
 */
import { addDays, type CivilDate, formatISODate, parseISODate, weekday } from './dates';

/** nth (1-based) `dow` of a month. */
function nthWeekdayOfMonth(y: number, m: number, dow: number, n: number): CivilDate {
  const first: CivilDate = { y, m, d: 1 };
  const shift = (dow - weekday(first) + 7) % 7;
  return addDays(first, shift + (n - 1) * 7);
}

function lastWeekdayOfMonth(y: number, m: number, dow: number): CivilDate {
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last: CivilDate = { y, m, d: lastDay };
  return addDays(last, -((weekday(last) - dow + 7) % 7));
}

/** Saturday -> preceding Friday, Sunday -> following Monday. Fixed-date holidays only. */
function observed(c: CivilDate): CivilDate {
  const w = weekday(c);
  if (w === 6) return addDays(c, -1);
  if (w === 0) return addDays(c, 1);
  return c;
}

/**
 * California state holidays for one year, as observed ISO dates.
 * Cesar Chavez Day (31 March) is included — it is a California holiday and is easy to
 * miss when porting a generic US holiday list.
 */
export function caHolidaysForYear(y: number): string[] {
  const thanksgiving = nthWeekdayOfMonth(y, 11, 4, 4);          // 4th Thursday, November
  const dates: CivilDate[] = [
    observed({ y, m: 1, d: 1 }),                                // New Year's Day
    nthWeekdayOfMonth(y, 1, 1, 3),                              // MLK Day
    nthWeekdayOfMonth(y, 2, 1, 3),                              // Presidents' Day
    observed({ y, m: 3, d: 31 }),                               // Cesar Chavez Day
    lastWeekdayOfMonth(y, 5, 1),                                // Memorial Day
    observed({ y, m: 7, d: 4 }),                                // Independence Day
    nthWeekdayOfMonth(y, 9, 1, 1),                              // Labor Day
    observed({ y, m: 11, d: 11 }),                              // Veterans Day
    thanksgiving,
    addDays(thanksgiving, 1),                                   // Day after Thanksgiving
    observed({ y, m: 12, d: 25 }),                              // Christmas
  ];
  return dates.map(formatISODate);
}

const holidayCache = new Map<number, Set<string>>();

export function isCaHoliday(c: CivilDate): boolean {
  let set = holidayCache.get(c.y);
  if (!set) {
    set = new Set(caHolidaysForYear(c.y));
    holidayCache.set(c.y, set);
  }
  return set.has(formatISODate(c));
}

export function isBusinessDay(c: CivilDate): boolean {
  const w = weekday(c);
  return w !== 0 && w !== 6 && !isCaHoliday(c);
}

/**
 * `n` California business days after `from`. The start day is never counted, whether or
 * not it is itself a business day — three business days after a Friday is the following
 * Wednesday, and so is three business days after that Saturday.
 */
export function addBusinessDays(from: CivilDate, n: number): CivilDate {
  if (n < 0) throw new Error('addBusinessDays expects a non-negative count');
  let d = from;
  let added = 0;
  while (added < n) {
    d = addDays(d, 1);
    if (isBusinessDay(d)) added++;
  }
  return d;
}

/** The § 1812.5095(f) deadline: three California business days after the disclosure. */
export const WRITTEN_STATEMENT_BUSINESS_DAYS = 3;

export function writtenStatementDueOn(disclosedOnISO: string): string {
  return formatISODate(
    addBusinessDays(parseISODate(disclosedOnISO), WRITTEN_STATEMENT_BUSINESS_DAYS),
  );
}
