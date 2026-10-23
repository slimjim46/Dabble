# Handoff

## Task
Fix Daily Challenge gallery navigation: Gallery must render the gallery without
a reload, the gallery Back button and browser Back must return to Daily, and a
direct `/daily/gallery` load must be styled and usable.

## Where
- Date: 2026-10-23
- Branch: `v2-ui-daily-screens`
- Last commit: `0d459a8 docs: handoff workflow, status and rules cleanup`
- Committed? No. This task is uncommitted alongside the earlier uncommitted
  Daily UI corrections in `DailyScreen.jsx`, `DailyPaper.jsx` and `daily.css`.

## What changed
- `src/main.jsx`: route selection now subscribes to `popstate` via
  `useSyncExternalStore`. Previously `window.location.pathname` was read once
  at module load, so Gallery/Back only changed the URL.
- `src/lib/navigation.js` (new): shared `currentPath`, `navigate` and
  `subscribeToPath` helpers. `navigate` keeps the existing
  `pushState` + `popstate` behaviour.
- `src/daily/dailyRoute.js` (new): `DAILY_PATH`, `DAILY_GALLERY_PATH` and
  `dailyView` used by both `main.jsx` and the test.
- `src/daily/DailyScreen.jsx`: Gallery and leave buttons use the shared
  `navigate` helper and route constants. Timer, submit, voting, one-try logic,
  recenter and Done placement were not changed by this task.
- `src/daily/DailyGallery.jsx`: Back uses `navigate(DAILY_PATH)` and the file
  imports `daily.css`, so a direct `/daily/gallery` load is styled. Previously
  only `DailyApp.jsx` imported that CSS.
- `tests/dailyClient.test.mjs`: added six routing/history checks and a
  `--routing-only` mode that runs before the Supabase env requirement.
- `package.json`: `npm test` now includes the routing-only test.
- `vercel.json`: unchanged; `/daily` and `/daily/:path*` already rewrite to
  `index.html`, covering `/daily/gallery`.
- No rooms/plaza/admin code, migration, API, or Done layout was changed.

## Verification
- Runtime: Node `v22.23.4`.
- New test before the fix: failed with `ERR_MODULE_NOT_FOUND` for the new
  routing modules.
- After the fix: `node tests/dailyClient.test.mjs --routing-only` passed
  (`6 passed, 0 failed`).
- `npm test`: passed; existing `363 passed, 0 failed` plus the new
  `6 passed, 0 failed`.
- `npm run build`: passed; Vite transformed 130 modules with no warnings.
- `git diff --check`: passed.
- External Playwright harness: `/tmp/opencode/ui-shots/capture.mjs`, fake
  Supabase only (`127.0.0.1:54321`, `fake-anon-key`); non-fake external requests
  were blocked.
- Harness checks passed:
  - Direct `/daily/gallery` loaded with `.daily-gallery` computed
    `position: absolute`, proving `daily.css` was present.
  - `390x844`: top chrome bottom `51`, first winner top `60` (`9px` clear);
    Back button `left 316.4375`, `top 10`, `right 378`, `bottom 43`; no
    horizontal overflow.
  - `1280x800`: top chrome bottom `46`, first winner top `60` (`14px` clear);
    Back button `left 1206.4375`, `top 11.5`, `right 1268`, `bottom 44.5`.
  - Empty state rendered centred; no horizontal overflow at either size.
  - Gallery Back returned to `/daily`; Gallery button then rendered
    `/daily/gallery`; `history.back()` returned to `/daily`.
- Screenshots:
  `/tmp/opencode/ui-shots/view/gallery-after/gallery-390x844-dark.png`,
  `gallery-1280x800-dark.png`,
  `gallery_empty-390x844-dark.png`,
  `gallery_empty-1280x800-dark.png`.
- Visual inspection was not possible: this model cannot accept image input.
  The layout claims above come from Playwright DOM/geometry assertions and
  computed styles, not from viewing the images.

## Database / infrastructure
- Migrations applied: none. No policies, functions, grants/revokes, or
  environment settings changed. Nothing applied to production.
- `vercel.json` was inspected, not edited. No deployment was performed.
- The temporary Vite server was stopped after the harness run.

## Open issues
- No image-based visual review was possible in this session.
- The screenshot harness and images are under `/tmp/opencode/ui-shots/`, not in
  git.
- The earlier wide-screen issue remains: at `940x800`/`1280x800` the drawing
  paper bottom can sit behind the toolbar. It is outside this task.

## Owner must do manually
None.

## Doc discrepancies noticed
- `docs/STATUS.md` still records the owner-maintained table as stale for v2
  Phases 2–5. That table was not edited.

## Suggested next task
Review the gallery screenshots visually, then continue the remaining Daily
screen work or commit the branch when ready.
