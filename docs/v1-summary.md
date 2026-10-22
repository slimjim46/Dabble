# v1 implementation summary

v1 is the shared plaza canvas. The detailed specification is archived at
`docs/archive/SPEC-phases-3-4-6.md`.

## Implemented areas and repository evidence

- **v1 Phase 3 — schema:** player/session/report/snapshot tables and stroke
  columns are defined in migrations `20261017220100`–`20261017220500`.
  `tests/phase3-acceptance.mjs` checks the existing canvas flow against a
  migrated dev database.
- **v1 Phase 4 — sessions and country stats:** Vercel Functions live in `api/`,
  client tracking in `src/lib/session.js`, and aggregate RPCs in migrations
  `20261018090000`–`20261018092000`. `tests/api.test.mjs` covers handler logic
  without a network.
- **v1 Phase 6 — abuse protection and moderation:** stroke policies and limits,
  names, reports, admin RPCs and client protections are implemented in
  migrations `20261017230100`–`20261017230700` and client code.
  `tests/rls.test.mjs` covers the 18-case anonymous-user acceptance suite
  against dev.

## Verification note

The migration and test files establish implementation evidence; this summary
does not claim a fresh dev-database test run. Run the relevant tests against
the dev project before relying on a new verification result. Nothing here
authorizes production database changes.
