import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Open Graph scrapers do not run JavaScript, so og:image / twitter:image have
// to be absolute URLs in the built HTML — a relative one is dropped by every
// scraper that sees it. They can only be absolute if the owner sets
// VITE_SITE_URL for the build; when it is missing (or not an absolute URL) we
// remove the image tags instead of publishing a link that goes nowhere.
const OG_IMAGE_TAG = /<meta\s+[^>]*(?:property="og:image[^"]*"|name="twitter:image[^"]*")[^>]*>\s*\n?/g
const OG_IMAGE_ATTR = 'content="/api/snapshot-latest"'

// Vite injects the built entry script into <head>. The document we ship puts
// scripts in <body>, so pull the module tags back out of the head — a module
// script is deferred either way, so nothing changes except where it sits.
const MODULE_SCRIPT_TAG = /[ \t]*<script\b[^>]*type="module"[^>]*><\/script>[ \t]*\r?\n?/g

function scriptsToBody(html) {
  const tags = html.match(MODULE_SCRIPT_TAG)
  if (!tags || tags.length === 0) return html
  const without = html.replace(MODULE_SCRIPT_TAG, '')
  const close = '</body>'
  const at = without.lastIndexOf(close)
  if (at === -1) return html
  // Every index here belongs to `without`, never to `html`: dropping the head
  // tag shifts everything after it.
  const closeIndent = (without.slice(0, at).match(/[ \t]*$/) ?? [''])[0]
  const lineIndent = `${closeIndent}  `
  const lines = tags.map((t) => `${lineIndent}${t.trim()}`).join('\n')
  return `${without.slice(0, at - closeIndent.length)}${lines}\n${closeIndent}${without.slice(at)}`
}

function openGraphImage() {
  let siteUrl = ''
  return {
    name: 'dabble:og-image',
    configResolved(config) {
      const raw = String(config.env?.VITE_SITE_URL ?? '').trim().replace(/\/+$/, '')
      siteUrl = /^https?:\/\//i.test(raw) ? raw : ''
      if (raw && !siteUrl) {
        console.warn('[dabble] VITE_SITE_URL must be an absolute http(s) URL — og:image tags dropped')
      }
    },
    transformIndexHtml(html) {
      const withOg = siteUrl
        ? // split/join rather than replace: a URL must never be interpreted as a
          // replacement pattern ($& and friends).
          html.split(OG_IMAGE_ATTR).join(`content="${siteUrl}/api/snapshot-latest"`)
        : html.replace(OG_IMAGE_TAG, '')
      return scriptsToBody(withOg)
    },
  }
}

export default defineConfig({
  plugins: [react(), openGraphImage()],
})
