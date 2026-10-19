# Dabble v2: Game Platform Spec

Rooms, game modes and a free-to-start architecture. Builds on v1 (the plaza).
Source: "Dabble Game Platform Plan (v2)", October 2026.

## How agents use this file

- Read `AGENTS.md` first; its rules override this file.
- **Numbering overlaps with v1.** `SPEC-phases-3-4-6.md` also has Phases 3, 4
  and 6. Always say **"v1 Phase N"** or **"v2 Phase N"**. Phases below are v2.
- Work only on the phase a task names. Do not start later phases, and do not
  build features from sections marked "context only".
- If a task conflicts with the Design principles below, stop and ask.
- The plaza (v1) is live and must not regress. Never change plaza behaviour as
  a side effect of rooms work.

## Status (the owner updates this; agents do not edit it)

| v2 phase | Status |
| --- | --- |
| 0 Spike and de-risk | Done. Gate passed with one caveat: free-tier fit is formula-based; a clean-day calibration run is pending |
| 1 Room server foundation | Done (`rooms/`, Worker + Room Durable Object, dev Worker only) |
| 2 Room client | Next |
| 3 to 10 | Not started |

Items from the plan's Phase 0 that live outside code and are owner-tracked:
finish seasons and merge, privacy page, moderation, real-phone tests of the
live site.

## Decisions already made

- Rooms are an extra layer. The plaza stays the landing page and lobby.
- Auth: `Sec-WebSocket-Protocol: dabble.v1, <supabase jwt>` only. The Worker
  verifies the JWT; the Durable Object never sees a token.
- Identity (name, country, ban) comes from the server, never from client messages.
- Room state lives in memory only. Nothing about a live room is written to
  Supabase. Only results and notable drawings are persisted, in later phases.
- Cost model: billed requests = connections + incoming WebSocket messages / 20.
  Outgoing messages are free. Ping/pong uses the auto-response and is not
  expected to wake the Durable Object. A 10-minute drawer-only game is about
  430 billed requests (range 310 to 610). Re-measure with real Guess-mode traffic in v2 Phase 3.
- Test isolation: `X-Test-IP` is honored only when `ENVIRONMENT === 'dev'` exactly.

## Open decisions

- **Late join:** the server currently relays strokes but may not send existing
  canvas state to a player who joins mid-round. Decide the design (server-held
  strokes for the current round, in memory) during v2 Phase 3. Never fake it on the client.
- **Prep for v2 Phase 8, do before the room client hardcodes the wire format:**
  (1) a brush id and the protocol version in stroke messages (everyone uses brush 0);
  (2) validate colours against a server-side list instead of any hex value;
  (3) spare `xp` and `level` columns on `players`, unused for now.

## 1. Honest verdict

- **Technically:** feasible, and you can build and launch it for $0. Game rooms
  need one new piece, a Cloudflare Worker with Durable Objects. Everything built
  so far stays: Supabase, Vercel, the plaza canvas, moderation, the admin page
  and the wire format.
- **As a business (context only):** uncertain. The genre is crowded (Skribbl,
  Gartic Phone, Quick Draw). The real risk is having enough people online at
  once. Treat the first months as validation.
- **Do not rewrite the plaza.** The existing global canvas becomes the landing
  page and lobby. Games are a new layer on top.
- **Cut the scope.** Launch two modes: Guess-the-drawing (private rooms with
  friends) and a Daily Challenge (works with a single player). Public
  matchmaking and live voting rooms come later.
- **Wait on levelling.** See v2 Phase 8.

## 2. Design principles

- No login wall. Guests by default.
- The paper stays the star. Game text (word hint, timer, banners, scores) sits
  above it.
- No free chat in version 1, only a guess box. That removes most moderation and
  child-safety problems.
- The server decides everything that matters: the secret word, timers and scores.
- Keep per-room data in memory and throw it away. Save only what is worth keeping.
- Spend nothing until the numbers justify it.

## 3. Architecture

| Component | Role | Status |
| --- | --- | --- |
| Vercel | Static site and the existing `api/` functions | Stays |
| Supabase | Anonymous auth, players, sessions, stats, leaderboards, reports, admin, Daily Challenge data | Stays, extended |
| Plaza canvas | Global free-roam canvas, snapshots, seasons | Stays (lobby) |
| GitHub Actions | Snapshot rendering, keep-alive, result jobs | Stays, extended |
| Cloudflare Worker + Room Durable Object | WebSocket relay, game state machine, secret word, timers, scoring, per-room rate limits | New |
| Lobby Durable Object (later) | Directory of open public rooms for matchmaking | New, later |

- **Auth:** the client sends its Supabase token when it connects, and the Worker
  verifies it, so the same anonymous identity works everywhere.
- **Room codes:** a 5-character code (no look-alike letters) maps directly to a
  Durable Object, so no database lookup is needed. The room exists once the
  first player connects.
- **Empty rooms:** a room removes itself after a grace period, so a refresh or a
  locked phone does not destroy it.
- **Message format:** reuse the shapes in `wire.js` and keep the version field,
  so the transport can change later.

## 4. Phases (v2)

### v2 Phase 0: Spike and de-risk (done)

- Throwaway Worker + Durable Object relay with WebSocket hibernation, measured
  with the load-test script.
- Supabase tokens verified inside the Worker.
- Decision gate: numbers must fit the free tier.

### v2 Phase 1: Room server foundation (done)

- Connect, join, leave, player cap (12), host, kick, reconnect into the same seat.
- `wire.js` event shapes plus a version field.
- Empty-room cleanup after the grace period (Durable Object alarm).
- Per-connection limits: message size, messages per second, rooms created per hour.

### v2 Phase 2: Room client

- Home screen: Play, Create room, Join with code.
- Room screen: paper in the middle, a header zone above it (round, timer, hint),
  and a player list with flags and scores. Mobile portrait first.
- Game canvases are fixed-size and fit-to-screen, with no pan and zoom.
- Reuse the existing drawing engine, brushes and ink logic.

### v2 Phase 3: Guess mode

- State machine: lobby, word pick, drawing, reveal, scores, next round, game over.
- The drawer picks one of three words. A round lasts 60 to 80 seconds. Hint
  letters appear at roughly 50% and 75% of the time.
- The secret word never leaves the server except to the drawer.
- A guess box with case and accent normalisation and a "close!" hint. Correct
  guessers cannot leak the word.
- Faster guesses score more, and the drawer scores for each correct guesser.
- Edge cases: drawer disconnects (skip the round), host leaves (promote
  someone), too few players (back to the lobby).

### v2 Phase 4: Words and content

- Own word list tagged by category and difficulty, shipped with the Worker,
  plus a blocked-word list. The blocked-word list is supplied by the owner;
  never hard-code one (see `AGENTS.md`).
- Private rooms may use custom words, which go through the same filter.

### v2 Phase 5: Daily Challenge (works with one player)

- One prompt a day, a 2-minute timed attempt, one try per account.
- Submissions use the same server-side limits as plaza strokes.
- Next day, voters see a small grid of anonymous entries and pick favourites.
  One vote per entry, no self-votes, and you must have submitted that day's entry.
- A winners gallery with a shareable image per winner, rendered by a job like
  the existing snapshot job.
- Entries need moderation (v2 Phase 6), because strangers will see them.

### v2 Phase 6: Moderation for rooms

- Report player and report drawing, with auto-hide thresholds like the plaza's.
- Host kick, vote-kick, and a room-level mute for repeat offenders.
- Reuse the name filter and share the ban list with the admin page.
- Honest limit: nobody can filter every drawing automatically without a paid
  image-moderation service. At small scale, review manually.

### v2 Phase 7: Growth

- Private room links with a "Join my game" preview image.
- Round replays: store the strokes of notable drawings and render them as a
  timelapse in the browser.
- Country vs country scoreboards, building on the existing country leaderboard.
- Streaks for the Daily Challenge.
- Launch channels: Reddit game communities, Show HN, itch.io, friends-first sharing.

### v2 Phase 8: Progression and unlocks (after the core games work)

Recommendation: wait. Why: progress needs stable identity (guests are tied to a
browser), XP must be awarded by the server, brushes are expensive (they change
the wire format, validation, ink rules and rendering), and a curve cannot be
tuned without players.

Cheap preparation (listed under Open decisions above): brush id and protocol
version in stroke messages, server-side colour list, spare XP/level fields.

Launch design, when ready: cosmetic only (colours, avatar frames, name flair),
nothing that affects winning. Free basics stay free: starter palette, three
brush sizes, undo. Levels 1 to 10 first, earned from finished games and Daily
Challenges. Offer "save your progress" after the first level-up.

### v2 Phase 9: Cost control and scaling

Cloudflare Durable Object figures, checked October 2026. Re-check before relying on them.

| Item | What applies |
| --- | --- |
| Free plan storage type | Only SQLite-backed Durable Objects |
| Free requests | About 100,000 per day, resetting at 00:00 UTC |
| Over the free limit | Further operations fail until the reset, so a friendly "rooms are busy" screen is needed |
| Incoming WebSocket messages | Billed at 20 messages to 1 request. Outgoing messages are free |
| Connection time | Duration is billed while a normally accepted connection stays open, which is why hibernation is used |
| Paid plan | A flat $5 per month minimum, extra requests at $0.15 per million |

- Build the "rooms are busy, try again soon" screen so hitting the daily limit
  fails gracefully.
- Do not pay until the limit is regularly hit.
- Vercel Hobby is likely limited to non-commercial use; check before monetising.
- Supabase free-tier limits and the keep-alive job stay as in v1.

### v2 Phase 10: Testing and launch

- Load test with simulated rooms: many rooms with 4 to 10 clients each.
- Chaos tests: kill the drawer's tab mid-round, airplane mode, lock the screen, reconnect.
- Cheat tests: inspect WebSocket traffic as a guesser to confirm the word never
  appears; spam guesses and send oversized messages.
- Real-phone tests with 3 to 4 people.
- Privacy-friendly analytics only if wanted: time to first stroke, games per player.

## 5. Proposed new data (Supabase)

Live room state is not stored in the database. Only results and things worth keeping.

| Table | Purpose |
| --- | --- |
| `daily_prompts` | The prompt for each day, created by the owner |
| `daily_entries` | One entry per player per day, strokes validated server-side, hidden until it passes moderation rules |
| `daily_votes` | One vote per voter per entry, with checks against self-votes and non-participants |
| `match_results` | Finished games: mode, player count, scores, countries (no personal data) |
| `saved_drawings` | Strokes of notable drawings for replays and galleries |
| `player_progress` (later) | XP, level and unlocked items |

## 6. Making money (context only, do not build)

Nothing before an audience exists. Later options: cosmetics via Stripe, a
supporter tier, sponsored country events. Ads are the weakest fit for a drawing
game children may play; child-privacy rules (COPPA and similar) apply. Not legal advice.

## 7. Biggest risks (context only)

Empty rooms; offensive drawings; free-tier ceilings (know the $5 path); scope
creep (three modes, matchmaking and accounts at once); no clear differentiator
(lean on flags and countries, the live plaza, the paper look).
