# INVARIANTS

> **Correction, 31 October 2026 — there are two statutory regimes, not one.**
>
> This file treated Civil Code § 1812.5095 as governing. That is correct for **CNAs,
> HCAs and companions**. It is the **wrong chapter for nurses**: private duty nursing
> referrals fall under Civil Code Chapter 7, §§ 1812.524–1812.533, which carries
> obligations with no § 1812.5095 equivalent — an assignment log (§ 1812.529), a posted
> fee schedule with a seven-day embargo (§ 1812.527), a licence physically inspected
> (§ 1812.528), no charge of any kind to a nurse (§ 1812.530), no fee splitting with a
> physician, hospital or their agents (§ 1812.531), and a residence disclosure that must
> reach the patient **before care begins** rather than within three business days
> afterwards (§ 1812.533(b)(4)).
>
> The operating posture is the **superset**: deliver both regimes' disclosures on every
> referral. One extra document is cheaper than the question of which chapter applied.
> Migration `0004_nurses_registry` implements the Chapter 7 obligations; the invariants
> below are unchanged and still hold.

**Every rule below maps to a condition in California Civil Code § 1812.5095(b) or
Unemployment Insurance Code § 687.2.** Those nine factors are the *only* mechanism
keeping a referred provider from being treated as CCN's employee. Labor Code § 2777's
referral agency exemption does **not** apply to this business — § 2777(b)(2)(C)
expressly excludes referrals to businesses providing in-home care.

There is no second shield. **A violation of any invariant below is a release blocker,
not a cleanup item.**

Penalty exposure: $2,500 per violation under § 1812.5095(k).

**Paths are repository-qualified.** This file lives in `CCN-core`, but the three
enforcement points are spread across three repositories: `CCN-core` owns the schema, the
migrations, the domain and the lint ruleset; `CCN-Registry` is the operator console;
`CCN-external` is the public platform. Before the split these were one tree and a bare
path was unambiguous. Four of the cells below pointed at paths that no longer existed.

| # | Invariant | Source | Where it is enforced |
|---|---|---|---|
| **I1** | No training content of any kind — no modules, courses, completion tracking, required reading, competency checks or skills assessment. A voluntary orientation record covering *only* administrative procedures and the referral agreement is permitted. | (b)(4), § 687.2(d) | No `training` / `course` / `module` / `curriculum` / `competency` table or route. CI: the `ccn-lint` bin (`CCN-core: src/lint/run.mjs`, ruleset `src/lint/forbidden.mjs`) and `CCN-core: tests/invariants.test.ts`. Permitted field: `providers.orientation_on`. |
| **I2** | No work direction — no task checklists, no duty verification, no care-plan authoring, no clock-in with task attestation, no GPS verification of duties performed. | (b)(5), § 687.2(e) | No `task` / `care_plan` / `duty` / `checklist` table. `coverage_gaps` holds confirmation only, never task completion. CI banned-table test. |
| **I3** | No auto-assignment. No code path creates a `referrals` row without an explicit operator action that writes a `disclosures` row in the same transaction. **Extended to the public platform (web spec W6): a household asking about a provider produces a `shortlist_requests` row and nothing else.** | (b)(5) | `referrals.disclosure_id` is `NOT NULL REFERENCES disclosures(id)`. Single transaction in `CCN-Registry: apps/registry/lib/domain/referral.ts`. `shortlist_requests` carries no trigger, by design (`CCN-core: migrations/0002_front_door.sql`), and its household insert policy refuses any row that is not `pending` with a null `referral_id` (`0003_rls.sql`). `CCN-external: tests/request.test.ts` walks the import graph out of `app/(client)` and fails if any reachable module writes to `referrals`, `timeline_entries` or `disclosures`. |
| **I4** | The registry cannot end a household–provider relationship. Permitted: the household ends the engagement, the provider declines, or the registry stops referring (forward-only). | (b)(9), § 687.2(i) | `ended_by` enum has no `registry` member. No `terminateProvider` mutation exists. Forward-only stop = `providers.status = 'do_not_refer'`. |
| **I5** | Rates are provider-set and always rendered as negotiable. The system never computes, suggests, caps or defaults a provider's rate. | (b)(3), § 687.2(c) | `providers.rate_hourly` has no default and is written only by provider-origin mutations. No rate suggestion code. `<Rate>` always renders the negotiable marker. |
| **I6** | The referral fee is charged to the household as a fixed percentage of job cost. Never deducted from provider earnings. The registry is never obligated to pay a provider when the household has not paid. **§ 1812.530 goes further for nurses: no registration fee of any kind, no confession of judgment, no promissory note, no wage assignment.** A migration assertion fails if any column could hold a provider-side charge. | (b)(7), (c), § 687.2(g), § 1812.530 | `cases.fee_charged_to` is `CHECK (fee_charged_to = 'household')`. No `provider_deduction` column anywhere. |
| **I7** | Satisfaction feedback about a referral may be recorded. It may **not** be routed into provider discipline, coaching, training, performance improvement or any corrective workflow. | § 687.2(e) | `referral_feedback.use_restriction` is `CHECK (= 'referral_decisions_only')`. No `performance_review` / `coaching` / `corrective_action` table. Feedback is read only by referral-decision code paths. |
| **I8** | No tools, supplies, equipment, uniforms, badges or devices issued to providers. | (b)(6), § 687.2(f) | No inventory or asset-assignment table. CI banned-table test. |
| **I9** | Forbidden strings in any operator-, provider- or client-facing copy: `independent contractor`, `self-employed`, `self employed`, `our nurses`, `our caregivers`, `our staff`, `our employees`, `home health`, `surety bond`, `bonded and insured`, `licensed and bonded`. `employee` is forbidden too, except inside the statutory texts, which cannot state what the registry is *not* without the word. Providers are **referred providers**. | (g), (i)–(j), HSC § 1726(c) | `ccn-lint` over each app's `app/`, `components/`, `content/`. Fails the build. Ruleset: `CCN-core: src/lint/forbidden.mjs`. |
| **I10** | Needs profiles are recorded as stated by the household. The system never generates, suggests or templates clinical content. | (b)(5) + HHA licensure | `cases.needs_authored_by` is `CHECK (= 'household')`. No generation endpoint. Free-text input only, no templates. |
| **I11** | A skilled case cannot reach `referred` status without an ordering physician on the household record. | § 1812.524(a), (c) | `trg_physician_skilled` trigger on `cases`, plus an assertion inside the referral transaction. |
| **I12** | A provider with any required credential missing or expired is excluded from every shortlist. No override exists, for any role — **including the provider's own**. | Diligence | One implementation, in `CCN-core: src/domain/match.ts` and `src/domain/credentials.ts`, never in the UI. Re-checked at render on the public platform, because a shortlist published Monday can hold a provider whose clearance lapses Tuesday: `CCN-external: lib/portal.ts`. An ineligible provider must not reach the client, and the reason must not reach them either. A provider has **no INSERT on `credentials`**: uploads land in `credential_submissions`, which nothing computes eligibility from, and an operator creates the verified row (`CCN-core: migrations/0008_credential_submissions.sql`). |

### I12 — the hole that was there, and what it teaches

Until migration 0008, `credentials_provider_insert` (migration 0003) let a provider
insert their own credential row. `eligibility()` counts the **presence** of a row of the
required type as that requirement being satisfied. Together, those meant a provider
could insert their own Live Scan — the background check — with
`verified_by = 'me', verification_source = 'I checked it myself'`, and move from
ineligible to eligible. That is onto a household's shortlist, with no check having
happened. Demonstrated against the seed before the fix; denied by the policy after it.

Nothing had exploited it because nothing provider-facing had been built. W8 was the
milestone that would have shipped it.

Two things let it survive review, and both are worth remembering:

1. **A test asserted it.** `tests/rls.test.ts` had
   `it('provider role: INSERT INTO credentials for themselves succeeds')`, inside a
   describe block named *"a provider uploads, the operator verifies"*. The intent in
   the title was right and the assertion was its inverse. A green suite said the rule
   held.
2. **A NOT NULL disguised it.** `verified_on`, `verified_by` and `verification_source`
   are NOT NULL with no defaults, so a naive insert fails. That looks like a control
   and is not one — a deliberate insert simply supplies them.

The lesson for this file: an invariant is only as good as the assertion that is
actually written, and "the obvious statement fails" is not the same as "the action is
refused".

## I13 — now enforced, not a note

**Never advertise the surety bond or any licensure** in public-facing copy
(§ 1812.5095(i)–(j)). This was a Phase 2 note while there was no public surface; it is
now part of the I9 ruleset, because the front door is being built and the lint has to be
in place before the first marketing page is written, not after.

Two of those terms are about licensure rather than employment:

- **`home health`** implies a Home Health Agency licence. A registry is exempt from that
  licensure under HSC § 1726(c) and 22 CCR § 74600(b) *precisely because it is not one*.
  Describing itself in those words forfeits the exemption it relies on.
- **the bond and licence terms** are barred from advertising outright by
  § 1812.5095(i)–(j).

## I14 — a document is evidence

Migration 0015. The § 1812.5095 file has to be able to produce what it refers to: a
provider's signed agreement, the paper a credential was verified against, the written
statement a household was sent. Three rules hold that together, and all three are in the
database rather than in the application:

1. **The row cannot lie about the bytes.** `sha256_hex` and `byte_size` are checked
   against the bytes themselves by a CHECK constraint, so the digest can be quoted as
   evidence rather than as something an application asserted.
2. **Append-only.** No UPDATE, no DELETE. If a document is wrong, the right answer is to
   file the correct one and keep both, because "what was on file in March" is a question
   someone may ask years later.
3. **One exception, and it is deliberate.** Redaction drops the bytes and keeps the row,
   the digest, who filed it and why it went. It exists because append-only has a worse
   failure mode than losing history: file one household's paperwork against another and
   you cannot un-leak it.

`visible_to_subject` defaults to false and the subject may never set it. It governs what
the registry shares back, so letting the uploader choose it would make the subject the
author of their own permissions — and I12 keeps the diligence record away from both the
household and the provider.

Retention is unbounded on purpose. COUNSEL.md question 4 is open, and deleting evidence
is the irreversible mistake.

## Rules for contributors

1. Read this file before opening a PR. The PR template asks you to confirm each invariant.
2. `CCN-core: tests/invariants.test.ts` is a CI gate, and so is
   `CCN-external: tests/request.test.ts`. Do not weaken either, skip them, or add an
   override path "just for admins". These tests are what keep a future contributor from
   quietly dismantling the legal position.

   One of them says so in its own comments: the W6 gate asserts that nothing reachable
   from `app/(client)` so much as names the referral table. W7 relaxes exactly one half
   of that, for the feedback screen, which reads a single referral belonging to the
   household. Relaxing it is a deliberate decision, not a test to loosen when it goes
   red.
3. If a product requirement appears to need an invariant relaxed, that is a question for
   counsel, not a code review discussion. See `COUNSEL.md`.

## The design rule that keeps the coverage surface safe

The system records **the pattern the household asked for** and **the availability the
provider stated**, and notes where they fail to meet. It never generates an assignment,
allocates a shift, or produces a roster.

*Not legal advice.*
