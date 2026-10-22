# DoodleScrap: spec for Phases 3, 4 and 6

Read `AGENTS.md` first. Its rules apply to everything here.

Order of work: **3 -> 6 -> 4**. Phase 6 (abuse protection) comes before Phase 4
(sessions and country stats) because it is what makes a public launch safe, and
it only depends on the Phase 3 tables.

Items marked **DECISION** have a proposed default. Use the default unless the
owner says otherwise, and put every default you used in your summary.

---

## 0. Setup (do once, before Phase 3)

1. Confirm you are pointed at the **dev** Supabase project (ask the owner for the
   project ref if `supabase/config.toml` doesn't say). Production is off limits.
2. `supabase init` (if `supabase/` has no `config.toml`), `supabase link --project-ref <dev>`,
   then `supabase db pull` to baseline the existing schema into a migration.
3. Inspect the baseline. Record in your summary: the type of `strokes.user_id`,
   all existing policies, and existing indexes. The owner created `strokes`
   and its policies by hand and they are known to be too loose (an open
   delete policy, and an update policy that lets owners edit any column).
   Phase 6 replaces them.
4. If dev has no data, seed ~200 random valid strokes with a script
   (`scripts/seed-dev.mjs`) so the load and RLS tests are meaningful.

---

## Phase 3: schema

### Tables

All in `public`, all with RLS **enabled** and no policy unless stated.

**`players`** (the plan's `users` table; renamed to avoid confusion with `auth.users`)

| column | type | notes |
|---|---|---|
| `id` | uuid pk | `references auth.users(id) on delete cascade` |
| `name` | text not null | default `'Guest'`; validated in Phase 6 |
| `created_at` | timestamptz not null default now() | |
| `last_country` | char(2) null | ISO 3166-1 alpha-2, uppercase, or null |
| `banned` | boolean not null default false | |
| `banned_at` / `ban_reason` | timestamptz / text null | |

- Create the row automatically with a trigger on `auth.users` insert
  (`security definer`, `set search_path = ''`). **Do not** require the client to
  create it, and **do not add a foreign key from `strokes.user_id` to `players`**
  (see invariant 1 in `AGENTS.md`: an FK failure would permanently drop a user's stroke).
- Backfill: insert a `players` row for every distinct existing `strokes.user_id`
  that exists in `auth.users`.
- Policies: `select` own row only (`id = auth.uid()`). No client insert/update/delete.
  Name changes go through an RPC (Phase 6).

**`sessions`**

| column | type |
|---|---|
| `id` | uuid pk default gen_random_uuid() |
| `user_id` | uuid not null references `players(id)` on delete cascade |
| `country_code` | char(2) null |
| `login_time` | timestamptz not null default now() |
| `last_seen` | timestamptz not null default now() |

- **No client access at all** (no policies, and `revoke all ... from anon, authenticated`).
  Sessions are written only by the Phase 4 server function using the service role,
  and read only through the aggregate RPCs in Phase 4. This replaces the plan's
  "users update their own session row" with something stricter: the client can never
  fake `last_seen` or playtime.
- Indexes: `(user_id)`, `(country_code)`, `(last_seen)`.
- No `logout_time` and no `duration_seconds`. Playtime is `last_seen - login_time`.
- View `session_durations(session_id, user_id, country_code, login_time, last_seen, playtime)`.
  **Revoke all privileges on the view from `anon` and `authenticated`.** It is for
  internal aggregation only.

**`strokes`** (already exists; **alter, do not recreate**)

Add, with `add column if not exists`:
- `hidden_reason text null check (hidden_reason in ('undo','reports','admin'))`
- `report_count int not null default 0`
- `reviewed boolean not null default false` (admin has looked; auto-hide ignores it from then on)

Indexes: keep or create `(created_at desc, id desc) where hidden = false`
(history load and reconnect catch-up both depend on it). Add
`(user_id, created_at desc)` for per-user rate limits.

**`reports`**

`id` uuid pk, `stroke_id` uuid references `strokes(id)` on delete cascade,
`reporter_id` uuid references `players(id)` on delete cascade,
`created_at` timestamptz default now(), **unique `(stroke_id, reporter_id)`**.
No client access; writes only through the Phase 6 RPC.

**`snapshots`** (used in Phase 5; create it now)

`id` uuid pk, `image_path` text not null (Supabase Storage path),
`created_at` timestamptz default now(),
`last_stroke_created_at` timestamptz not null. **Use a timestamp, not a stroke id**:
stroke ids are random UUIDs, so they can't mark "everything after this point".
Public `select` is fine. No client writes.

### Acceptance (Phase 3)

- All migrations apply cleanly to a fresh dev project **and** to a dev project that
  already has `strokes` data.
- The existing app still draws, saves, loads and undoes against the migrated dev DB.
- Every new table has RLS enabled. Provide the output of
  `select relname, relrowsecurity from pg_class ...` for the new tables.

---

## Phase 6: keeping it clean

### 6.1 Replace the loose strokes policies

Drop the existing select/insert/update/delete policies on `strokes` and create:

- `select`: everyone (`anon, authenticated`) can read rows where `hidden = false`.
  Owners can also read their own hidden rows (`user_id = auth.uid()`). Without that,
  undo can fail with "new row violates row-level security policy".
- `insert`: `to authenticated`, `with check (user_id = auth.uid() and hidden = false)`.
- `update`: owner only (`using` and `with check` both `user_id = auth.uid()`),
  **restricted to one column**:

```sql
revoke update on public.strokes from anon, authenticated;
grant  update (hidden) on public.strokes to authenticated;
```

  plus a `BEFORE UPDATE` trigger that, for non-service roles, only allows
  `hidden` to change from `false` to `true` (set `hidden_reason = 'undo'`).
  An owner must never be able to un-hide a stroke that was hidden by reports or an
  admin, and must never be able to alter `points`, `color`, `width` or `user_name`.
- `delete`: **no policy.** The app never deletes. Remove any existing one.

### 6.2 Server-side validation and limits (BEFORE INSERT trigger on `strokes`)

Implement as one trigger function. Put all numeric limits in a single
`public.dabble_limits()` function (immutable, returns a row) so tuning is a
one-line migration, and mirror them in `src/lib/constants.js`.

On insert, in this order:

1. **Banned check.** If the player is banned, `raise exception ... using errcode = '42501'`.
2. **Overwrite, never trust:** `new.user_id := auth.uid()`; `new.hidden := false`;
   `new.report_count := 0`; `new.reviewed := false`;
   `new.user_name := (select name from public.players where id = auth.uid())`.
3. **Validate shape** (errcode `22023` = permanent):
   - `color` matches `^#[0-9a-fA-F]{6}$`
   - `width` between 1 and 40
   - `points` is a JSON array of **numbers only**, even length, 2 to 8000 entries,
     every value between 0 and 2000 (use `jsonb_array_elements` and check each)
   - `id` must not already exist (the client upserts with ignore-duplicates, so
     this is normally handled before the trigger; make sure a duplicate id never
     errors)
4. **Ink bucket (soft limit).** Table `ink_buckets(user_id pk, ink real, updated_at timestamptz)`,
   no client access, written only by this trigger.
   - Stroke cost = `path_length(points) * width / 800` (same formula as the client).
   - Refill = `INK_REFILL_PER_SEC` (12) per second since `updated_at`,
     capped at **server capacity = 1.5 x client `INK_MAX`** (the margin keeps
     legitimate users from ever being throttled by retry timing).
   - If cost > capacity -> errcode `22023` (can never succeed).
   - If cost > current ink -> errcode **`PT429`** (or `P0001` if PostgREST rejects the
     custom code). The client queue retries these with backoff, so the user never
     sees an error; the stroke simply lands a few seconds later.
   - Otherwise deduct and continue.
   - Use `insert ... on conflict do update` or `select ... for update` so concurrent
     inserts from one user can't both spend the same ink.
5. **Strokes per minute.** More than `MAX_STROKES_PER_MINUTE` (default **60**) rows for
   this user in the last 60 seconds -> errcode `PT429`.

**DECISION:** limits default to capacity 150, refill 12/s, 60 strokes/min.

### 6.3 Names

- Table `blocked_terms(term text pk, severity text check (severity in ('substring','whole_word')))`,
  no client access. **The owner supplies the word list.** You write the loader
  (`scripts/load-blocked-terms.mjs` reading a local, uncommitted `blocked-terms.txt`)
  and the matching logic, not the words.
- Function `is_name_allowed(text)`:
  - trim; length 1 to 24 characters
  - reject control characters, zero-width characters, and bidirectional override
    characters (`U+202A`-`U+202E`, `U+2066`-`U+2069`, `U+200B`-`U+200F`, `U+FEFF`)
  - normalise for matching: lowercase, Unicode NFKC, strip spaces and punctuation,
    map common look-alikes (`0->o`, `1->i/l`, `3->e`, `4->a`, `5->s`, `$->s`, `@->a`)
  - `substring` terms match anywhere in the normalised name; `whole_word` terms
    match only as a whole token of the original name. This avoids the
    "Scunthorpe problem" (blocking innocent names that contain a banned fragment).
- RPC `set_my_name(new_name text)` (`security definer`, `set search_path = ''`,
  executable by `authenticated` only): validates with `is_name_allowed`, rate-limits to
  5 renames per hour, updates `players.name`. Invalid name -> errcode `22023` with the
  message `name_not_allowed`.
- Client: call `set_my_name` right after anonymous sign-in (so the stored name matches
  the localStorage guest name) and on every rename. If rejected, keep the previous
  name and show "That name isn't available" under the name pill. Keep the existing
  local 24-character limit. The client check is only for UX; the server is the authority.
- Presence/broadcast names are client-supplied and cosmetic; saved strokes always use
  the server-stored name (6.2 step 2).

### 6.4 Reports and auto-hide

- RPC `report_stroke(p_stroke_id uuid)` (`security definer`, `set search_path = ''`,
  `authenticated` only):
  1. Reporter must not be banned, must not be the stroke's author, and their
     `players.created_at` must be at least `MIN_REPORTER_AGE` (default **10 minutes**).
     This stops someone creating 3 throwaway anonymous accounts to hide other
     people's drawings. If the check fails, return normally without doing anything
     (don't tell the caller why).
  2. Max 10 reports per reporter per minute.
  3. Insert into `reports` (ignore duplicates). If a row was inserted, increment
     `strokes.report_count`.
  4. If `report_count >= REPORTS_TO_HIDE` (default **3**) and `reviewed = false`
     and the stroke is visible -> set `hidden = true, hidden_reason = 'reports'`.
  5. Return `{ hidden: boolean }`.
- **DECISION:** `REPORTS_TO_HIDE = 3`, `MIN_REPORTER_AGE = 10 minutes`.

### 6.5 Admin

- Admin identity: a Supabase user with `app_metadata.role = 'admin'`. `app_metadata`
  can only be set by the service role or the dashboard, never by the user
  (do **not** use `user_metadata`). The owner sets it manually once; document the
  exact step in your summary. Function `is_admin()` checks
  `auth.jwt() -> 'app_metadata' ->> 'role' = 'admin'` **and** that the token is not anonymous.
- Table `admin_audit_log(id, admin_id, action, target, detail jsonb, created_at)`;
  no client access.
- RPCs, each `security definer`, each starting with `if not is_admin() then raise ...`,
  each writing an audit row:
  `admin_list_flagged(p_limit, p_offset)` (reported or hidden strokes, newest first,
  with report counts), `admin_list_recent(p_limit, p_before)`,
  `admin_hide_stroke(id)`, `admin_restore_stroke(id)` (sets `reviewed = true`),
  `admin_ban_player(user_id, hide_strokes bool, reason)`, `admin_unban_player(user_id)`.
- Admin UI at `/admin`, **lazy-loaded** so it adds nothing to the main bundle
  (`React.lazy` or a separate entry). It uses its **own Supabase client with a
  different `auth.storageKey`** (for example `doodlescrap-admin`) so signing in as admin never
  replaces the visitor's anonymous session. Sign-in via email magic link.
  Features: list flagged strokes rendered on small canvases (reuse `drawStroke`),
  author name and report count, buttons Hide / Restore / Ban author (with confirm),
  and a "recent strokes" feed. Add `<meta name="robots" content="noindex">`.
- After an admin hides a stroke, the admin client **sends a `stroke_remove` broadcast**
  on the normal channel with `{ id, userId: <stroke's real user_id> }`. The existing
  receiver already verifies against the database before removing, so no client change
  is needed for live viewers to see it vanish.
- Honest limitation to document: bans are by anonymous account id, so a banned person can
  get a new one. They are a speed bump. The real defences are the server limits above and
  the optional CAPTCHA below.

### 6.6 Client changes

1. **Report UI.** Add a "report" mode (toolbar button, or long-press on touch):
   tap a stroke -> a small popover shows the author's name and a Report button.
   Hit-testing: find the nearest stroke polyline within `width/2 + 6 screen px`
   of the tap, checking newest first. Put the hit-test in `src/engine/hitTest.js` with
   unit tests. Don't iterate all strokes on every pointer move, only on tap.
2. After reporting, hide that stroke **locally for the reporter** immediately
   (a `Set` of ids persisted in `localStorage`, filtered in the paper cache rebuild),
   regardless of whether the server hit the threshold.
3. **Incoming flood protection** in `useRealtimeCanvas.js` (broadcasts can't be validated
   by the database, so receivers must protect themselves):
   - cap concurrent remote live strokes in `strokeStore.startLive` at 200 (ignore new
     ones beyond that)
   - per sender key, allow at most 12 `stroke_start` per 10 seconds and
     at most 12 000 live point-numbers per minute; silently drop the excess
   - never throw on dropped messages
4. Banned feedback (optional, quiet): after sign-in read own `players.banned`; if true,
   show a small muted notice and stop broadcasting. Don't show alarming errors.
5. Make sure a rejected insert with `PT429`/`P0001` is **not** treated as permanent
   by `persistQueue.js` (re-check `isPermanent`), and that `22023`/`42501` are.

### 6.7 Optional hardening (needs the owner)

- Turn on CAPTCHA protection for anonymous sign-ins (Supabase Auth settings, Cloudflare
  Turnstile or hCaptcha). Agent work: pass `captchaToken` to `signInAnonymously` in
  `src/lib/supabase.js` and add the Turnstile widget in invisible mode. Owner work:
  create the Turnstile site/secret keys and paste the secret in the Supabase dashboard.
- Check the project's Auth rate limits for anonymous sign-ins per IP and tighten if needed.

### Acceptance tests (Phase 6)

Write `tests/rls.test.mjs` (Node, `@supabase/supabase-js`, against **dev**). It creates
**two anonymous users** (A and B) and asserts:

| # | Action | Expected |
|---|---|---|
| 1 | A inserts a valid stroke | succeeds; `user_id` is A even if the client sent B's id |
| 2 | A inserts with `hidden = true` | stored as `hidden = false` |
| 3 | A inserts with points out of range / odd length / non-numeric / 8001 numbers | rejected, errcode `22023` |
| 4 | A inserts a stroke costing more than server capacity | rejected, `22023` |
| 5 | A inserts 100 strokes in a tight loop | some rejected with `PT429`/`P0001` (and none with a permanent code) |
| 6 | A sets `hidden = true` on own stroke | succeeds, `hidden_reason = 'undo'` |
| 7 | A sets `hidden = false` on own hidden stroke | still hidden |
| 8 | A updates `points` / `color` / `user_name` on own stroke | rejected or no change |
| 9 | B tries to update or hide A's stroke | no rows affected |
| 10 | A or B tries `delete` on any stroke | no rows affected |
| 11 | A or B selects from `sessions`, `reports`, `ink_buckets`, `blocked_terms`, `admin_audit_log`, `session_durations` | permission error or empty |
| 12 | `set_my_name` with a blocked term (use a test term you insert yourself in dev), a name with a zero-width char, a 25-char name | rejected |
| 13 | B reports A's stroke (B younger than `MIN_REPORTER_AGE`) | no effect |
| 14 | Three aged reporters report A's stroke | stroke becomes hidden, `hidden_reason = 'reports'` |
| 15 | A reports own stroke / reports twice | no effect |
| 16 | A (non-admin) calls any `admin_*` RPC | rejected |
| 17 | Anonymous user calls any `admin_*` RPC even with a fake `role` in `user_metadata` | rejected |
| 18 | `anon` role (no sign-in) tries to insert a stroke | rejected |

To make 13 and 14 testable, add a **dev-only** helper (clearly named, never in a
production migration) that back-dates a test player's `created_at`.

---

## Phase 4: sessions, country and live stats

### 4.1 Vercel Functions (`api/`)

Plain Vercel Functions in `/api` (Node runtime is fine; it does not have to be an
"edge" runtime). They use `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from
**server-only** environment variables (no `VITE_` prefix; the owner sets them in the
Vercel dashboard). The service-role client is created inside the function only.

Both functions:
- accept `POST` JSON; reject anything else with 405
- authenticate the caller: read the token from `Authorization: Bearer <access_token>`,
  **or from `body.access_token`** (needed because `navigator.sendBeacon` cannot set
  headers), then verify it with `supabase.auth.getUser(token)`; never trust a
  `user_id` sent in the body
- return minimal JSON and never log request headers, IPs or tokens
- read country from `x-vercel-ip-country` (also accept `cf-ipcountry` in case of a
  host change); accept it only if it matches `^[A-Z]{2}$` and is not `XX`/`T1`, else `null`.
  In local dev the header is absent, so country is `null`; that must work.

**`POST /api/session`** (called once on page load, after anonymous sign-in)
1. Verify user. Upsert `players.last_country` if country is non-null.
2. Find the user's newest session. If `last_seen > now() - 5 minutes`, reuse it and
   bump `last_seen`; otherwise insert a new session with the detected country.
3. Return `{ session_id, country }`.

**`POST /api/heartbeat`** body `{ session_id }`
1. Verify user. Look up the session by id **and** `user_id`.
2. If found and `last_seen > now() - 5 minutes`: set `last_seen = now()`, return `{ session_id }`.
3. If missing or stale: create a new session (same rules as above) and return its id.
   The client replaces its stored `session_id` with whatever is returned.
4. Rate-limit per user (at most about 6 calls per minute; return 429 beyond that).

### 4.2 Client (`src/lib/session.js`, `src/hooks/useSession.js`)

- After anonymous auth succeeds, call `/api/session`, keep `{session_id, country}` in memory.
- Heartbeat every **30 s** while `document.visibilityState === 'visible'`; pause when
  hidden; send one immediately when the tab becomes visible again.
- On `pagehide`, `navigator.sendBeacon('/api/heartbeat', blob)` with
  `{ session_id, access_token }`. It's best effort and just improves accuracy.
- Add the country to the Presence payload (`{ name, color, country }`) and extend
  `sanitizePresence` in `wire.js` to accept it only if it matches `^[A-Z]{2}$`.
  This is cosmetic (a client could lie about its flag). Counts and leaderboards
  use only the database values.
- Show a flag emoji (from the country code via regional-indicator characters)
  in front of remote cursor names in `overlay.js`. Skip when country is missing.
- Failures are silent: if `/api/session` fails, the canvas must work exactly as before.

### 4.3 Stats RPCs

All `security definer`, `set search_path = ''`, `revoke ... from public`, `grant execute`
to `authenticated` only.

- `get_live_stats()` -> `{ online, countries, top_countries: [{code, count}] }`, where online
  means sessions with `last_seen > now() - 60 seconds`, distinct by `user_id`, and
  `top_countries` is the top 5.
- `get_country_leaderboard(p_window text)` where `p_window in ('24h','7d','all')` ->
  top 20 countries by total playtime, with stroke count and distinct players per country.
  Country level only. **Never return individual users or session rows.**
- Both must be cheap: use the `(last_seen)` and `(country_code)` indexes. Include
  an `explain` check in your summary.

### 4.4 UI

- Replace the status pill text with `47 drawing · 12 countries` when stats are available.
  Online count still comes from Presence (instant); countries come from
  `get_live_stats()` polled every **20 s** while the tab is visible. If stats are
  unavailable, fall back to the current presence-only text. Don't flicker between the two.
- The leaderboard panel is Phase 7. Only the RPC belongs here.

### 4.5 Privacy

- No IP addresses stored, logged, or put in the database. No third-party trackers.
- Add a one-paragraph note to `README.md` stating exactly what is stored
  (guest id, display name, country code, session start/last-seen times, strokes).
- Old sessions: add an optional `pg_cron` job (disabled by default) that
  deletes sessions older than 90 days. Describe it; don't enable it.

### Acceptance tests (Phase 4)

- Unit tests for the `api/` handlers with a mocked Supabase client: bad token -> 401;
  wrong method -> 405; country header absent/malformed -> `null`; stale session
  -> new session id; another user's `session_id` -> not updated.
- Manual script in the summary: run `vercel dev`, load the app twice with different
  `x-vercel-ip-country` values using a small test harness, and show `get_live_stats()` output.
- Confirm in the Network tab that no request body or response ever contains an IP.
- Confirm `SUPABASE_SERVICE_ROLE_KEY` does not appear in `dist/` (`grep -r` the build output
  and show the result).

---

## Decisions the owner needs to make (defaults in brackets)

1. Ink: server capacity 150, refill 12/s, 60 strokes/min. [as written]
2. Reports to auto-hide: 3 distinct reporters, each account at least 10 minutes old. [as written]
3. Blocked-name list: **owner supplies** `blocked-terms.txt` (one term per line, optionally
   `term<TAB>whole_word`). Not committed.
4. Admin sign-in: email magic link for one email address. [owner provides the address]
5. CAPTCHA for anonymous sign-in: yes/no. [recommended yes before any public launch]
6. Dev Supabase project ref and the Vercel project to deploy `api/` to.

## What the agent cannot do (owner does these by hand)

- Create the dev Supabase project and give the agent its ref and CLI access
- Set `app_metadata.role = 'admin'` on the owner's admin user (SQL editor or dashboard)
- Set Vercel environment variables (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`)
- Create Turnstile keys and paste the secret into Supabase Auth settings
- Review and approve applying migrations to production
