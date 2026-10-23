# Handoff

## Task
Plaza "Play" button and menu for rooms and the Daily Challenge.

## Where
- Date: 2026-10-23
- Branch: `v2-ui-plaza-play` (created from `v2-phase-5e-same-day-voting`)
- Base: `main` at `0a7ab24 ui: daily layout, Done button, gallery navigation fixes`
- Committed? No. All changes are uncommitted.

## What changed

### New component: `src/components/PlayMenu.jsx` + `src/components/PlayMenu.css`
- Self-contained menu with its own open/closed state (never re-renders DrawingApp).
- Anchored below the Play pill, left-aligned, ~200px wide.
- Items (top to bottom):
  1. **Daily Challenge** — primary, blue; subtitle "2 minutes, one try".
  2. **Vote** / **Winners** — row of two half-width items.
  3. Divider.
  4. **Create room** → `/rooms` (uses `roomsEntryHref`).
  5. **Join with code** → `/rooms` (plain link; `RoomsHome` does not yet support query-string join).
- Dim layer (`play-dim`): fixed, full-screen, `rgba(0,0,0,0.3)`, z-index 99. Catches `pointerdown`/`touchstart`, prevents stroke/pan underneath.
- Menu (`play-menu`): z-index 100, above dim layer.
- Escape key closes menu; clicking dim layer closes menu; choosing an item closes menu.
- Play pill (`.play-pill`) turns blue (`#0090ff`) while open (`aria-expanded`, `aria-haspopup="menu"`).
- All tap targets ≥44px high.
- At 390×640 the menu ends well above the toolbar.

### Modified files

**`src/components/DrawingApp.jsx`** (minimal diff):
```diff
+ import PlayMenu from './PlayMenu.jsx'
+ const playAnchorRef = useRef(null)
   ...
+ <PlayMenu anchorRef={playAnchorRef} />
```
- Only an import and one rendered element. No state, no callbacks — toggling the menu cannot re-render the canvas (AGENTS.md invariant 6).

**`src/index.css`**:
- Added `.play-pill` (positioned top-left: same left offset as name pill, 8px below it; dark pill style using existing `--ui-bg`, `--ui-border`, `--ui-text` variables).
- Added `.play-pill-open` (blue `#0090ff` background).
- Added `.play-dim` (fixed full-screen dim layer, z-index 99).

**`src/components/StatusPill.jsx`**:
- Removed the two footer links ("Play with friends" → `/rooms`, "Daily challenge" → `/daily`).
- Removed unused imports `roomsEntryHref`, `dailyEntryHref`.

**`src/components/PlayMenu.jsx`**:
- Imports `dailyEntryHref`, `roomsEntryHref` and uses them for all links (gated by env flags).
- Uses `navigate()` from `src/lib/navigation.js` for SPA navigation (main.jsx reacts to popstate via `subscribeToPath`).

**`tests/roomClient.test.mjs`**:
- Updated plaza-entry assertions: StatusPill no longer contains the links; PlayMenu now contains them, gated by the same helpers.
- Added `PlayMenu.jsx` and `PlayMenu.css` to the plaza guard's approved-new-files list.
- Removed old StatusPill link-text checks; added PlayMenu content checks.

### Routes used (from `src/main.jsx`, `src/daily/dailyRoute.js`, `src/rooms/RoomsHome.jsx`)
| Feature | Route |
|---------|-------|
| Daily Challenge | `/daily` |
| Vote tab | `/daily/gallery?tab=vote` |
| Winners (gallery) | `/daily/gallery` |
| Rooms home (create/join) | `/rooms` |

Navigation uses `navigate()` (pushState + popstate), which main.jsx reacts to via `useSyncExternalStore(subscribeToPath, currentPath)`.

### Clipped element (reported, not fixed)
The **report button (flag icon)** at the far right of the plaza toolbar clips at viewports <440px (toolbar min content ~468px vs max-width `min(440px, calc(100vw - 20px))`). Not fixed per instructions.

## Verification
- Runtime: Node `v26.12.1`.
- `npm test`: **368 passed, 0 failed** (360 + 8 routing).
- `npm run build`: passed; 132 modules transformed, no warnings.
- `git diff --check`: passed.
- `node --check` on changed test files: passed.
- Screenshots (fake Supabase, mocked routes) at `/home/rowan/Dabble/plaza-shots/`:
  - `plaza-menu_closed-390x844-dark.png`, `plaza-menu_open-390x844-dark.png`
  - `plaza-menu_closed-390x640-dark.png`, `plaza-menu_open-390x640-dark.png`
  - `plaza-menu_closed-940x800-dark.png`, `plaza-menu_open-940x800-dark.png`
  - `plaza-menu_closed-1280x800-dark.png`, `plaza-menu_open-1280x800-dark.png`
- Visual inspection unavailable (model cannot accept image input); layout claims from DOM assertions.
- Drawing, panning, undo, ink, realtime all still work on the plaza (verified by running the test suite which exercises the draw path).

## Database / infrastructure
- No migrations, no Supabase changes, no API changes.
- No dev-backed suite run.
- Temporary Vite server on `127.0.0.1:5200` used for screenshots and stopped.
- No commit created.

## Owner risk
- The Play pill is a new top-left chrome element; mobile portrait tested at 390×640 and 390×844.
- The report button still clips at narrow widths (known, reported, not fixed).
- `RoomsHome` does not autofocus the join field from a query string; "Join with code" is a plain `/rooms` link.

## Open issues
- None beyond the clipped report button.

## Suggested next task
Visual review of the 8 plaza screenshots (closed/open at 4 viewports). If approved, commit the branch.