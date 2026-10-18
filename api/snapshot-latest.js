// GET /api/snapshot-latest — 302 redirect to the newest snapshot's Open Graph
// image: the 1200x630 JPEG preview when there is one, the full PNG for rows
// written before previews existed, and a static default when the project has
// no snapshots at all.
//
// Reads with the ANON key. The snapshots table and the bucket are both
// public-read, so an endpoint that serves a public image has no business
// holding the service role key. Nothing here logs tokens or IPs.
import { createClient } from '@supabase/supabase-js'

// Bucket object keys are produced by our render job, but they still cross a
// trust boundary on the way into a Location header, so only a plain key is
// accepted — no slashes, no traversal, no control characters.
const OBJECT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function redirectTo(res, location) {
  res.status(302)
  res.setHeader('Location', location)
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60')
  res.end()
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' })
    return
  }

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) {
    redirectTo(res, '/og-default.png')
    return
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  try {
    const { data, error } = await supabase
      .from('snapshots')
      .select('image_path,preview_path')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const object = error ? null : (data?.preview_path || data?.image_path || null)
    if (object && OBJECT_KEY_RE.test(object)) {
      redirectTo(res, `${url}/storage/v1/object/public/snapshots/${object}`)
      return
    }
  } catch {
    // fall through to the default image
  }

  redirectTo(res, '/og-default.png')
}
