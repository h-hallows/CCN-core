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

| # | Invariant | Source | Where it is enforced |
|---|---|---|---|
| **I1** | No training content of any kind — no modules, courses, completion tracking, required reading, competency checks or skills assessment. A voluntary orientation record covering *only* administrative procedures and the referral agreement is permitted. | (b)(4), § 687.2(d) | No `training` / `course` / `module` / `curriculum` / `competency` table or route. CI: `scripts/copy-lint.mjs`, `tests/invariants.test.ts`. Permitted field: `providers.orientation_on`. |
| **I2** | No work direction — no task checklists, no duty verification, no care-plan authoring, no clock-in with task attestation, no GPS verification of duties performed. | (b)(5), § 687.2(e) | No `task` / `care_plan` / `duty` / `checklist` table. `coverage_gaps` holds confirmation only, never task completion. CI banned-table test. |
| **I3** | No auto-assignment. No code path creates a `referrals` row without an explicit operator action that writes a `disclosures` row in the same transaction. | (b)(5) | `referrals.disclosure_id` is `NOT NULL REFERENCES disclosures(id)`. Single transaction in `lib/domain/referral.ts`. |
| **I4** | The registry cannot end a household–provider relationship. Permitted: the household ends the engagement, the provider declines, or the registry stops referring (forward-only). | (b)(9), § 687.2(i) | `ended_by` enum has no `registry` member. No `terminateProvider` mutation exists. Forward-only stop = `providers.status = 'do_not_refer'`. |
| **I5** | Rates are provider-set and always rendered as negotiable. The system never computes, suggests, caps or defaults a provider's rate. | (b)(3), § 687.2(c) | `providers.rate_hourly` has no default and is written only by provider-origin mutations. No rate suggestion code. `<Rate>` always renders the negotiable marker. |
| **I6** | The referral fee is charged to the household as a fixed percentage of job cost. Never deducted from provider earnings. The registry is never obligated to pay a provider when the household has not paid. **§ 1812.530 goes further for nurses: no registration fee of any kind, no confession of judgment, no promissory note, no wage assignment.** A migration assertion fails if any column could hold a provider-side charge. | (b)(7), (c), § 687.2(g), § 1812.530 | `cases.fee_charged_to` is `CHECK (fee_charged_to = 'household')`. No `provider_deduction` column anywhere. |
| **I7** | Satisfaction feedback about a referral may be recorded. It may **not** be routed into provider discipline, coaching, training, performance improvement or any corrective workflow. | § 687.2(e) | `referral_feedback.use_restriction` is `CHECK (= 'referral_decisions_only')`. No `performance_review` / `coaching` / `corrective_action` table. Feedback is read only by referral-decision code paths. |
| **I8** | No tools, supplies, equipment, uniforms, badges or devices issued to providers. | (b)(6), § 687.2(f) | No inventory or asset-assignment table. CI banned-table test. |
| **I9** | Forbidden strings in any operator-, provider- or client-facing copy: `independent contractor`, `self-employed`, `self employed`, `our nurses`, `our caregivers`, `our staff`, `our employees`, `home health`, `surety bond`, `bonded and insured`, `licensed and bonded`. `employee` is forbidden too, except inside the statutory texts, which cannot state what the registry is *not* without the word. Providers are **referred providers**. | (g), (i)–(j), HSC § 1726(c) | `ccn-lint` over each app's `app/`, `components/`, `content/`. Fails the build. Ruleset: `packages/core/src/lint/forbidden.mjs`. |
| **I10** | Needs profiles are recorded as stated by the household. The system never generates, suggests or templates clinical content. | (b)(5) + HHA licensure | `cases.needs_authored_by` is `CHECK (= 'household')`. No generation endpoint. Free-text input only, no templates. |
| **I11** | A skilled case cannot reach `referred` status without an ordering physician on the household record. | § 1812.524(a), (c) | `trg_physician_skilled` trigger on `cases`, plus an assertion inside the referral transaction. |
| **I12** | A provider with any required credential missing or expired is excluded from every shortlist. No override exists, for any role. | Diligence | Computed in the query layer (`lib/queries/match.ts`), never in the UI. An ineligible provider must not reach the client. |

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

## Rules for contributors

1. Read this file before opening a PR. The PR template asks you to confirm each invariant.
2. `tests/invariants.test.ts` is a CI gate. Do not weaken it, skip it, or add an override
   path "just for admins". These tests are what keep a future contributor from quietly
   dismantling the legal position.
3. If a product requirement appears to need an invariant relaxed, that is a question for
   counsel, not a code review discussion. See `COUNSEL.md`.

## The design rule that keeps the coverage surface safe

The system records **the pattern the household asked for** and **the availability the
provider stated**, and notes where they fail to meet. It never generates an assignment,
allocates a shift, or produces a roster.

*Not legal advice.*
