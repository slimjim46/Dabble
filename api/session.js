import { makeHandler } from './_lib.js'

// POST /api/session — records one session per visit and returns its id.
export default makeHandler('session')
