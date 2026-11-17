/**
 * The dates every other answer is built from, at the moments they go wrong.
 *
 * `src/domain/dates.ts` has no test file of its own. It is used by `credentials.test.ts`
 * and `businessDays.test.ts`, which is how it has been checked so far — through two
 * callers, on whatever day the suite happened to run. That is the weakest kind of
 * coverage for the strongest kind of dependency: every expiry comparison, every
 * business-day count, every "is this in force yet" in this system resolves through these
 * six functions.
 *
 * And the failure mode is proven rather than theoretical. Three defects in this project
 * have been the same defect: a date decided in UTC where California was meant, found
 * twice in V1-REVIEW § 2 and a third time in `capacity()` this month. A fourth was a
 * `date` column arriving as a Date where a string was declared, which silently refused
 * every nursing referral. None of them was visible on an ordinary afternoon.
 *
 * So the dates here are chosen to be the awkward ones, and they are fixed. A test that
 * only runs on today's date is a test that checks one of 365 cases and reports the other
 * 364 as passing.
 */
import { describe, expect, it } from 'vitest';
import {
  addDays, asISODate, civilLA, daysBetween, formatISODate, isoLA, parseISODate,
  startOfMonth, weekday,
} from '../src/domain/dates';

describe('California, not the server', () => {
  /*
   * The whole class, in one shape: an instant where UTC and Pacific disagree about what
   * day it is. Between 16:00 and 23:59 Pacific in winter, the server's date is already
   * tomorrow — which is how a month series grew a row for a month nobody was in yet, and
   * how a coverage window dropped tonight's overnight block from four in the afternoon.
   */
  it('reads an evening in California as that day, not the next one', () => {
    // 2026-12-31 17:30 Pacific is 2027-01-01 01:30 UTC. A whole year apart.
    const newYearsEve = new Date('2027-01-01T01:30:00Z');
    expect(newYearsEve.toISOString().slice(0, 10)).toBe('2027-01-01');
    expect(isoLA(newYearsEve)).toBe('2026-12-31');
    expect(civilLA(newYearsEve)).toEqual({ y: 2026, m: 12, d: 31 });
  });

  it('reads an early morning in California as that day too', () => {
    // 2027-01-01 00:30 Pacific is 08:30 UTC the same day — the easy direction, asserted
    // so a "fix" that subtracts eight hours everywhere fails here instead of shipping.
    const justAfterMidnight = new Date('2027-01-01T08:30:00Z');
    expect(isoLA(justAfterMidnight)).toBe('2027-01-01');
  });

  it('holds across the spring forward, when a day is 23 hours long', () => {
    // 2027-03-14 02:00 Pacific does not exist; the clock jumps to 03:00.
    const before = new Date('2027-03-14T09:30:00Z'); // 01:30 PST
    const after = new Date('2027-03-14T11:30:00Z');  // 04:30 PDT
    expect(isoLA(before)).toBe('2027-03-14');
    expect(isoLA(after)).toBe('2027-03-14');
    // One calendar day, whatever the clocks did in between.
    expect(daysBetween(civilLA(before), civilLA(after))).toBe(0);
  });

  it('holds across the fall back, when an hour happens twice', () => {
    // 2026-11-01 01:30 Pacific occurs twice: 08:30 UTC (PDT) and 09:30 UTC (PST).
    const first = new Date('2026-11-01T08:30:00Z');
    const second = new Date('2026-11-01T09:30:00Z');
    expect(isoLA(first)).toBe('2026-11-01');
    expect(isoLA(second)).toBe('2026-11-01');
  });

  it('counts a day across the spring forward as one day, not as 23 hours', () => {
    /*
     * The reason this module does civil arithmetic rather than millisecond arithmetic.
     * Adding 86_400_000 ms to the 13th lands at 23:00 on the 13th, and a loop that does
     * it repeatedly walks backwards through the calendar an hour at a time.
     */
    const thirteenth = parseISODate('2027-03-13');
    expect(formatISODate(addDays(thirteenth, 1))).toBe('2027-03-14');
    expect(formatISODate(addDays(thirteenth, 2))).toBe('2027-03-15');
    expect(daysBetween(parseISODate('2027-03-13'), parseISODate('2027-03-15'))).toBe(2);
  });
});

describe('the ends of months and years', () => {
  it('rolls a year over', () => {
    expect(formatISODate(addDays(parseISODate('2026-12-31'), 1))).toBe('2027-01-01');
    expect(formatISODate(addDays(parseISODate('2027-01-01'), -1))).toBe('2026-12-31');
    expect(daysBetween(parseISODate('2026-12-31'), parseISODate('2027-01-01'))).toBe(1);
  });

  it('knows which Februaries have 29 days', () => {
    expect(formatISODate(addDays(parseISODate('2028-02-28'), 1))).toBe('2028-02-29');
    expect(formatISODate(addDays(parseISODate('2028-02-29'), 1))).toBe('2028-03-01');
    // 2027 is not a leap year; 2100 will not be one either, which is the rule most
    // hand-rolled implementations get wrong.
    expect(formatISODate(addDays(parseISODate('2027-02-28'), 1))).toBe('2027-03-01');
    expect(formatISODate(addDays(parseISODate('2100-02-28'), 1))).toBe('2100-03-01');
    expect(daysBetween(parseISODate('2028-02-01'), parseISODate('2028-03-01'))).toBe(29);
  });

  it('counts a whole year, leap or not', () => {
    expect(daysBetween(parseISODate('2027-01-01'), parseISODate('2028-01-01'))).toBe(365);
    expect(daysBetween(parseISODate('2028-01-01'), parseISODate('2029-01-01'))).toBe(366);
  });

  it('takes the first of the month from any day in it, including the last', () => {
    for (const [day, first] of [
      ['2027-01-31', '2027-01-01'],
      ['2028-02-29', '2028-02-01'],
      ['2026-12-31', '2026-12-01'],
      ['2027-03-14', '2027-03-01'],
    ] as const) {
      expect(formatISODate(startOfMonth(parseISODate(day))), day).toBe(first);
    }
  });

  it('names the weekday across a year boundary and a leap day', () => {
    // 0 = Sunday. 2027-01-01 is a Friday; 2028-02-29 is a Tuesday.
    expect(weekday(parseISODate('2027-01-01'))).toBe(5);
    expect(weekday(parseISODate('2028-02-29'))).toBe(2);
    // Seven days on is the same weekday, over a month end.
    const d = parseISODate('2027-01-28');
    expect(weekday(addDays(d, 7))).toBe(weekday(d));
  });
});

describe('a date coming out of a database row', () => {
  /*
   * `asISODate` is the one place a raw row value becomes a date, and it exists because
   * the first version of `AssignmentFacts` declared `startsOn: string` against a driver
   * that returns a Date. Every start date in the database read as absent, and every
   * private duty nursing referral would have been refused.
   */
  it('reads a Date carrying a plain date, in UTC, not in the local zone', () => {
    // How a `date` column arrives: UTC midnight. Read in Pacific it is the day before,
    // which is the bug this function exists to prevent.
    const column = new Date('2027-03-14T00:00:00Z');
    expect(asISODate(column)).toBe('2027-03-14');
    expect(isoLA(column)).toBe('2027-03-13');
  });

  it('reads the string form the other driver returns', () => {
    expect(asISODate('2027-03-14')).toBe('2027-03-14');
    expect(asISODate('2027-03-14T00:00:00.000Z')).toBe('2027-03-14');
  });

  it('reads a timestamptz column without shifting the day', () => {
    // An `at` column at UTC midnight on a leap day.
    expect(asISODate(new Date('2028-02-29T00:00:00Z'))).toBe('2028-02-29');
  });

  it('answers null for nothing, rather than today', () => {
    expect(asISODate(null)).toBeNull();
    expect(asISODate(undefined)).toBeNull();
    expect(asISODate('')).toBeNull();
    expect(asISODate('2027-03')).toBeNull();
  });
});

describe('parseISODate refuses rather than guessing', () => {
  it('throws on anything that is not a plain ISO date', () => {
    for (const bad of ['', '2027-3-14', '14/03/2027', 'Thu Jul 16', '2027-03-14T00:00:00Z']) {
      expect(() => parseISODate(bad), bad).toThrow(/not an ISO date/);
    }
  });

  it('accepts surrounding whitespace, which is what a form field sends', () => {
    expect(parseISODate('  2027-03-14 ')).toEqual({ y: 2027, m: 3, d: 14 });
  });
});
