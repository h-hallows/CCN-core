/**
 * Published rate bands — Civil Code § 1812.533(b)(1).
 *
 * `rate_ranges` was written by the seed and by nothing else, which made the bands on the
 * public pricing page demonstration data that no screen could correct. That is a
 * different failure from the two registers found empty this month and in one way a worse
 * one: an empty table says nothing, and this table has been saying something, in public,
 * in the registry's name.
 *
 * What is asserted here is the shape of the record — who said it, when it took effect,
 * and that nothing can be quietly changed afterwards — plus the judgement the console
 * puts in front of an operator before they publish a number.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '../src/db/client';
import { seededDb, expectRejection } from '../src/testing/db';
import {
  BANDED_SERVICES, BANDED_SERVICES_SQL_ARRAY, CREDENTIAL_LEVELS,
  CREDENTIAL_LEVEL_LABEL, RATE_BAND_INSERT, bandIsPostable, bandNotes,
  isBandedService, isCredentialLevel, levelOfProviderType,
  type ObservedRates, type RateBand,
} from '../src/domain/rates';

let db: DbHandle;

beforeAll(async () => { db = await seededDb(); });

const band = (over: Partial<RateBand> = {}): RateBand => ({
  serviceKey: 'personal_care',
  level: 'cna',
  low: 40,
  high: 55,
  ...over,
});

const observed = (over: Partial<ObservedRates> = {}): ObservedRates => ({
  level: 'cna', count: 6, low: 38, high: 58, median: 45, ...over,
});

function insert(over: Partial<{
  service: string; level: string; low: number; high: number;
  from: string; note: string | null; by: string;
}> = {}) {
  return db.query<{ id: string }>(RATE_BAND_INSERT, [
    over.service ?? 'respite',
    over.level ?? 'hca',
    over.low ?? 30,
    over.high ?? 45,
    over.from ?? `20${20 + Math.floor(Math.random() * 60)}-0${1 + Math.floor(Math.random() * 9)}-15`,
    over.note === undefined ? 'test band' : over.note,
    over.by ?? 'operator@example.com',
  ]);
}


describe('one vocabulary, three places', () => {
  it('bands the same services the care enum knows', async () => {
    const rows = await db.query<{ v: string }>(
      `SELECT unnest(enum_range(NULL::care_type))::text AS v`);
    expect(rows.map((r) => r.v).sort()).toEqual([...BANDED_SERVICES].sort());
  });

  it('writes the same list into the constraint', async () => {
    /*
     * The CHECK spells the seven out because a CHECK must be immutable and `enum_range`
     * is only stable. Two copies of one fact, so they are compared.
     */
    const [row] = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'rate_ranges_service_vocabulary'`);
    expect(row, 'the constraint is gone').toBeDefined();
    const inCheck = [...row!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!).sort();
    expect(inCheck).toEqual([...BANDED_SERVICES].sort());
  });

  it('quotes bands at the levels the constraint allows', async () => {
    const [row] = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'rate_ranges'::regclass
          AND pg_get_constraintdef(oid) LIKE '%credential_level%'`);
    expect(row).toBeDefined();
    const inCheck = [...row!.def.matchAll(/'([a-z]+)'::text/g)].map((m) => m[1]!).sort();
    expect(inCheck).toEqual([...CREDENTIAL_LEVELS].sort());
  });

  it('maps every provider type on the roster to a band label', async () => {
    /*
     * The one place the roster's vocabulary and the page's meet. A provider type added
     * later with no mapping shows up as unobserved rather than joining the wrong band,
     * and this is what would notice.
     */
    const rows = await db.query<{ v: string }>(
      `SELECT unnest(enum_range(NULL::provider_type))::text AS v`);

    const mapped = rows.map(({ v }) => {
      const level = levelOfProviderType(v);
      expect(level, `${v} has no band label`).not.toBeNull();
      // Named, not merely non-null. The first version of this assertion asked only that
      // something came back, and a mapping that sent every provider type to 'companion'
      // passed it — which would have quoted a registered nurse's band against the
      // companion roster, on a public page.
      expect(level, `${v} maps to ${level}`).toBe(v.toLowerCase());
      return level;
    });
    expect(new Set(mapped).size, 'two provider types share a band label').toBe(rows.length);
    expect(levelOfProviderType('physician')).toBeNull();
  });

  it('labels every level it will show', () => {
    for (const level of CREDENTIAL_LEVELS) {
      expect(CREDENTIAL_LEVEL_LABEL[level].length).toBeGreaterThan(5);
    }
    expect(isCredentialLevel('rn')).toBe(true);
    expect(isCredentialLevel('RN')).toBe(false);
    expect(isBandedService('respite')).toBe(true);
    expect(isBandedService('dog_walking')).toBe(false);
  });

  it('builds the SQL array from the same list', () => {
    for (const s of BANDED_SERVICES) expect(BANDED_SERVICES_SQL_ARRAY).toContain(`'${s}'`);
    expect(BANDED_SERVICES_SQL_ARRAY).toMatch(/::text\[\]$/);
  });
});


describe('what the table refuses', () => {
  it('refuses a band with no author', async () => {
    await expectRejection(() => insert({ by: '   ' }), /posted_by_named/);
  });

  it('refuses a service no page will ever read', async () => {
    await expectRejection(
      () => insert({ service: 'dog_walking' }), /service_vocabulary/);
  });

  it('refuses a band that is inside out', async () => {
    await expectRejection(
      () => insert({ low: 60, high: 40 }), /rate_range_ordered/);
  });

  it('refuses two bands for the same service, level and date', async () => {
    const from = '2041-05-15';
    await insert({ service: 'respite', level: 'cna', from });
    await expectRejection(
      () => insert({ service: 'respite', level: 'cna', from }),
      /duplicate key|unique/i,
    );
  });

  it('accepts a band dated ahead, which is how a planned change is posted', async () => {
    const [row] = await insert({ service: 'companion', level: 'companion', from: '2044-01-01' });
    expect(row!.id).toBeTruthy();
  });
});


describe('posted and superseded, never amended', () => {
  it('refuses an edit', async () => {
    const [row] = await insert({ service: 'post_surgical', level: 'lvn', from: '2042-02-02' });
    await expectRejection(
      () => db.query(`UPDATE rate_ranges SET high = 999 WHERE id = $1`, [row!.id]),
      /append-only/,
    );
  });

  it('refuses a delete', async () => {
    const [row] = await insert({ service: 'post_surgical', level: 'rn', from: '2042-03-03' });
    await expectRejection(
      () => db.query(`DELETE FROM rate_ranges WHERE id = $1`, [row!.id]),
      /append-only/,
    );
  });

  it('supersedes by date instead', async () => {
    const service = 'hospice_support';
    await insert({ service, level: 'rn', low: 88, high: 128, from: '2043-01-01' });
    await insert({ service, level: 'rn', low: 95, high: 135, from: '2043-06-01' });

    const [newest] = await db.query<{ low: string; high: string }>(
      `SELECT low::text, high::text FROM rate_ranges
        WHERE service_key = $1 AND credential_level = 'rn'
          AND effective_from <= '2043-07-01'::date
        ORDER BY effective_from DESC LIMIT 1`, [service]);
    expect(Number(newest!.low)).toBe(95);

    // And the one it replaced is still there, which is what answers "what did the page
    // say in March" after somebody asks.
    const [older] = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM rate_ranges
        WHERE service_key = $1 AND credential_level = 'rn'`, [service]);
    expect(Number(older!.n)).toBeGreaterThanOrEqual(2);
  });
});


describe('the seeded bands say what they are', () => {
  it('names the fixture as their author, not an operator', async () => {
    /*
     * The public pricing page has been serving these. A seeded band claiming an
     * operator posted it would make the page look maintained when it is demonstration
     * data — which is the exact shape of the problem this work exists to fix.
     */
    const rows = await db.query<{ posted_by: string }>(
      `SELECT DISTINCT posted_by FROM rate_ranges WHERE note LIKE 'Provider-set%'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.posted_by).toBe('seed');
  });

  it('quotes every seeded band for a service the vocabulary knows', async () => {
    const rows = await db.query<{ service_key: string; credential_level: string }>(
      `SELECT service_key, credential_level FROM rate_ranges`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(isBandedService(r.service_key), r.service_key).toBe(true);
      expect(isCredentialLevel(r.credential_level), r.credential_level).toBe(true);
    }
  });
});


describe('what the operator is told before they publish', () => {
  it('blocks only the band that cannot be true', () => {
    const notes = bandNotes(band({ low: 60, high: 40 }), observed());
    expect(notes).toHaveLength(1);
    expect(notes[0]!.concern).toBe('inside_out');
    expect(bandIsPostable(notes)).toBe(false);
  });

  it('says nothing about a band the roster supports', () => {
    expect(bandNotes(band({ low: 40, high: 55 }), observed())).toEqual([]);
  });

  it('warns, without blocking, when nobody is at that level', () => {
    const notes = bandNotes(band(), observed({ count: 0, low: null, high: null }));
    expect(notes[0]!.concern).toBe('nobody_at_this_level');
    expect(bandIsPostable(notes)).toBe(true);
    // The sentence has to be worth reading at the moment somebody is about to publish.
    expect(notes[0]!.message).toMatch(/before a service launches and misleading after/);
  });

  it('distinguishes nobody at all from nobody with a rate on file', () => {
    const notes = bandNotes(band(), observed({ count: 4, low: null, high: null }));
    expect(notes[0]!.concern).toBe('no_rates_on_file');
    expect(notes[0]!.message).toMatch(/Record their stated rates/);
  });

  it('warns when the band and the roster describe different money', () => {
    const below = bandNotes(band({ low: 10, high: 20 }), observed({ low: 38, high: 58 }));
    expect(below[0]!.concern).toBe('outside_observed');
    const above = bandNotes(band({ low: 90, high: 120 }), observed({ low: 38, high: 58 }));
    expect(above[0]!.concern).toBe('outside_observed');
    // Both are said rather than refused, and the message says why it is a question.
    expect(bandIsPostable(above)).toBe(true);
    expect(above[0]!.message).toMatch(/not what they charge for this service/);
    expect(above[0]!.message).toMatch(/1812\.533\(b\)\(1\)/);
  });

  it('does not call an overlapping band wrong', () => {
    // Touching at one end is overlapping. A band from 58 to 70 against a roster of
    // 38–58 is a stretch, not a contradiction, and the file does not pretend otherwise.
    expect(bandNotes(band({ low: 58, high: 70 }), observed({ low: 38, high: 58 })))
      .toEqual([]);
  });

  it('notices a band wide enough to contain any answer', () => {
    const notes = bandNotes(band({ low: 20, high: 200 }), observed({ low: 38, high: 58 }));
    expect(notes[0]!.concern).toBe('wider_than_observed');
    expect(bandIsPostable(notes)).toBe(true);
    expect(notes[0]!.message).toMatch(/a household reading it learns nothing/);
  });

  it('does not nag about a band only a little wider than the roster', () => {
    expect(bandNotes(band({ low: 35, high: 62 }), observed({ low: 38, high: 58 })))
      .toEqual([]);
  });
});


describe('the bands are an audited entity', () => {
  it('the audit vocabulary admits them', async () => {
    const rows = await db.query(
      `INSERT INTO audit_log (actor, action, entity) VALUES ('test','read','rate_band')
       RETURNING id`);
    expect(rows).toHaveLength(1);
  });
});
