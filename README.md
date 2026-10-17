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
