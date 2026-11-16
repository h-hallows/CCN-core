/**
 * The advertising record — Civil Code § 1812.533(c).
 *
 * "Every nurses' registry shall maintain a record of all advertisements, correlated to
 * show the date and the publication in which the advertisement appeared, retrospectively
 * for a period of one year."
 *
 * `advertising_log` existed from migration 0004 and nothing ever wrote to it — the
 * second table found in that state in this schema, three weeks after the assignment log.
 * It was also the wrong shape, which the assignment log was not: a single `published_on`
 * date cannot say what a website said in March, and a website is the only publication
 * this registry has.
 *
 * Most of what follows is about the two ways a permanent record goes wrong. It can say
 * something untrue, which the checks and the triggers refuse on the way in; or it can be
 * silently incomplete, which nothing can refuse, and which the coverage analysis
 * surfaces without ever calling it a violation — because the record cannot know about an
 * advertisement nobody told it about.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DbHandle } from '../src/db/client';
import { seededDb, expectRejection } from '../src/testing/db';
import {
  AD_MEDIA, AD_MEDIA_KEYS, ADVERTISING_LOG_CLOSE, ADVERTISING_LOG_CORRECTION,
  ADVERTISING_LOG_INSERT, ADVERTISING_WINDOW_DAYS, CONTINUOUS_MEDIA_SQL_ARRAY,
  PLACEHOLDER_MARKERS, advertisingCoverage, contactLineProblem, isAdMedium, isContinuous,
  type AdMedium, type AdRun,
} from '../src/domain/advertising';

const ROOT = join(import.meta.dirname, '..');
const MIGRATIONS = join(ROOT, 'migrations');

let db: DbHandle;

beforeAll(async () => { db = await seededDb(); });

/** A valid entry, so each test varies one thing and the rest stays lawful. */
function entry(over: Partial<{
  medium: string; publication: string; from: string; to: string | null;
  reference: string | null; name: string; contact: string;
}> = {}) {
  return [
    over.medium ?? 'website',
    over.publication ?? `test-${Math.random().toString(36).slice(2, 10)}.example`,
    over.from ?? '2026-03-01',
    over.to === undefined ? '2026-03-31' : over.to,
    over.reference ?? null,
    null,
    over.name ?? 'CCN',
    over.contact ?? '(310) 555-0147',
    null,
    'test',
    null,
  ];
}


describe('the seeded record', () => {
  it('holds entries, and every one of them says what it carried', async () => {
    const rows = await db.query<{
      medium: string; publication: string; appeared_from: string;
      carried_name: string; carried_contact: string;
    }>(`SELECT medium::text, publication, appeared_from::text, carried_name, carried_contact
          FROM advertising_log ORDER BY appeared_from`);

    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(isAdMedium(r.medium), `${r.medium} is not in the vocabulary`).toBe(true);
      expect(r.publication.trim()).not.toBe('');
      // § 1812.533(b)(2), which is the reason these two columns exist at all.
      expect(contactLineProblem(r.carried_name, r.carried_contact)).toBeNull();
    }
  });

  it('carries no name that could be mistaken for one somebody filed', async () => {
    /*
     * The seed invents a business, as it does everywhere else. This is the one invented
     * value that could be believed — `lib/brand.ts` refuses to produce a plausible
     * trading name for exactly this reason — so the seeded name is the repository's own
     * three letters and the number is in the range reserved for fiction.
     */
    const rows = await db.query<{ carried_name: string; carried_contact: string }>(
      `SELECT DISTINCT carried_name, carried_contact FROM advertising_log`);
    for (const r of rows) {
      expect(r.carried_name).toBe('CCN');
      expect(r.carried_contact, 'a seeded number must be unreachable').toMatch(/555-01\d\d/);
    }
  });

  it('has a website that was replaced, not one that has run since the beginning', async () => {
    const rows = await db.query<{ appeared_to: string | null }>(
      `SELECT appeared_to::text FROM advertising_log
        WHERE medium = 'website' ORDER BY appeared_from`);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]!.appeared_to, 'the retired site must be closed').not.toBeNull();
    expect(rows[rows.length - 1]!.appeared_to, 'the current site is still running').toBeNull();
  });
});


describe('the vocabulary is one list', () => {
  it('matches the enum in the database exactly', async () => {
    const rows = await db.query<{ v: string }>(
      `SELECT unnest(enum_range(NULL::ad_medium))::text AS v`);
    expect(rows.map((r) => r.v).sort()).toEqual([...AD_MEDIA_KEYS].sort());
  });

  it('splits continuous from dated the same way the table does', async () => {
    /*
     * The CHECK naming the continuous media and `AD_MEDIA[*].continuous` are two copies
     * of one fact. If they part company, a print advertisement becomes leavable open —
     * an entry claiming it is still appearing in an issue from February.
     */
    const [row] = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'advertising_log_dated_media_close'`);
    expect(row, 'the constraint is gone').toBeDefined();

    const inCheck = [...row!.def.matchAll(/'([a-z_]+)'::ad_medium/g)].map((m) => m[1]!).sort();
    const continuous = AD_MEDIA_KEYS.filter(isContinuous).sort();
    expect(inCheck).toEqual([...continuous]);
  });

  it('builds the SQL array from the same list', () => {
    for (const m of AD_MEDIA_KEYS) {
      expect(CONTINUOUS_MEDIA_SQL_ARRAY.includes(`'${m}'`)).toBe(isContinuous(m));
    }
    expect(CONTINUOUS_MEDIA_SQL_ARRAY).toMatch(/::ad_medium\[\]$/);
  });

  it('describes every medium well enough to choose between them', () => {
    for (const [key, def] of Object.entries(AD_MEDIA)) {
      expect(def.label.length, `${key} has no label`).toBeGreaterThan(3);
      expect(def.note.length, `${key} is unexplained`).toBeGreaterThan(60);
    }
  });
});


describe('what an entry may not say', () => {
  it('refuses an advertisement that stopped before it started', async () => {
    await expectRejection(
      () => db.query(ADVERTISING_LOG_INSERT, entry({ from: '2026-03-31', to: '2026-03-01' })),
      /advertising_log_interval/,
    );
  });

  it('refuses a dated advertisement left open', async () => {
    await expectRejection(
      () => db.query(ADVERTISING_LOG_INSERT, entry({ medium: 'print', to: null })),
      /advertising_log_dated_media_close/,
    );
  });

  it('refuses a dated advertisement spanning days', async () => {
    await expectRejection(
      () => db.query(ADVERTISING_LOG_INSERT,
        entry({ medium: 'print', from: '2026-03-01', to: '2026-03-02' })),
      /advertising_log_dated_media_close/,
    );
  });

  it('accepts a continuous advertisement either open or closed', async () => {
    const [open] = await db.query<{ id: string }>(
      ADVERTISING_LOG_INSERT, entry({ to: null }));
    const [closed] = await db.query<{ id: string }>(ADVERTISING_LOG_INSERT, entry());
    expect(open!.id).toBeTruthy();
    expect(closed!.id).toBeTruthy();
  });

  it('refuses an entry with no name, and one with no contact', async () => {
    await expectRejection(
      () => db.query(ADVERTISING_LOG_INSERT, entry({ name: '   ' })),
      /advertising_log_contact_line/,
    );
    await expectRejection(
      () => db.query(ADVERTISING_LOG_INSERT, entry({ contact: '' })),
      /advertising_log_contact_line/,
    );
  });

  it('refuses the two values this deployment actually serves today', async () => {
    /*
     * The point of the check, rather than a corner of it. The trading name is with
     * counsel under HSC § 1726(b), 22 CCR § 74600(b) and § 1812.533(b)(4), so the public
     * site serves PENDING_LEGAL_NAME and the prose "Telephone pending". Neither is a
     * correct name or a correct telephone number, so an advertisement carrying them
     * breaches § 1812.533(b)(2) on its face — and the record refuses to describe it.
     * Since the record is mandatory, an advertisement that cannot be recorded is one
     * that cannot lawfully run.
     */
    await expectRejection(
      () => db.query(ADVERTISING_LOG_INSERT, entry({ name: 'PENDING_LEGAL_NAME' })),
      /advertising_log_contact_line/,
    );
    await expectRejection(
      () => db.query(ADVERTISING_LOG_INSERT, entry({ contact: 'Telephone pending' })),
      /advertising_log_contact_line/,
    );
  });

  it('refuses two concurrent advertisements of the same publication', async () => {
    const where = 'one-site.example';
    await db.query(ADVERTISING_LOG_INSERT, entry({ publication: where, to: null }));
    await expectRejection(
      () => db.query(ADVERTISING_LOG_INSERT, entry({ publication: where, to: null })),
      /advertising_log_one_open_per_publication/,
    );
  });

  it('permits the same publication again once the first entry is closed', async () => {
    const where = 'sequential.example';
    const [first] = await db.query<{ id: string }>(
      ADVERTISING_LOG_INSERT, entry({ publication: where, to: null }));
    await db.query(ADVERTISING_LOG_CLOSE, [first!.id, '2026-04-30']);
    const [second] = await db.query<{ id: string }>(
      ADVERTISING_LOG_INSERT, entry({ publication: where, from: '2026-05-01', to: null }));
    expect(second!.id).toBeTruthy();
  });
});


describe('append-only, with one exception', () => {
  async function open(publication: string): Promise<string> {
    const [row] = await db.query<{ id: string }>(
      ADVERTISING_LOG_INSERT, entry({ publication, to: null }));
    return row!.id;
  }

  it('lets an open entry be closed, once', async () => {
    const id = await open('closeable.example');
    const closed = await db.query<{ id: string }>(ADVERTISING_LOG_CLOSE, [id, '2026-06-30']);
    expect(closed).toHaveLength(1);

    // A second close matches nothing rather than overwriting the day it came down.
    const again = await db.query(ADVERTISING_LOG_CLOSE, [id, '2026-07-31']);
    expect(again).toHaveLength(0);

    const [row] = await db.query<{ appeared_to: string }>(
      `SELECT appeared_to::text FROM advertising_log WHERE id = $1`, [id]);
    expect(row!.appeared_to).toBe('2026-06-30');
  });

  it('refuses to reopen a closed entry', async () => {
    const id = await open('reopen.example');
    await db.query(ADVERTISING_LOG_CLOSE, [id, '2026-06-30']);
    await expectRejection(
      () => db.query(`UPDATE advertising_log SET appeared_to = NULL WHERE id = $1`, [id]),
      /append-only/,
    );
  });

  it('refuses every other change, including one made alongside a close', async () => {
    const id = await open('immutable.example');
    for (const sql of [
      `UPDATE advertising_log SET publication = 'somewhere-else.example' WHERE id = $1`,
      `UPDATE advertising_log SET carried_name = 'Something Filed' WHERE id = $1`,
      `UPDATE advertising_log SET appeared_from = '2020-01-01' WHERE id = $1`,
      `UPDATE advertising_log SET medium = 'print', appeared_to = appeared_from WHERE id = $1`,
      // The one that matters most: a close is permitted, so a close carrying a second
      // change is the shape somebody would reach for.
      `UPDATE advertising_log SET appeared_to = '2026-06-30',
              carried_contact = '(310) 555-0100' WHERE id = $1`,
    ]) {
      await expectRejection(() => db.query(sql, [id]), /append-only/);
    }
  });

  it('refuses a delete, and says why', async () => {
    const id = await open('permanent.example');
    const message = await expectRejection(
      () => db.query(`DELETE FROM advertising_log WHERE id = $1`, [id]),
      /append-only/,
    );
    // The reason is in the message because the misreading is so natural: one year is
    // how far back the record must REACH, not how long a row is kept.
    expect(message).toMatch(/1812\.533\(c\)/);
    expect(message).toMatch(/floor and not a retention schedule/);
  });

  it('is deleted from nowhere in this package', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(ts|mjs)$/.test(name)) continue;
        const code = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        if (/DELETE\s+FROM\s+advertising_log/i.test(code)) offenders.push(full.replace(ROOT, ''));
      }
    };
    walk(join(ROOT, 'src'));
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});


describe('corrections', () => {
  async function corrigible(): Promise<string> {
    const [row] = await db.query<{ id: string }>(
      ADVERTISING_LOG_INSERT, entry({ publication: `fix-${Date.now()}-${Math.random()}.example` }));
    return row!.id;
  }

  it('supersedes rather than edits, keeping the publication it names', async () => {
    const id = await corrigible();
    const [fix] = await db.query<{ id: string }>(ADVERTISING_LOG_CORRECTION, [
      id, '2026-03-02', '2026-03-31', 'corrected reference', null,
      'CCN', '(310) 555-0147', 'test', 'the start date was a day early',
    ]);
    const [row] = await db.query<{
      publication: string; medium: string; corrects_id: string; correction_note: string;
      appeared_from: string;
    }>(`SELECT publication, medium::text, corrects_id, correction_note, appeared_from::text
          FROM advertising_log WHERE id = $1`, [fix!.id]);

    const [original] = await db.query<{ publication: string; appeared_from: string }>(
      `SELECT publication, appeared_from::text FROM advertising_log WHERE id = $1`, [id]);

    expect(row!.corrects_id).toBe(id);
    expect(row!.publication).toBe(original!.publication);
    expect(row!.appeared_from).toBe('2026-03-02');
    // The original stays legible and unchanged. That is the whole point of a register.
    expect(original!.appeared_from).toBe('2026-03-01');
  });

  it('refuses a correction with nothing said about what was wrong', async () => {
    const id = await corrigible();
    await expectRejection(
      () => db.query(ADVERTISING_LOG_CORRECTION, [
        id, '2026-03-02', '2026-03-31', null, null, 'CCN', '(310) 555-0147', 'test', '  ',
      ]),
      /advertising_log_correction_note/,
    );
  });

  it('does not let a correction escape the checks the original passed', async () => {
    const id = await corrigible();
    await expectRejection(
      () => db.query(ADVERTISING_LOG_CORRECTION, [
        id, '2026-03-02', '2026-03-31', null, null, 'PENDING_LEGAL_NAME', '(310) 555-0147',
        'test', 'the name was wrong',
      ]),
      /advertising_log_contact_line/,
    );
  });
});


describe('the § 1812.533(b)(2) contact line, in TypeScript', () => {
  it('passes a name and a number somebody could use', () => {
    expect(contactLineProblem('Example Nursing Registry LLC', '(310) 555-0147')).toBeNull();
    expect(contactLineProblem('CCN', '1 Example Plaza, Los Angeles CA')).toBeNull();
  });

  it('names which half is missing, because the operator has to fix one of them', () => {
    expect(contactLineProblem('', '(310) 555-0147')).toMatch(/correct name/);
    expect(contactLineProblem('CCN', '   ')).toMatch(/street address|telephone number/);
  });

  it('catches every placeholder it claims to', () => {
    for (const marker of PLACEHOLDER_MARKERS) {
      expect(contactLineProblem(`${marker}_NAME`, '(310) 555-0147'), marker).not.toBeNull();
      expect(contactLineProblem('CCN', `contact ${marker.toLowerCase()}`), marker).not.toBeNull();
    }
  });

  it('is wider than the database check, and agrees with it where they overlap', () => {
    // The sentinel and the prose form. The SQL catches both too; this one explains.
    expect(contactLineProblem('PENDING_LEGAL_NAME', 'x')).toMatch(/placeholder/);
    expect(contactLineProblem('CCN', 'Telephone pending')).toMatch(/placeholder/);
  });
});


describe('the trailing year', () => {
  const run = (from: string, to: string | null): AdRun => ({ from, to });

  it('reports nothing recorded as empty, not as covered', () => {
    const c = advertisingCoverage([], '2026-11-16');
    expect(c.empty).toBe(true);
    expect(c.uncoveredDays).toBe(0);
    expect(c.coveredDays).toBe(0);
  });

  it('counts both ends of a run, so one day of print covers one day', () => {
    const c = advertisingCoverage([run('2026-11-16', '2026-11-16')], '2026-11-16');
    expect(c.coveredDays).toBe(1);
    expect(c.uncoveredDays).toBe(0);
  });

  it('treats an open run as running up to today', () => {
    const c = advertisingCoverage([run('2026-11-10', null)], '2026-11-16');
    expect(c.windowFrom).toBe('2026-11-10');
    expect(c.coveredDays).toBe(7);
    expect(c.stretches).toEqual([]);
  });

  it('finds the hole between two runs, and sizes it', () => {
    const c = advertisingCoverage(
      [run('2026-11-01', '2026-11-05'), run('2026-11-11', null)], '2026-11-16');
    expect(c.stretches).toEqual([{ from: '2026-11-06', to: '2026-11-10', days: 5 }]);
    expect(c.uncoveredDays).toBe(5);
    expect(c.coveredDays).toBe(11);
  });

  it('leaves no hole between runs that merely touch', () => {
    const c = advertisingCoverage(
      [run('2026-11-01', '2026-11-05'), run('2026-11-06', null)], '2026-11-16');
    expect(c.stretches).toEqual([]);
    expect(c.coveredDays).toBe(16);
  });

  it('does not count a day twice when two runs overlap', () => {
    const c = advertisingCoverage(
      [run('2026-11-01', '2026-11-10'), run('2026-11-05', null)], '2026-11-16');
    expect(c.coveredDays).toBe(16);
    expect(c.uncoveredDays).toBe(0);
  });

  it('notices when the record stops before today', () => {
    const c = advertisingCoverage([run('2026-11-01', '2026-11-10')], '2026-11-16');
    expect(c.stretches).toEqual([{ from: '2026-11-11', to: '2026-11-16', days: 6 }]);
  });

  it('anchors the window on the record rather than reporting a year of nothing', () => {
    /*
     * A registry that wrote its first entry last week has not failed to advertise for
     * the preceding year. Reporting 366 uncovered days on the day somebody starts using
     * the screen is the kind of noise that teaches an operator to ignore it.
     */
    const c = advertisingCoverage([run('2026-11-10', null)], '2026-11-16');
    expect(c.startsInsideWindow).toBe(true);
    expect(c.windowFrom).toBe('2026-11-10');
    expect(c.uncoveredDays).toBe(0);
  });

  it('reaches no further back than the year the section asks for', () => {
    const c = advertisingCoverage([run('2020-01-01', null)], '2026-11-16');
    expect(c.startsInsideWindow).toBe(false);
    expect(c.windowFrom).toBe('2025-11-16');
    expect(c.coveredDays).toBe(ADVERTISING_WINDOW_DAYS);
  });

  it('refuses to let an impossible run manufacture coverage', () => {
    // The database rejects `appeared_to < appeared_from`. If one ever arrives here it is
    // dropped, never inverted into a run that silently covers the days between.
    const c = advertisingCoverage([run('2026-11-16', '2026-11-01')], '2026-11-16');
    expect(c.empty).toBe(true);
  });

  it('finds the hole the seed leaves between the two websites', async () => {
    const rows = await db.query<{ appeared_from: string; appeared_to: string | null }>(
      `SELECT appeared_from::text, appeared_to::text FROM advertising_log
        WHERE corrects_id IS NULL AND recorded_by = 'operator'`);
    const [today] = await db.query<{ d: string }>(
      `SELECT (now() AT TIME ZONE 'America/Los_Angeles')::date::text AS d`);

    const c = advertisingCoverage(
      rows.map((r) => ({ from: r.appeared_from, to: r.appeared_to })), today!.d);

    expect(c.empty).toBe(false);
    expect(c.stretches, 'the seed places exactly one gap').toHaveLength(1);
    // The old site came down on day -300 and the new one went up on day -290, so nine
    // days are uncovered: both endpoints are themselves covered.
    expect(c.stretches[0]!.days).toBe(9);
  });
});


describe('the record is an audited entity', () => {
  it('the audit vocabulary admits it', async () => {
    const rows = await db.query(
      `INSERT INTO audit_log (actor, action, entity) VALUES ('test','read','advertisement')
       RETURNING id`);
    expect(rows).toHaveLength(1);
  });

  it('migration 0025 widens that vocabulary without validating the history', () => {
    const sql = readFileSync(
      join(MIGRATIONS, '0025_an_advertisement_runs_over_a_period.sql'), 'utf8');
    expect(sql).toMatch(/audit_log_entity_vocabulary CHECK[\s\S]*?NOT VALID/);
  });

  it('refuses to rewrite a table that already holds entries', () => {
    /*
     * 0025 adds NOT NULL columns that cannot be defaulted without inventing the two
     * facts § 1812.533(b)(2) is about. It is only correct against an empty table, which
     * every deployment has, and it says so out loud rather than discovering it.
     */
    const sql = readFileSync(
      join(MIGRATIONS, '0025_an_advertisement_runs_over_a_period.sql'), 'utf8');
    expect(sql).toMatch(/IF EXISTS \(SELECT 1 FROM advertising_log\)/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });
});
