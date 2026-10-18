import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Open Graph scrapers do not run JavaScript, so og:image / twitter:image have
// to be absolute URLs in the built HTML — a relative one is dropped by every
// scraper that sees it. They can only be absolute if the owner sets
// VITE_SITE_URL for the build; when it is missing (or not an absolute URL) we
// remove the image tags instead of publishing a link that goes nowhere.
const OG_IMAGE_TAG = /<meta\s+[^>]*(?:property="og:image[^"]*"|name="twitter:image[^"]*")[^>]*>\s*\n?/g
const OG_IMAGE_ATTR = 'content="/api/snapshot-latest"'

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
      if (!siteUrl) return html.replace(OG_IMAGE_TAG, '')
      // split/join rather than replace: a URL must never be interpreted as a
      // replacement pattern ($& and friends).
      return html.split(OG_IMAGE_ATTR).join(`content="${siteUrl}/api/snapshot-latest"`)
    },
  }
}

export default defineConfig({
  plugins: [react(), openGraphImage()],
})
