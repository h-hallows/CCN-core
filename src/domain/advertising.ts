/**
 * The advertising record — Civil Code § 1812.533(c). Spec § 9.4.
 *
 * WHAT THE SECTION ASKS FOR, WORD FOR WORD. "Every nurses' registry shall maintain a
 * record of all advertisements, correlated to show the date and the publication in which
 * the advertisement appeared, retrospectively for a period of one year."
 *
 * Three words in that sentence decide the shape of the table.
 *
 * ALL. Not a sample and not the paid ones. § 1812.533(b)(2) requires the registry's
 * correct name and either its street address or its telephone number in every
 * advertisement, which means the statute's own idea of an advertisement is anything that
 * could carry a name and a number — a website, a directory entry, a listing, a sign.
 *
 * CORRELATED TO SHOW THE DATE AND THE PUBLICATION. The record has to answer a question
 * asked about a day: what was advertised on the third of March, and where. That is not
 * the same as a list of things that were published, and this is where the original table
 * was wrong. `advertising_log` was created in migration 0004 with a single `published_on`
 * date, and the only publication this registry has is a website — which does not appear
 * on a date. It runs, continuously, until something replaces it. A row holding one date
 * cannot say what the site said in March, so the table as built could not answer the
 * question the section exists to ask. Migration 0024 gives an entry an interval: it
 * appeared from a date, and it appeared until a date or it is still running.
 *
 * RETROSPECTIVELY FOR A PERIOD OF ONE YEAR. A floor, not a ceiling, and not a retention
 * schedule. It does not say keep each record for a year; it says that at any moment the
 * record must reach back a year. Those read the same until someone writes a job that
 * prunes rows at 366 days, which satisfies the misreading and breaches the section the
 * first time an inspector asks about thirteen months ago. Nothing deletes from this
 * table — the trigger refuses, and `tests/advertising.test.ts` refuses a DELETE appearing
 * in source as well.
 *
 * WHAT THE RECORD CANNOT DO, STATED HERE SO NO SCREEN IMPLIES OTHERWISE. It cannot know
 * about an advertisement nobody told it about. So an uncovered day means the record says
 * nothing ran, which is either true or a gap, and only the operator knows which. It is
 * never reported as a violation. It is also the one kind of compliance problem in this
 * system with no remedy: an assignment log entry can be filed late and say so, but you
 * cannot retrospectively advertise, and a record reconstructed from memory months later
 * is the false record § 1812.533(b)(1) is about. The screen says so rather than offering
 * a button.
 */
import { addDays, daysBetween, formatISODate, parseISODate } from './dates';


/** Where an advertisement can appear, and whether appearing is an act or a state. */
export interface AdMediumDef {
  /** How the operator names it. */
  label: string;
  /**
   * True where the advertisement runs until it is withdrawn or replaced, so the entry
   * carries an interval with an open end. False where it appeared on a day and was over
   * — a page in a magazine, a radio spot, a mailing — and the interval closes on the day
   * it opened.
   */
  continuous: boolean;
  /** Why it is one or the other, and what the operator records as the publication. */
  note: string;
}

/**
 * The closed vocabulary. A medium missing from here cannot be recorded at all, which is
 * the right failure: the operator asks for it to be added and the addition is a decision
 * somebody made, rather than a free-text column that quietly becomes nine spellings of
 * "Google".
 */
export const AD_MEDIA = {
  website: {
    label: 'Website',
    continuous: true,
    note: 'A page served to the public. It advertises on every day it is up, so the '
      + 'entry runs from the day it went live until the day it changed or came down. '
      + 'The publication is the host it was served from.',
  },
  directory: {
    label: 'Directory or listing',
    continuous: true,
    note: 'A profile or listing somebody else publishes — a care directory, a chamber '
      + 'roll, a map entry. It keeps advertising after everyone has forgotten it is '
      + 'there, which is exactly why it belongs in the record.',
  },
  paid_search: {
    label: 'Paid search',
    continuous: true,
    note: 'A campaign runs across days rather than appearing on one. The publication is '
      + 'the platform; the reference is the campaign, so the creative can be produced.',
  },
  paid_social: {
    label: 'Paid social',
    continuous: true,
    note: 'As paid search. A boosted post is an advertisement on every day it is served.',
  },
  social_profile: {
    label: 'Social profile',
    continuous: true,
    note: 'An account held in the registry’s name is a standing representation of it, '
      + 'and § 1812.533(b)(2) reaches the name and contact detail on the profile.',
  },
  signage: {
    label: 'Signage or vehicle',
    continuous: true,
    note: 'A board, a window, a door, a car. It advertises for as long as it is in place.',
  },
  print: {
    label: 'Print',
    continuous: false,
    note: 'An issue dated a day. Record one entry per issue rather than one per run: '
      + 'the section asks which publication it appeared in, and two magazines are two.',
  },
  broadcast: {
    label: 'Broadcast',
    continuous: false,
    note: 'A spot aired on a date. The publication is the station or programme.',
  },
  mail: {
    label: 'Mail or email',
    continuous: false,
    note: 'A send happened on a day. The publication is the list or the audience it '
      + 'went to, because that is the part that identifies it later.',
  },
} as const satisfies Record<string, AdMediumDef>;

export type AdMedium = keyof typeof AD_MEDIA;

export const AD_MEDIA_KEYS: readonly AdMedium[] =
  Object.keys(AD_MEDIA) as AdMedium[];

export function isAdMedium(v: unknown): v is AdMedium {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(AD_MEDIA, v);
}

/** True where this medium's entries may be left open. */
export function isContinuous(medium: AdMedium): boolean {
  return AD_MEDIA[medium].continuous;
}

/**
 * The window § 1812.533(c) requires the record to cover, in days.
 *
 * A year back from today, inclusive of today, so 366 days of calendar. One day more than
 * a strict reading rather than one less: the record is required to reach back a year, and
 * being a day over costs nothing while being a day under is the breach.
 */
export const ADVERTISING_WINDOW_DAYS = 366;

/**
 * The sentinel this codebase serves while the trading name is unfiled.
 *
 * It is here, in core, rather than imported from the marketing app, because the database
 * constraint that refuses it has to be written in SQL from the same fact. Three
 * provisions block the name — HSC § 1726(b), 22 CCR § 74600(b) and § 1812.533(b)(4) —
 * and until they clear, the public site serves PENDING_LEGAL_NAME and a contact line
 * reading "Telephone pending". Neither is a correct name or a correct telephone number,
 * so an advertisement carrying them would breach § 1812.533(b)(2) on its face.
 *
 * Which gives the record a job nothing else in this system does. An entry must say what
 * name and contact the advertisement carried, and it cannot say "PENDING_". So the
 * record refuses to describe an unlawful advertisement — and since the record is
 * mandatory, an advertisement that cannot be recorded is an advertisement that cannot
 * lawfully be run. The refusal arrives at the one moment it is still cheap.
 */
export const PENDING_PREFIX = 'PENDING_';

/**
 * Markers that mean nobody has filled this in. Deliberately short and literal: a
 * heuristic that guessed at placeholders would start refusing real names, and a business
 * really can be called X Y Z Nursing.
 */
export const PLACEHOLDER_MARKERS: readonly string[] = [
  // 'PENDING' rather than the sentinel's full 'PENDING_' prefix, because the contact
  // line this deployment serves today is the prose "Telephone pending" and the
  // underscore would have waved it straight through — the one string the check was
  // written to catch. A nurses' registry whose filed name contains the word is a
  // problem somebody can tell us about.
  'PENDING', 'TBD', 'TODO', 'XXX', 'LOREM', 'PLACEHOLDER',
];

function looksUnfilled(v: string): boolean {
  const upper = v.trim().toUpperCase();
  return PLACEHOLDER_MARKERS.some((m) => upper.includes(m));
}

/**
 * Why these two fields cannot stand as a § 1812.533(b)(2) contact line, or null if they
 * can. Returned as a sentence because it is shown to the operator at the point of refusal.
 */
export function contactLineProblem(
  name: string | null | undefined,
  contact: string | null | undefined,
): string | null {
  const n = (name ?? '').trim();
  const c = (contact ?? '').trim();
  if (n === '') {
    return 'Civil Code § 1812.533(b)(2) requires the registry’s correct name in every '
      + 'advertisement, so the record cannot accept an entry without one.';
  }
  if (c === '') {
    return 'Civil Code § 1812.533(b)(2) requires the street address of the registry’s '
      + 'place of business or its correct telephone number in every advertisement.';
  }
  if (looksUnfilled(n)) {
    return `“${n}” is a placeholder, not the registry’s correct name. § 1812.533(b)(2) `
      + 'wants the name as filed, and an advertisement that carried this one should not '
      + 'have run.';
  }
  if (looksUnfilled(c)) {
    return `“${c}” is a placeholder, not an address or a telephone number. `
      + '§ 1812.533(b)(2) wants one the public can actually reach.';
  }
  return null;
}


/** One advertisement's run, as the record holds it. `to` null means still running. */
export interface AdRun {
  from: string;
  to: string | null;
}

/** A stretch of days inside the window with no advertisement recorded as running. */
export interface UncoveredStretch {
  from: string;
  to: string;
  days: number;
}

/** What the trailing-year check found. */
export interface AdvertisingCoverage {
  /** The first day the record is answerable for: a year ago, or the record's own start. */
  windowFrom: string;
  /** Today, in California. */
  windowTo: string;
  /** Days in that window with at least one advertisement recorded as running. */
  coveredDays: number;
  /** Days in that window with none. */
  uncoveredDays: number;
  /** Those days, grouped. */
  stretches: UncoveredStretch[];
  /**
   * True where the record holds nothing at all. Distinguished from "fully covered"
   * because they are opposite situations that both produce zero gaps: a registry that
   * has never advertised, and a registry that has never written any of it down.
   */
  empty: boolean;
  /**
   * True where the record begins after the window would — the registry's first recorded
   * advertisement is less than a year old. The days before it are not gaps, because
   * nothing is claimed to have run in them.
   */
  startsInsideWindow: boolean;
}

/**
 * Days in the trailing year the record cannot account for.
 *
 * The window begins a year before `today`, or at the earliest recorded entry where that
 * is later. Anchoring on the record's own start is the only honest choice available: the
 * alternative is to report a 366-day gap on the day a registry writes its first entry,
 * which is noise of exactly the kind that trains an operator to ignore the screen.
 *
 * It does mean a registry that records nothing has no gaps. That is not a loophole this
 * function can close — nothing in a database knows about an advertisement it was never
 * told about — so `empty` is returned separately and the screen says what it means.
 *
 * Both ends inclusive. A single-day print advertisement covers one day, not zero.
 */
export function advertisingCoverage(
  runs: readonly AdRun[],
  today: string,
  windowDays: number = ADVERTISING_WINDOW_DAYS,
): AdvertisingCoverage {
  const end = parseISODate(today);
  const windowStart = addDays(end, -(windowDays - 1));

  const parsed = runs
    .map((r) => ({ from: parseISODate(r.from), to: r.to === null ? end : parseISODate(r.to) }))
    // A run that ended before it began is refused by the database; if one ever reaches
    // here it is dropped rather than inverted, so a bad row cannot manufacture coverage.
    .filter((r) => daysBetween(r.from, r.to) >= 0);

  if (parsed.length === 0) {
    return {
      windowFrom: formatISODate(windowStart),
      windowTo: today,
      coveredDays: 0,
      uncoveredDays: 0,
      stretches: [],
      empty: true,
      startsInsideWindow: false,
    };
  }

  let earliest = parsed[0]!.from;
  for (const r of parsed) if (daysBetween(r.from, earliest) > 0) earliest = r.from;

  const startsInsideWindow = daysBetween(windowStart, earliest) > 0;
  const from = startsInsideWindow ? earliest : windowStart;

  // Clip to the window, drop what falls outside it, then merge and invert. Merging
  // first means two overlapping runs do not each claim the same day as covered.
  const clipped = parsed
    .map((r) => ({
      from: daysBetween(from, r.from) > 0 ? r.from : from,
      to: daysBetween(r.to, end) > 0 ? r.to : end,
    }))
    .filter((r) => daysBetween(r.from, r.to) >= 0)
    .sort((a, b) => daysBetween(b.from, a.from));

  const merged: { from: typeof from; to: typeof end }[] = [];
  for (const r of clipped) {
    const last = merged[merged.length - 1];
    // Adjacent counts as continuous: a run ending on the 4th and one starting on the 5th
    // leave no uncovered day between them.
    if (last && daysBetween(r.from, addDays(last.to, 1)) >= 0) {
      if (daysBetween(last.to, r.to) > 0) last.to = r.to;
    } else {
      merged.push({ from: r.from, to: r.to });
    }
  }

  const stretches: UncoveredStretch[] = [];
  let cursor = from;
  for (const r of merged) {
    if (daysBetween(cursor, r.from) > 0) {
      const gapTo = addDays(r.from, -1);
      stretches.push({
        from: formatISODate(cursor),
        to: formatISODate(gapTo),
        days: daysBetween(cursor, gapTo) + 1,
      });
    }
    if (daysBetween(cursor, addDays(r.to, 1)) > 0) cursor = addDays(r.to, 1);
  }
  if (daysBetween(cursor, end) >= 0) {
    stretches.push({
      from: formatISODate(cursor),
      to: today,
      days: daysBetween(cursor, end) + 1,
    });
  }

  const total = daysBetween(from, end) + 1;
  const uncovered = stretches.reduce((n, s) => n + s.days, 0);
  return {
    windowFrom: formatISODate(from),
    windowTo: today,
    coveredDays: total - uncovered,
    uncoveredDays: uncovered,
    stretches,
    empty: false,
    startsInsideWindow,
  };
}


/**
 * A new entry.
 *
 * `appeared_to` is null for a continuous medium that is still running and equal to
 * `appeared_from` for a dated one; the database checks both rather than trusting the
 * caller, because a print advertisement left open would claim to be still appearing in
 * an issue from February.
 *
 * $11 is the moment the ENTRY is made, and `now()` when it is null. The application
 * always passes null. It exists for the seed, which fabricates a history of
 * advertisements running back through the year, and a record of them all stamped today
 * would say this registry wrote its whole § 1812.533(c) record in one afternoon —
 * which is a different and worse claim than the one the seed is making.
 * `tests/advertising.test.ts` fails if anything under the console passes it a value.
 *
 * $1 medium · $2 publication · $3 appeared from · $4 appeared to, or null ·
 * $5 reference · $6 snapshot url · $7 name carried · $8 contact carried ·
 * $9 content hash · $10 recorded by · $11 entered at, or null for now.
 */
export const ADVERTISING_LOG_INSERT = `
  INSERT INTO advertising_log
    (medium, publication, appeared_from, appeared_to, reference, snapshot_url,
     carried_name, carried_contact, content_hash, recorded_by, created_at)
  VALUES
    ($1::ad_medium, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10,
     COALESCE($11::timestamptz, now()))
  RETURNING id`;

/**
 * An advertisement stops running.
 *
 * The one mutation this table permits, and it is a mutation rather than a second row on
 * purpose: "it came down on the 9th" is new information about one advertisement, not a
 * correction to what was written about it. Allowed exactly once — the WHERE clause
 * returns nothing for an entry already closed, so a second attempt is a no-op the caller
 * can detect rather than a silent overwrite of the date it actually came down.
 *
 * $1 the entry · $2 the day it stopped appearing.
 */
export const ADVERTISING_LOG_CLOSE = `
  UPDATE advertising_log
     SET appeared_to = $2::date
   WHERE id = $1 AND appeared_to IS NULL
  RETURNING id, appeared_from`;

/**
 * A correction. Same shape as the assignment log's: the original stays, a new entry says
 * what it should have said and points at it.
 *
 * The medium and publication are copied from the row being corrected rather than
 * retyped. A correction that could also change which publication the advertisement
 * appeared in would not be a correction; it would be a different advertisement, and it
 * should be recorded as one.
 *
 * $1 the entry corrected · $2 appeared from · $3 appeared to, or null · $4 reference ·
 * $5 snapshot url · $6 name carried · $7 contact carried · $8 recorded by · $9 the note.
 */
export const ADVERTISING_LOG_CORRECTION = `
  INSERT INTO advertising_log
    (medium, publication, appeared_from, appeared_to, reference, snapshot_url,
     carried_name, carried_contact, content_hash, recorded_by,
     corrects_id, correction_note)
  SELECT a.medium, a.publication, $2::date, $3::date, $4, $5, $6, $7, a.content_hash,
         $8, a.id, $9
    FROM advertising_log a
   WHERE a.id = $1
  RETURNING id`;

/** The media whose entries may be left open, as a SQL array literal. See SKILLED_SQL_ARRAY. */
export const CONTINUOUS_MEDIA_SQL_ARRAY: string =
  `ARRAY[${AD_MEDIA_KEYS.filter(isContinuous).map((m) => `'${m}'`).join(', ')}]::ad_medium[]`;
