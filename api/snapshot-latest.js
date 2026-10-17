// GET /api/snapshot-latest — 302 redirect to the newest public snapshot image.
// Falls back to a default OG image if none exists. Never logs tokens or IPs.
import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' })
    return
  }

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    // Fallback to a default image in the app's static assets if configured.
    res.status(302).setHeader('Location', '/og-default.png')
    res.end()
    return
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  try {
    const { data, error } = await supabase
      .from('snapshots')
      .select('image_path')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!error && data?.image_path) {
      const location = `${url}/storage/v1/object/public/snapshots/${data.image_path}`
      res.status(302).setHeader('Location', location)
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60')
      res.end()
      return
    }
  } catch {}

  res.status(302).setHeader('Location', '/og-default.png')
  res.end()
}
