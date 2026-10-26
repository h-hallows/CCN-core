import { describe, expect, it } from 'vitest';
import { addBusinessDays, caHolidaysForYear, isBusinessDay, writtenStatementDueOn } from '../src/domain/businessDays';
import { formatISODate, parseISODate } from '../src/domain/dates';

const plus = (iso: string, n: number) => formatISODate(addBusinessDays(parseISODate(iso), n));

describe('§ 7.2 business days', () => {
  it('Sat 24 Oct 2026 + 3 -> Wed 28 Oct 2026', () => {
    expect(plus('2026-10-24', 3)).toBe('2026-10-28');
  });
  it('Fri 23 Oct 2026 + 3 -> Wed 28 Oct 2026', () => {
    expect(plus('2026-10-23', 3)).toBe('2026-10-28');
  });
  it('Mon 26 Oct 2026 + 3 -> Thu 29 Oct 2026', () => {
    expect(plus('2026-10-26', 3)).toBe('2026-10-29');
  });
  it('Tue 24 Nov 2026 + 3 -> Tue 01 Dec 2026, skipping Thanksgiving and the day after', () => {
    expect(plus('2026-11-24', 3)).toBe('2026-12-01');
  });
});

describe('observed holidays', () => {
  it('observes Independence Day 2026 on Friday 3 July', () => {
    expect(caHolidaysForYear(2026)).toContain('2026-07-03');
    expect(isBusinessDay(parseISODate('2026-07-03'))).toBe(false);
  });
  it('includes Cesar Chavez Day', () => {
    expect(caHolidaysForYear(2027)).toContain('2027-03-31');
  });
  it('includes the day after Thanksgiving', () => {
    expect(caHolidaysForYear(2026)).toContain('2026-11-27');
  });
  it('covers at least three years forward without a hand-maintained table', () => {
    for (const y of [2026, 2027, 2028, 2029]) {
      expect(caHolidaysForYear(y)).toHaveLength(11);
    }
  });
});

describe('written statement deadline', () => {
  it('is three business days after the disclosure', () => {
    expect(writtenStatementDueOn('2026-10-24')).toBe('2026-10-28');
  });
  it('does not count the disclosure day itself', () => {
    expect(writtenStatementDueOn('2026-12-24')).toBe('2026-12-30');
  });
});
