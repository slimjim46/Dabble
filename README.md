# Dabble

A React app built with [Vite](https://vitejs.dev).

## Requirements

- Node.js 18+

## Getting started

```bash
./setup.sh      # installs dependencies
npm run dev     # start dev server
```

Then open the URL printed in the terminal (usually http://localhost:5173).

`npm run dev` serves the client only. The Phase 4 endpoints under `api/` are
Vercel Functions, so use `vercel dev` (with the Supabase env vars set) to
exercise sessions and heartbeats locally.

Clients cannot delete strokes, so test runs would fill the dev canvas with
scribbles. The end-to-end suites therefore call the dev-only helper
`dev_only_hide_all_strokes()` (see `supabase/dev/`) when they finish, which
hides whatever is visible and leaves the board clear.

## Privacy

Dabble is anonymous by design. When you visit we create an anonymous account
and store:

- a `players` row (a random id, the display name you chose, and the country of
  your most recent visit),
- `sessions` rows recording coarse activity (login time, last-seen time, and a
  two-letter country code from the CDN — never a city or an address),
- the strokes you draw, so everyone sees the same canvas.

We never store or log your IP address, and we never ask for an email, a
password, or an account. Country codes come from the platform's geo header and
are the only location data we keep. Sessions older than 90 days are deleted;
strokes that enough people report are hidden from the canvas.

## Canvas snapshots

Sending every stroke on every load is the free-tier bandwidth bottleneck, so a
scheduled job bakes the canvas into a single PNG. Clients can then load that one
image plus only the strokes newer than it, instead of thousands of rows.

`scripts/render-snapshot.mjs` runs every 10 minutes (`.github/workflows/snapshot.yml`)
against the `snapshots` storage bucket:

- Only strokes with `created_at <= now() - 10 minutes` (`SNAPSHOT_SETTLE`) are
  baked in. Anything newer stays a vector on the client, so your own undo keeps
  working immediately.
- Normal runs are incremental: the previous PNG is the base and only newer
  visible strokes are drawn on top. A full rebuild happens with `--full`, when
  the previous snapshot is older than 24 h, or when a stroke that was already
  baked in changed visibility (admin hide, report auto-hide, ban-with-hide, or
  an admin restore) — tracked by `strokes.hidden_at`.
- If nothing changed, nothing is uploaded. Only the newest 24 snapshots are
  kept; older rows and objects are deleted by exact id.
- `snapshots.last_stroke_created_at` records the newest baked stroke, which is
  what makes the next incremental run possible.

Local use (the service-role key is read from the environment only and is never
printed or committed):

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/render-snapshot.mjs [--full] [--dry-run]
```

### Storage estimate

Measured on the dev project: a stroke costs about **1.7 KB** including its JSON
points and indexes, so a 500 MB free-tier database holds roughly **250,000
strokes** before strokes alone become a problem. Snapshots are small by
comparison: a blank 2000×2000 PNG is ~19 KB, a busy one a few MB, and only 24
exist at a time (worst case ~50 MB of the 1 GB storage allowance).

### Archive plan (not built)

When the table approaches ~200,000 strokes, archive everything already baked
into the newest snapshot: export the rows (including hidden ones, for
moderation) to object storage as JSONL, then delete them from `public.strokes`.
Clients already see those strokes in the PNG, so nothing disappears; restore is
a re-import by stroke id. This is deliberately deferred — the table is fine for
now, and snapshot reads already keep the hot path small.

### GitHub Actions notes

- The cron both renders snapshots **and keeps the Supabase project from being
  paused** for inactivity on the free tier.
- A private repo gets ~2,000 free Actions minutes/month. At `*/10` that is
  ~4,000+ minutes, so switch the cron to `*/30` on a private repo.
- GitHub disables scheduled workflows after 60 days without repo activity; the
  next push re-enables them.
- The workflow targets whatever project `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` point at. Keep them on dev unless you deliberately
  want production snapshots.

## Scripts

| Command           | Description                    |
| ----------------- | ------------------------------ |
| `npm run dev`     | Start dev server with HMR      |
| `npm run build`   | Build for production           |
| `npm run preview` | Preview the production build   |

## Project structure

```
├── index.html        # Entry HTML
├── src/
│   ├── main.jsx      # React entry point
│   ├── App.jsx       # Root component
│   └── index.css     # Global styles
├── vite.config.js    # Vite config
└── setup.sh          # One-time setup script
```
