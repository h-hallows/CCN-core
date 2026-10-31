# @h-hallows/core

Owns the database and the rules that must not differ between surfaces: the Drizzle
schema, the migrations, the credential engine, business-day arithmetic, the care
vocabulary, and the copy-lint ruleset.

No app. No routes.

## Who consumes this

| Repository | What it is |
|---|---|
| [CCN-Registry](https://github.com/h-hallows/CCN-Registry) | the internal operator console |
| [CCN-external](https://github.com/h-hallows/CCN-external) | the public platform — marketing site and the three portals |

Both install it straight from git, pinned to a tag:

```jsonc
"dependencies": { "@h-hallows/core": "github:h-hallows/CCN-core#v0.1.0" }
```

No package registry and no tokens. Both apps set
`transpilePackages: ['@h-hallows/core']`, because this ships TypeScript source rather
than a build.

## Why it exists

Eligibility, the credential matrix, the care vocabulary and the forbidden copy list have
to be computed the same way everywhere. A second implementation is a second answer, and
one of them will be the wrong one in front of a household — a provider shown as
available whose clearance lapsed on Tuesday, or a page calling a referred provider an
employee.

Everything in `src/domain` is pure: no database handle, no `process.env`, no `Date.now()`
captured at module scope. Anything needing today's date takes it as an argument. That is
what makes the tests deterministic and what lets both apps agree.

## What is in here

```
src/schema      the tables, split by subject, and the types derived from them
src/domain      credentials, match, businessDays, dates, care — all pure
src/db          client, migration runner, seed
src/lint        the I9 ruleset and the ccn-lint CLI
src/testing     the seeded-database helper both consumers use
migrations/     hand-written SQL, append-only
INVARIANTS.md   one copy; both apps link to this file
```

**Migrations are hand-written SQL, not drizzle-kit output.** They carry triggers —
the append-only guards, the disclosure immutability guard, the physician check, the
nurse-disclosure gate — and drizzle-kit cannot generate those. A regeneration would
silently drop every one of them, taking I3, I4 and I11 with it. A test asserts the
schema and the migrations describe the same tables and columns, because they are
maintained separately and that is exactly how they drift.

## Releasing

```bash
npm version patch|minor|major   # or edit the version by hand
git push && git push --tags
```

Then bump the tag in each consumer's `package.json`. The pin is deliberate: it stops a
core change reaching one app before the other. It is also what lets the two drift, so
add a check that both pin the same tag.

*Not legal advice. `INVARIANTS.md` maps each rule to its statute.*
