# Handoff

## Task
Create a clean handoff-workflow branch from `main`, keeping the existing
`chore-handoff-workflow` branch unchanged.

## Where
- Date: 2026-10-22
- Branch: `chore-handoff-clean`
- Last commit: `21aa09a Merge branch v2-phase-5-daily`
- Committed? No. The selected docs/workflow changes are staged; shared-file
  merges and the task handoff edits are unstaged. Generated `claude-context/`
  remains ignored and uncommitted.

## What changed
- Brought over the Claude read-first guide, handoff builder, status/decision/v1
  docs, room-specific rules, and v1 archive. The archived spec is the current
  `main` version, preserving its text while relocating it.
- Added only the handoff script entry to `package.json`; no lockfile or
  dependency changes. Added `claude-context/` to `.gitignore` and appended the
  handoff rule to the existing root `AGENTS.md`.
- Updated `docs/STATUS.md` to say v2 Phases 2–5 are merged into `main`, and
  reconciled rooms guidance with the current two-worker dev setup.

## Verification
- `npm test` — passed; all suites passed (final room-client output:
  `363 passed, 0 failed`).
- `npm run build` — passed; Vite transformed 128 modules.
- `npm run handoff` — passed; generated `00-READ-FIRST.md` through
  `04-last-handoff.md` (about 9,780 tokens total).
- `git diff --check` and package JSON parsing — passed.
- Runtime: Node `v26.12.1` from the already-present `node_modules/node/bin/node`;
  no Node dependency or lockfile entry was added. `npm run test:dev` was not run.
- Read-only dev migration list: `20261023000000`, `20261024000000`, and
  `20261025000000` are applied; `20261026000000` is local only. No migration was
  applied during this task.

## Database / infrastructure
- Migrations applied to dev by this task: none.
- New or changed policies, security definer functions, grants/revokes: none.
- Worker deploys: none. Nothing was applied to production.

## Open issues
- The owner-maintained v2 Status table still says Phase 2 is next and Phases
  3–10 are not started. It was not edited.
- The backup branch contains unrelated committed screenshots, a captured diff
  at root `testing`, a dev helper SQL file, and a `node` app dependency; none
  was brought into this branch.

## Owner must do manually
Review and merge `chore-handoff-clean` when ready. The owner may update the v2
Status table separately. No dashboard or environment changes are required.

## Doc discrepancies noticed
`docs/STATUS.md` now records v2 Phases 2–5 as merged, while the spec Status
table remains behind. The spec table is unchanged.

## Suggested next task
Review and merge `chore-handoff-clean` into `main`. The v2 implementation
branches are already merged, so no additional phase-branch merge order is needed.
