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
