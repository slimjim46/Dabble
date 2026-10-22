# Implementation status

This is a compact navigation summary, not a replacement for the owner-maintained
Status table in `SPEC-v2-game-platform.md`. Do not edit that table.

## v1 — plaza

- v1 Phases 3, 4 and 6 have implementation evidence in migrations, client/API
  code and acceptance tests. See `docs/v1-summary.md` and the archived spec.
- Existing dev acceptance tests are not asserted as freshly passing by this
  documentation update.

## v2 — rooms and games

- The owner-maintained table says Phase 0 and 1 are done, Phase 2 is next, and
  Phases 3–10 are not started.
- v2 Phases 2–5 have implementation evidence in the room client, guess mode,
  custom-word flow, Daily Challenge client, migrations and tests.
- The `rooms-client`, `rooms-guess`, `fix-daily-routes`, and
  `v2-phase-5-daily` branch tips are all ancestors of `main`; Phase 2–5 work is
  merged. The owner-maintained table is stale for these phases and remains
  unchanged pending owner review.
- See `rooms/README.md` for the accepted rooms-server gaps and test/deploy
  commands. See the full v2 spec for design principles and future phases.
