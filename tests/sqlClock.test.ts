/**
 * No calendar date comes from the server clock — checked over this package, and over
 * the migrations, which are where most of the SQL in this system actually lives.
 *
 * The rule and the reasoning are in `src/testing/sqlClock.ts`. What is here is the proof
 * that the rule can tell the two spellings apart, because a rule that refused the
 * correct form too would be removed within a week by whoever hit it first.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CIVIL_TZ, CLOCK_RULES, clockReport, clockViolations,
} from '../src/testing/sqlClock';

const ROOT = join(import.meta.dirname, '..');

function files(dir: string, match: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files(path, match, out);
    else if (match.test(entry)) out.push(path);
  }
  return out;
}

function read(paths: string[]): { path: string; text: string }[] {
  return paths.map((p) => ({ path: p.replace(ROOT, ''), text: readFileSync(p, 'utf8') }));
}

describe('the rule knows the right spelling from the wrong one', () => {
  const check = (sql: string) =>
    clockViolations([{ path: 'x.ts', text: sql }]);

  it('passes the one permitted way to ask what day it is', () => {
    expect(check(`SELECT (now() AT TIME ZONE '${CIVIL_TZ}')::date AS d`)).toEqual([]);
    expect(check(
      `SELECT date_trunc('month', (now() AT TIME ZONE '${CIVIL_TZ}')::date)::date`,
    )).toEqual([]);
  });

  it('passes now() used as an instant, which is the same instant everywhere', () => {
    for (const sql of [
      `WHERE s.expires_at > now()`,
      `SET handled_at = now(), handled_by = $2`,
      `VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
      `WHERE at > now() - ($3 || ' seconds')::interval`,
      `COALESCE($4::timestamptz, now())`,
    ]) {
      expect(check(sql), sql).toEqual([]);
    }
  });

  it('refuses every shorter way of asking the same question', () => {
    for (const sql of [
      `WHERE on_date >= current_date`,
      `SELECT CURRENT_DATE`,
      `SELECT now()::date`,
      `SELECT now() :: DATE`,
      `SELECT current_timestamp`,
      `SELECT localtimestamp`,
      `SELECT date_trunc('month', now())`,
      `SELECT now()::timestamp`,
    ]) {
      expect(check(sql).length, sql).toBe(1);
    }
  });

  it('does not refuse a timestamptz cast, which keeps its zone', () => {
    expect(check(`SELECT $1::timestamptz`)).toEqual([]);
    expect(check(`COALESCE($11::timestamptz, now())`)).toEqual([]);
  });

  it('ignores the comment that explains the rule', () => {
    /*
     * This file and `measure.ts` both discuss `current_date` in prose, and a rule that
     * tripped on its own explanation would be deleted rather than obeyed. Three comment
     * forms, because these files carry all three — and the SQL one lives inside a
     * template literal, where a JavaScript comment stripper would not look.
     */
    expect(check(`-- current_date is the server's, which is UTC\nSELECT 1`)).toEqual([]);
    expect(check(`// current_date would be wrong here\nSELECT 1`)).toEqual([]);
    expect(check(`/* current_date */ SELECT 1`)).toEqual([]);
    expect(check(` * current_date on a managed Postgres is UTC`)).toEqual([]);
  });

  it('still sees code on a line that follows a comment', () => {
    // The stripper blanks comment LINES, not everything after a comment opens.
    expect(check(`-- explanation\nSELECT current_date`)).toHaveLength(1);
  });

  it('points at the line, and says what to write instead', () => {
    const [found] = check(`SELECT 1\nSELECT 2\nWHERE d >= current_date`);
    expect(found!.line).toBe(3);
    expect(found!.instead).toContain(CIVIL_TZ);
    expect(clockReport([found!])).toContain('x.ts:3');
    expect(clockReport([])).toBe('');
  });

  it('has a rule for every spelling it claims to cover', () => {
    // Sabotage guard: an empty rule list would make every assertion above vacuous.
    expect(CLOCK_RULES.length).toBeGreaterThanOrEqual(6);
    for (const rule of CLOCK_RULES) {
      expect(rule.instead.length, String(rule.pattern)).toBeGreaterThan(10);
    }
  });
});

describe('this package asks California, everywhere', () => {
  it('finds files to check, so a silent empty sweep cannot pass', () => {
    expect(files(join(ROOT, 'src'), /\.(ts|mjs)$/).length).toBeGreaterThan(20);
    expect(files(join(ROOT, 'migrations'), /\.sql$/).length).toBeGreaterThan(20);
  });

  it('has no server-clock date in src', () => {
    const found = clockViolations(read(files(join(ROOT, 'src'), /\.(ts|mjs)$/)));
    expect(found, clockReport(found)).toEqual([]);
  });

  it('has no server-clock date in the migrations', () => {
    /*
     * Where most of the SQL in this system lives: triggers, constraint functions and
     * the policies RLS evaluates. A date decided wrongly in a trigger is decided wrongly
     * for every caller at once, including the ones that got it right themselves.
     */
    const found = clockViolations(read(files(join(ROOT, 'migrations'), /\.sql$/)));
    expect(found, clockReport(found)).toEqual([]);
  });
});
