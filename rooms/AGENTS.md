# Rooms server rules (DoodleScrap v2)

`rooms/` is the real-time room server: a Cloudflare Worker + Durable Objects
project, plain JS ESM, independent of the Vercel app. It deploys to the **dev**
workers `dabble-rooms-dev` and `dabble-rooms-dev-fast` only; neither is production.

- Work only inside `rooms/`. `src/`, `api/`, `supabase/migrations`,
  `vercel.json` and the root `package.json` are not touched by rooms work.
- Wrangler v4 lives in `rooms/package.json` only. `wrangler.toml` defines an
  `[env.production]` with placeholder URLs/origins: never put real production
  values in it, and never `wrangler deploy --env production` without the
  owner naming the migration/deploy in the task.
- Secrets (`IP_HASH_SALT`, optional `TURNSTILE_SECRET`) go in Wrangler secret
  settings for the dev worker, never in a file, log, or message. The Supabase
  anon key is injected at deploy time from the shell, not committed.
- Auth is `Sec-WebSocket-Protocol: dabble.v1, <jwt>` only. The Worker verifies
  the JWT, strips the header, and the Durable Object never sees a token.
- Identity/name/country/ban come only from the `players` row fetched with the
  user's own JWT (fail open as "Guest" on Supabase errors, counted). Client
  messages never carry trusted identity.
- Worker -> DO requests are rebuilt from an allowlist in `rooms/src/forward.js`
  (handshake headers only + Worker-set `X-*`). Never forward the client's
  headers through: a client `X-Action` or `X-IP-Hash` would bypass creation
  limits and the per-IP caps. The DO recognises create only by internal
  method + path (`POST /create`), never by a header.
- Known gaps (accepted for now):
  1. Kick blocks are per account: another account (or device) can rejoin;
     the per-IP socket cap is the only cross-account limit.
  2. Unauthenticated request floods still spend Worker quota (route-level
     work happens before auth). Mitigating this needs a custom domain plus
     Cloudflare zone-level rate limiting later.
  3. The free plan daily quota is account-wide: dev load tests consume the
     same allowance as production.
  4. A player banned after connecting keeps their seat until they
     reconnect; bans are checked only at connect time (see
     `rooms/src/identity.js`).
  5. The dev Worker is public and honors `X-Test-IP`. When `ENVIRONMENT` is
     exactly `dev`, a request may supply an `X-Test-IP` header (validated
     charset, hashed with the same salt as a real IP) so tests can isolate
     clients. This must be deleted or restricted before any public launch.
- Room codes: 5 chars, alphabet without look-alikes. Code format is validated
  in the Worker before any Durable Object is touched; join attempts pass the
  Workers rate limiting bindings first.
- All limits live in `rooms/src/config.js`; the Worker and the DO both import
  it. Exceeding a message budget closes the socket (billed on arrival, so
  dropping saves nothing).
- Logging is event names and counts only: no tokens, IPs, names, room words,
  or free-form user data.
- Tests are Node scripts in `rooms/tests/`, run against the **fast dev** worker
  (dev Supabase project). Dev-only SQL helpers go in `supabase/dev/` and are
  shown to the owner before being applied to dev; never to production.

## Commands

Run from `rooms/`; Node 22 or newer is required for the live WebSocket suites.

```bash
npm ci
npm run dev
npm test
npm run tail
npx wrangler deploy --var "SUPABASE_ANON_KEY:$VITE_SUPABASE_ANON_KEY"
```

`npm run dev` starts Wrangler locally. `npm test` runs `tests/run.mjs` against
the fast dev worker; load the dev Supabase variables from `../.env` and set
`ROOMS_ALLOWED_URL=https://dabble-rooms-dev-fast.rowan-dev-workers.workers.dev`
as described in `README.md`. The deploy command above targets
`dabble-rooms-dev`; include the `--var` so identity checks remain enabled. The
fast worker is deployed separately with `npx wrangler deploy --env fast` and
requires the complete `--var` list from `wrangler.toml`. Never deploy production
unless the task explicitly names that deploy.
