import { makeHandler } from './_lib.js'

// POST /api/heartbeat — keeps the current session's last_seen fresh.
export default makeHandler('heartbeat')
