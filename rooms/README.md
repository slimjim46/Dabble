# dabble-rooms

Real-time room server for Dabble v2: a Cloudflare Worker + Durable Objects
project, plain JS ESM. It is independent of the Vercel app in `../src` and
deploys to the **dev** worker `dabble-rooms-dev` only (see the rooms section of
`../AGENTS.md` for the rules that govern it).

- `src/index.js` — Worker fetch handler: routes, code validation, auth, rate
  limits, identity lookup, then forwards the upgrade to the room's Durable
  Object.
- `src/room.js` — the `Room` Durable Object: seats, strokes, chat, kicks, the
  hibernation-safe alarm/grace lifecycle.
- `src/forward.js` — the client→DO header allowlist used when rebuilding
  requests; the client's headers never pass through.
- `src/config.js` — every limit (Worker and DO both import it).
- `tests/` — Node test scripts run against the dev worker (dev Supabase).

## Run

```
set -a; source ../.env; set +a           # dev Supabase URL + anon key
export ROOMS_ALLOWED_URL=https://dabble-rooms-dev.rowan-dev-workers.workers.dev
npm test                                 # tests/run.mjs, per-suite child process
```

Requires `npm ci` first. `ROOMS_ALLOWED_URL` must equal the target the tests
connect to (the public dev URL); the guard exists so tests can never be pointed
at production.

## Known gaps

Accepted for now; each is a known limitation, not an oversight.

1. **Kick blocks are per account.** Another account (or device) can rejoin a
   room they were kicked from; the per-IP socket cap is the only cross-account
   limit.
2. **Unauthenticated request floods still spend Worker quota.** Route-level
   work happens before auth, so a flood of bad requests is billed before it is
   rejected. Mitigating this needs a custom domain plus Cloudflare zone-level
   rate limiting later.
3. **The free-plan daily quota is account-wide.** Dev load tests consume the
   same allowance as production.
4. **Bans are only checked at connect time.** A player banned after connecting
   keeps their seat until they reconnect; identity lookup fails open to
   `Guest` on Supabase errors (counted).
5. **The dev Worker is public and honors `X-Test-IP`.** When `ENVIRONMENT` is
   exactly `dev`, a request may supply an `X-Test-IP` header (validated
   charset, hashed with the same salt as a real IP) so tests can isolate
   clients. This must be deleted or restricted before any public launch.
