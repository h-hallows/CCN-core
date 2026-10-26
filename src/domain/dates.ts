/**
 * Civil-date arithmetic in America/Los_Angeles.
 *
 * Every expiry comparison and every business-day count in this system is a question
 * about calendar days in California, not about elapsed milliseconds. Adding 86_400_000 ms
 * in a loop is off by an hour twice a year and can land on the wrong calendar day, so all
 * arithmetic here runs on civil (y, m, d) triples and never on instants.
 */

export const TZ = 'America/Los_Angeles';

export interface CivilDate { y: number; m: number; d: number }

const LA_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** The calendar date in California at this instant, as 'YYYY-MM-DD'. */
export function isoLA(at: Date): string {
  return LA_FORMATTER.format(at);
}

export function civilLA(at: Date): CivilDate {
  return parseISODate(isoLA(at));
}

/** Parse a plain 'YYYY-MM-DD'. Throws on anything else — a silent NaN date is worse. */
export function parseISODate(iso: string): CivilDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) throw new Error(`not an ISO date: ${iso}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const round = new Date(Date.UTC(y, mo - 1, d));
  if (round.getUTCFullYear() !== y || round.getUTCMonth() !== mo - 1 || round.getUTCDate() !== d) {
    throw new Error(`not a real date: ${iso}`);
  }
  return { y, m: mo, d };
}

export function formatISODate(c: CivilDate): string {
  return `${String(c.y).padStart(4, '0')}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
}

/** A UTC instant standing in for a civil date, used only as an arithmetic carrier. */
function carrier(c: CivilDate): number {
  return Date.UTC(c.y, c.m - 1, c.d);
}

function fromCarrier(ms: number): CivilDate {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

const DAY_MS = 86_400_000;

/** Calendar days from `a` to `b`. Negative when `b` is earlier. */
export function daysBetween(a: CivilDate, b: CivilDate): number {
  return Math.round((carrier(b) - carrier(a)) / DAY_MS);
}

export function addDays(c: CivilDate, n: number): CivilDate {
  return fromCarrier(carrier(c) + n * DAY_MS);
}

/** 0 = Sunday .. 6 = Saturday. */
export function weekday(c: CivilDate): number {
  return new Date(carrier(c)).getUTCDay();
}

/** First day of the month containing `c`. Used by the § 8 hours-per-month series. */
export function startOfMonth(c: CivilDate): CivilDate {
  return { y: c.y, m: c.m, d: 1 };
}

/**
 * Normalise a value that came out of a database row into 'YYYY-MM-DD' or null.
 *
 * A `date` column arrives as a `Date` from one driver and as a string from another, and
 * `parseISODate` is deliberately strict, so every raw row value crosses into domain code
 * through here.
 */
export function asISODate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return isoUTCDate(v);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : null;
}

/** The calendar date of a Date that is already a plain date carrier (UTC midnight). */
function isoUTCDate(d: Date): string {
  return formatISODate({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
}
