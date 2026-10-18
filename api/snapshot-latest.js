// GET /api/snapshot-latest — 302 redirect to the newest snapshot's Open Graph
// image: the 1200x630 JPEG preview when there is one, the full PNG for rows
// written before previews existed, and a static default when the project has
// no snapshots at all.
//
// Only rows with kind = 'live' are ever advertised: a link preview shows the
// board people can draw on right now, never a season that has already closed
// (see the snapshot_kind migration). With no live snapshot left the redirect
// goes to /og-default.png.
//
// Reads with the ANON key. The snapshots table and the bucket are both
// public-read, so an endpoint that serves a public image has no business
// holding the service role key. Nothing here logs tokens or IPs.
import { createClient } from '@supabase/supabase-js'

import { SNAPSHOT_KEY_RE } from '../src/lib/snapshotKey.js'

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
      .eq('kind', 'live')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const object = error ? null : (data?.preview_path || data?.image_path || null)
    if (object && SNAPSHOT_KEY_RE.test(object)) {
      redirectTo(res, `${url}/storage/v1/object/public/snapshots/${object}`)
      return
    }
  } catch {
    // fall through to the default image
  }

  redirectTo(res, '/og-default.png')
}
