// Room Durable Object: seats, presence, host/kick, timers, wire handling.
//
// Hibernation API with SQLite-backed storage (wrangler new_sqlite_classes).
// Identity is trusted ONLY from the Worker-set headers on the upgrade
// request; client message fields are shape-checked and then overwritten
// from the connection attachment before anything is broadcast.
//
// Timers (seat hold, empty-room grace, max lifetime) are multiplexed onto
// one storage alarm; ping/pong auto-response is installed in the
// CONSTRUCTOR so it survives eviction (in the spike it was set inside
// fetch, which meant a literal ping could reach the JSON parser after a
// hibernation wake).
import {
  CLOSE_POLICY,
  CLOSE_TOO_BIG,
  KICK_CLOSE,
  MAX_PLAYERS,
  MAX_MSG_BYTES,
  MAX_ROOM_LIFETIME_MS,
  MAX_ROUND_STROKES,
  MAX_VIOLATIONS,
  MIN_PLAYERS,
  RATE_BUDGET,
  ROOM_GRACE_MS,
  SEAT_HOLD_MS,
  STORAGE_NOTICE_COOLDOWN_MS,
  WORD_OPTIONS,
  gameTimings,
  ipCapAllows,
  maxIpSockets,
} from './config.js'
import {
  advance,
  acceptPick,
  isDrawerPhase,
  newGameState,
  revealFrame,
  secretsAllowed,
  skipRound,
  startGame,
  stateFrame,
  targetedSecretsAllowed,
  toLobby,
  upgradeGameState,
  wordPickFrame,
  yourWordFrame,
} from './game.js'
import { logEvent } from './log.js'
import { countRoundPoints, recordRoundStroke, roundFits, roundKey, roundPrefix } from './round.js'
import { pickWords } from './words.js'
import { buildSnapshot, CLIENT_TYPES, STROKE_TYPES, parseEnvelope } from './wire.js'

const OPEN = 1 // WebSocket.OPEN

function groupOf(type) {
  if (type === 'cursor') return 'cursor'
  if (type === 'stroke_points') return 'stroke_points'
  return 'other'
}

function decodeName(header) {
  try {
    const name = decodeURIComponent(header || '')
    return name || 'Guest'
  } catch {
    return 'Guest'
  }
}

export class Room {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.room = null // lazily loaded; lost on hibernation, reloaded
    // Constructor, NOT fetch(): the runtime keeps auto-responses across
    // hibernation, and a wake-up must never route a literal ping to
    // webSocketMessage.
    try {
      state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    } catch {
      logEvent('autoresponse_failed')
    }
  }

  graceMs() {
    const n = Number(this.env.ROOM_GRACE_MS)
    return Number.isFinite(n) && n >= 0 ? n : ROOM_GRACE_MS
  }

  holdMs() {
    // Dev tests shorten this via env (like ROOM_GRACE_MS); production
    // env must not define SEAT_HOLD_MS and gets the config default.
    const n = Number(this.env.SEAT_HOLD_MS)
    return Number.isFinite(n) && n >= 0 ? n : SEAT_HOLD_MS
  }

  async load() {
    if (this.room === null) {
      this.room = (await this.state.storage.get('room')) || null
      // Rooms created before v2 Phase 3 (or before step 2) get their missing
      // game fields backfilled in memory; the next save() persists them.
      if (this.room) this.room.game = upgradeGameState(this.room.game)
    }
    return this.room
  }

  async save() {
    await this.state.storage.put('room', this.room)
  }

  // ---- Presence ----------------------------------------------------------

  /** Only CONNECTED players; seats that are merely held are never listed. */
  players(room) {
    const seen = new Map()
    for (const ws of this.state.getWebSockets()) {
      // A closing socket is still in getWebSockets() during its own
      // webSocketClose — it must never appear in a part/leave snapshot.
      if (ws.readyState !== OPEN) continue
      const a = ws.deserializeAttachment?.()
      // seat === null: transient sockets (kick close) that must never list.
      if (!a || a.seat === null || a.seat === undefined || seen.has(a.userId)) continue
      seen.set(a.userId, {
        userId: a.userId,
        seat: a.seat,
        name: a.name,
        country: a.country,
        host: a.userId === room.hostUserId,
      })
    }
    return [...seen.values()]
  }

  broadcast(obj, except = null) {
    // One gate for every public frame: the secret word may only leave in a
    // reveal. This is a code bug, not hostile input, so log and drop.
    if (!secretsAllowed(obj)) {
      logEvent('secret_blocked', { t: obj?.t })
      return
    }
    const msg = JSON.stringify(obj)
    let sent = 0
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue
      // Closing/CLOSED sockets throw "Can't call WebSocket send() after
      // close()" — hit under simultaneous disconnects; a throw here would
      // also skip alarm scheduling in handleDisconnect (the spike bug).
      if (ws.readyState !== OPEN) continue
      ws.send(msg)
      sent++
    }
    if (obj?.t === 'presence') logEvent('presence_bcast', { event: obj.event, sent, open: this.state.getWebSockets().length })
  }

  presence(room, event, userId, seat) {
    this.broadcast({ v: 1, t: 'presence', event, userId, seat, players: this.players(room) })
  }

  socketsFor(userId) {
    return this.state.getWebSockets().filter((ws) => ws.deserializeAttachment?.().userId === userId)
  }

  connectedAtts() {
    return this.state.getWebSockets()
      .filter((ws) => ws.readyState === OPEN)
      .map((ws) => ws.deserializeAttachment?.())
      .filter(Boolean)
  }

  // Count of live sockets. A socket inside its own webSocketClose is still in
  // getWebSockets() but is already CLOSING, so a raw length check would never
  // see an empty room and the grace alarm would never be scheduled.
  openSocketCount() {
    let n = 0
    for (const ws of this.state.getWebSockets()) if (ws.readyState === OPEN) n++
    return n
  }

  // ---- Timers (one alarm for everything) ---------------------------------

  async rearm() {
    const room = this.room
    if (!room) return
    const now = Date.now()
    const deadlines = [room.createdAt + MAX_ROOM_LIFETIME_MS]
    for (const s of Object.values(room.seats)) {
      if (s.heldUntil) deadlines.push(s.heldUntil)
    }
    if (this.openSocketCount() === 0 && room.lastEmptyAt) {
      deadlines.push(room.lastEmptyAt + this.graceMs())
    }
    if (room.game?.deadlineAt) deadlines.push(room.game.deadlineAt)
    if (room.game?.drawerGraceAt) deadlines.push(room.game.drawerGraceAt)
    try {
      await this.state.storage.setAlarm(Math.min(...deadlines))
    } catch {
      logEvent('alarm_set_failed')
      this.notifyBusy()
    }
  }

  /** Broadcast one `busy` error per cooldown; storage trouble is not fatal. */
  notifyBusy() {
    const now = Date.now()
    if (now - (this.lastBusyAt || 0) < STORAGE_NOTICE_COOLDOWN_MS) return
    this.lastBusyAt = now
    this.broadcast({ v: 1, t: 'error', reason: 'busy' })
    logEvent('busy_notice')
  }

  /** Save room metadata; a failure is logged/notified but never thrown. */
  async saveSafe(room) {
    try {
      await this.save()
      return true
    } catch {
      logEvent('room_save_failed')
      this.notifyBusy()
      return false
    }
  }

  async promoteHost(room, pendingUserId = null) {
    if (room.seats[room.hostUserId]) return false
    // Longest-connected = smallest seat claim time, among CONNECTED players
    // (pendingUserId counts when a join is mid-flight: the seat exists but
    // the socket is not accepted yet).
    const claimed = new Map()
    for (const a of this.connectedAtts()) {
      const s = room.seats[a.userId]
      if (s) claimed.set(a.userId, s.claimedAt)
    }
    if (pendingUserId && room.seats[pendingUserId]) {
      claimed.set(pendingUserId, room.seats[pendingUserId].claimedAt)
    }
    if (claimed.size === 0) return false
    let best = null
    for (const [uid, at] of claimed) if (best === null || at < claimed.get(best)) best = uid
    room.hostUserId = best
    logEvent('host_promoted')
    return true
  }

  async alarm() {
    const room = await this.load()
    if (!room) return
    const now = Date.now()
    logEvent('alarm_enter', { now, created: room.createdAt })

    if (now >= room.createdAt + MAX_ROOM_LIFETIME_MS) {
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.close(1001, 'room expired')
        } catch {}
      }
      logEvent('room_expired')
      await this.state.storage.deleteAll()
      this.room = null
      return
    }

    // Seat holds: release expired seats with a leave event.
    const released = []
    for (const [uid, seat] of Object.entries(room.seats)) {
      if (seat.heldUntil && now >= seat.heldUntil) {
        released.push({ uid, seat })
        delete room.seats[uid]
      }
    }
    if (released.length) {
      let hostChanged = false
      if (released.some((r) => r.uid === room.hostUserId)) {
        hostChanged = await this.promoteHost(room)
      }
      await this.saveSafe(room)
      for (const r of released) this.presence(room, 'leave', r.uid, r.seat.seat)
      if (hostChanged) this.presence(room, 'host', room.hostUserId, room.seats[room.hostUserId]?.seat ?? null)
      logEvent('seats_released', { n: released.length })
    }

    // Empty-room grace.
    if (
      this.openSocketCount() === 0 &&
      room.lastEmptyAt &&
      now >= room.lastEmptyAt + this.graceMs()
    ) {
      logEvent('room_grace_expired')
      await this.state.storage.deleteAll()
      this.room = null
      return
    }

    await this.gameTick(room, now)
    await this.rearm()
  }

  // ---- Upgrade / create --------------------------------------------------

  async fetch(request) {
    const userId = request.headers.get('X-User')
    if (!userId) return new Response('no user', { status: 401 })

    // Create is recognised by METHOD + PATH, never by a header: only the
    // Worker constructs this internal URL, so clients cannot reach it and
    // a client-supplied X-Action can never trigger a creation.
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/create') {
      const existing = await this.load()
      if (existing) return new Response('exists', { status: 409 })
      const now = Date.now()
      this.room = {
        createdAt: now,
        hostUserId: userId,
        nextSeat: 0,
        seats: {},
        blocked: {},
        lastEmptyAt: now, // an unjoined room dies with the empty-room grace
        game: newGameState(),
      }
      await this.save()
      await this.rearm()
      return new Response('created', { status: 201 })
    }

    const isJoin = request.method === 'GET' && url.pathname === '/ws'
    if (isJoin && request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('upgrade required', { status: 426 })
    }
    if (request.method === 'GET' && url.pathname === '/status') {
      return this.probe(await this.load(), userId, request.headers.get('X-IP-Hash'))
    }
    if (!isJoin) return new Response('not found', { status: 404 })

    // Proof the Worker never forwards the JWT: booleans only, never values.
    const jwtLike = [...request.headers.values()].some((v) => /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\./.test(v))
    const proto = request.headers.get('X-Protocol') || ''
    const hasProtoHeader = request.headers.get('Sec-WebSocket-Protocol') !== null

    const room = await this.load()
    if (!room) {
      // Never created (or already gone): clean 404 BEFORE the upgrade.
      logEvent('probe_404')
      return new Response('no such room', { status: 404 })
    }

    const ipHash = request.headers.get('X-IP-Hash') || null
    const acceptHeaders = proto ? { 'Sec-WebSocket-Protocol': proto } : undefined

    // Kicked: accept then close 4003 so the browser sees the app close code.
    if (room.blocked[userId]) {
      const [client, server] = Object.values(new WebSocketPair())
      this.state.acceptWebSocket(server)
      server.serializeAttachment({ userId, seat: null, name: '', country: null, ipHash, open: null, openK: null, v: 0, b: {} })
      server.close(KICK_CLOSE, 'kicked')
      logEvent('rejoin_blocked')
      return new Response(null, { status: 101, webSocket: client, headers: acceptHeaders })
    }

    const existingSeat = room.seats[userId]
    let seat = existingSeat ? existingSeat.seat : null

    if (!existingSeat && Object.keys(room.seats).length >= MAX_PLAYERS) {
      logEvent('room_full')
      return new Response(JSON.stringify({ error: 'room_full' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    }

    // Per-IP cap (default 4; prod must not override). Same-user sockets are
    // about to be replaced, so they don't count against the cap.
    const others = this.connectedAtts().filter((a) => a.userId !== userId)
    if (!ipCapAllows(others, ipHash, maxIpSockets(this.env))) {
      logEvent('ip_cap_rejected')
      return new Response(JSON.stringify({ error: 'too_many_connections' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    }

    // One socket per user: close the OLDER one (4009).
    for (const old of this.socketsFor(userId)) {
      try {
        old.close(4009, 'replaced')
      } catch {}
    }

    const now = Date.now()
    if (!existingSeat) {
      seat = room.nextSeat
      room.nextSeat += 1
      room.seats[userId] = { seat, claimedAt: now, heldUntil: null }
      logEvent('seat_claimed', { seat })
    } else {
      room.seats[userId].heldUntil = null // reconnect regains the seat
    }
    // Host whose seat is gone (released earlier with nobody connected to
    // promote at the time): promote now, longest-connected wins — the
    // newcomer's claimedAt is `now`, so existing players keep the host role.
    await this.promoteHost(room, userId)
    room.lastEmptyAt = null // a connection: cancel empty-room grace
    // The drawer coming back inside the grace window keeps the round alive.
    if (room.game.drawerGraceAt && room.game.drawerUserId === userId && isDrawerPhase(room.game.phase)) {
      room.game.drawerGraceAt = 0
      logEvent('drawer_grace_cleared')
    }
    await this.saveSafe(room)
    await this.rearm()

    const [client, server] = Object.values(new WebSocketPair())
    this.state.acceptWebSocket(server)
    server.serializeAttachment({
      userId,
      seat,
      name: decodeName(request.headers.get('X-User-Name')),
      country: /^[A-Z]{2}$/.test(request.headers.get('X-User-Country') || '')
        ? request.headers.get('X-User-Country')
        : null,
      ipHash,
      open: null, // stroke ownership: id of this connection's open stroke
      openK: null, // ...and its wire key, echoed if the socket dies first
      v: 0, // violation counter
      b: {}, // per-type rate buckets
    })

    const players = this.players(room)
    server.send(
      JSON.stringify({
        v: 1,
        t: 'welcome',
        seat,
        host: userId === room.hostUserId,
        players,
      })
    )
    // Every join gets the game state and the round, then whatever secret
    // frame that player is entitled to: word_pick/your_word for the drawer,
    // the public reveal during reveal/scores. The order on the wire is
    // welcome -> state -> snapshot -> (secret) -> presence, on every join.
    const game = room.game
    server.send(JSON.stringify(stateFrame(game, Date.now())))
    server.send(JSON.stringify(await this.snapshotFrame(room)))
    if (game.phase === 'pick' && game.drawerUserId === userId && game.options?.length) {
      server.send(JSON.stringify(wordPickFrame(game)))
    } else if (game.phase === 'drawing' && game.drawerUserId === userId && game.word) {
      server.send(JSON.stringify(yourWordFrame(game)))
    } else if (game.phase === 'reveal' || game.phase === 'scores') {
      server.send(JSON.stringify(revealFrame(game)))
    }
    this.presence(room, 'join', userId, seat) // others; new socket has welcome
    logEvent('join', { seat, host: userId === room.hostUserId, jwtLike: !!jwtLike, swp: hasProtoHeader ? 1 : 0 })
    return new Response(null, { status: 101, webSocket: client, headers: acceptHeaders })
  }

  // ---- Pre-join probe ------------------------------------------------------
  //
  // A browser WebSocket cannot read the HTTP status of a failed handshake, so
  // the room client asks for this route first and gets a readable answer.
  // Deliberately minimal: a connected-player count and a full flag, and
  // nothing else. No names, user ids, seats or countries ever leave here —
  // these visitors do not know each other yet, and a pre-join response is the
  // cheapest place on the server to leak them. This only predicts the join:
  // the real upgrade re-checks every rule, so a room that fills in between
  // fails generically on the client.
  probe(room, userId, ipHash) {
    const out = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (!room) return out(404, { error: 'not_found' })
    if (room.blocked[userId]) return out(403, { error: 'kicked' })

    const held = Object.keys(room.seats).length
    const full = !room.seats[userId] && held >= MAX_PLAYERS
    if (!full) {
      const others = this.connectedAtts().filter((a) => a.userId !== userId)
      if (!ipCapAllows(others, ipHash, maxIpSockets(this.env))) {
        return out(429, { error: 'too_many_connections' })
      }
    }
    return out(200, { players: this.players(room).length, full })
  }

  // ---- Messages ----------------------------------------------------------

  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment()
    if (!att) {
      ws.close(CLOSE_POLICY, 'no attachment')
      return
    }

    let size
    let text = null
    if (typeof message === 'string') {
      size = new TextEncoder().encode(message).length
      text = message
    } else {
      size = message.byteLength
    }
    if (size > MAX_MSG_BYTES) {
      logEvent('close_too_big')
      ws.close(CLOSE_TOO_BIG, 'message too big')
      return
    }
    if (text === null) {
      logEvent('close_binary')
      ws.close(CLOSE_POLICY, 'binary not allowed')
      return
    }

    const env = parseEnvelope(text)
    if (!env) {
      await this.violate(ws, att, 'bad_envelope')
      return
    }

    // Sustained per-type budget. DO messages are billed on arrival, so a
    // breach CLOSES the socket instead of dropping messages.
    const group = groupOf(env.t)
    const cfg = RATE_BUDGET[group]
    const now = Date.now()
    const bucket = att.b[group] || { tok: cfg.burst, last: now }
    bucket.tok = Math.min(cfg.burst, bucket.tok + ((now - bucket.last) / 1000) * cfg.perSec)
    bucket.last = now
    if (bucket.tok < 1) {
      att.b[group] = bucket
      ws.serializeAttachment(att)
      logEvent('close_rate_limit', { group })
      ws.close(CLOSE_POLICY, 'rate limit')
      return
    }
    bucket.tok -= 1
    att.b[group] = bucket

    const validator = CLIENT_TYPES[env.t]
    if (!validator) {
      ws.serializeAttachment(att)
      await this.violate(ws, att, 'unknown_type')
      return
    }
    const p = validator(env.p)
    if (!p) {
      ws.serializeAttachment(att)
      await this.violate(ws, att, 'invalid_payload')
      return
    }

    const room = await this.load()
    if (!room) {
      ws.close(CLOSE_POLICY, 'room gone')
      return
    }

    // Stroke ownership (one open stroke per connection, started here only).
    if (STROKE_TYPES.includes(env.t)) {
      const owned = this.checkOwnership(att, env.t, p)
      if (!owned) {
        ws.serializeAttachment(att)
        await this.violate(ws, att, 'stroke_ownership')
        return
      }
      ws.serializeAttachment(att)
    } else {
      ws.serializeAttachment(att)
    }

    if (env.t === 'kick') {
      await this.handleKick(room, att, p, ws)
      return
    }

    if (env.t === 'start') {
      await this.handleStart(room, att, ws)
      return
    }
    if (env.t === 'pick') {
      await this.handlePick(room, att, p, ws)
      return
    }

    // Identity is overwritten from the attachment; only whitelisted fields
    // are forwarded — a client object is never spread into a broadcast.
    if (env.t === 'stroke_start') {
      this.broadcast(
        { v: 1, t: 'stroke_start', k: p.k, id: p.id, userId: att.userId, userName: att.name, color: p.color, width: p.width, b: p.b, pts: p.pts },
        ws
      )
      return
    }
    if (env.t === 'stroke_points') {
      this.broadcast({ v: 1, t: 'stroke_points', k: p.k, id: p.id, seq: p.seq, pts: p.pts }, ws)
      return
    }
    if (env.t === 'stroke_end') {
      const s = p.stroke
      const stroke = { id: s.id, userId: att.userId, userName: att.name, color: s.color, width: s.width, b: s.b, points: s.points }
      // Store BEFORE broadcasting: a client that saw the live frame is then
      // guaranteed the snapshot has it too (no race where a join in between
      // gets a snapshot missing the stroke it never saw live). A storage
      // failure never stops the live relay — it only flags the round partial.
      await this.storeRoundStroke(room, stroke)
      this.broadcast({ v: 1, t: 'stroke_end', k: p.k, stroke }, ws)
      return
    }
    if (env.t === 'stroke_cancel') {
      this.broadcast({ v: 1, t: 'stroke_cancel', k: p.k, id: p.id }, ws)
      return
    }
    if (env.t === 'cursor') {
      this.broadcast({ v: 1, t: 'cursor', k: p.k, x: p.x, y: p.y, userId: att.userId }, ws)
      return
    }
  }

  // ---- Game lifecycle -------------------------------------------------------

  seatedUserIds(room) {
    return Object.entries(room.seats)
      .sort((a, b) => a[1].seat - b[1].seat)
      .map(([uid]) => uid)
  }

  isConnected(userId) {
    return !!userId && this.socketsFor(userId).some((ws) => ws.readyState === OPEN)
  }

  connectedSocket(userId) {
    return this.socketsFor(userId).find((ws) => ws.readyState === OPEN) || null
  }

  sendFrame(ws, obj) {
    if (!ws || ws.readyState !== OPEN) return
    if (!targetedSecretsAllowed(obj)) {
      logEvent('secret_blocked', { t: obj?.t })
      return
    }
    try {
      ws.send(JSON.stringify(obj))
    } catch {}
  }

  async handleStart(room, att, ws) {
    const game = room.game
    if (att.userId !== room.hostUserId) {
      logEvent('start_ignored', { reason: 'not_host' })
      return
    }
    if (game.phase !== 'lobby' && game.phase !== 'game_over') {
      logEvent('start_ignored', { reason: 'phase' })
      return
    }
    const players = this.seatedUserIds(room)
    if (players.length < MIN_PLAYERS) {
      logEvent('start_ignored', { reason: 'too_few', players: players.length })
      return
    }

    // Clear the previous game's last round first: gameSeq/round change below.
    await this.clearRoundStrokes(room)
    startGame(game, players, Date.now(), gameTimings(this.env), pickWords(WORD_OPTIONS))
    await this.saveSafe(room)
    await this.rearm()
    this.broadcast(stateFrame(game, Date.now()))
    this.sendFrame(ws, wordPickFrame(game))
    logEvent('game_start', { players: players.length, rounds: game.rounds })
  }

  async handlePick(room, att, p, ws) {
    const game = room.game
    if (game.phase !== 'pick' || att.userId !== game.drawerUserId) {
      logEvent('pick_ignored', { reason: game.phase !== 'pick' ? 'phase' : 'not_drawer' })
      return
    }
    const word = acceptPick(game, p.i, Date.now(), gameTimings(this.env))
    if (!word) {
      logEvent('pick_ignored', { reason: 'invalid' })
      return
    }
    await this.saveSafe(room)
    await this.rearm()
    this.broadcast(stateFrame(game, Date.now()))
    this.sendFrame(ws, yourWordFrame(game))
    logEvent('word_picked', { round: game.round })
  }

  /**
   * One alarm step for the game. Drawer grace wins over the phase deadline so
   * a vanished drawer never stalls a round. Hints are catch-up steps inside
   * drawing; every other transition is one step.
   */
  async gameTick(room, now) {
    const game = room.game
    if (!game || game.phase === 'lobby') return
    const times = gameTimings(this.env)

    if (Object.keys(room.seats).length < MIN_PLAYERS) {
      await this.abortGame(room, now)
      return
    }

    if (game.drawerGraceAt && now >= game.drawerGraceAt) {
      game.drawerGraceAt = 0
      if (!this.isConnected(game.drawerUserId) && isDrawerPhase(game.phase)) {
        const from = game.phase
        skipRound(game, now, times)
        await this.afterGameStep(room, { from, to: game.phase, event: 'drawer_absent' }, times)
        return
      }
    }

    if (!game.deadlineAt || now < game.deadlineAt) return

    const from = game.phase
    // Clear before advance(): the prefix must be the round being left.
    if (from === 'scores' && game.round < game.rounds) await this.clearRoundStrokes(room)
    if (from === 'game_over') await this.clearRoundStrokes(room)

    const res = advance(game, now, times, pickWords(WORD_OPTIONS))
    await this.afterGameStep(room, res, times)
  }

  async afterGameStep(room, res, times) {
    const game = room.game
    const now = Date.now()
    // A player who is in the order but not connected still gets a fresh grace
    // window when their turn starts; if they do not return, the round is
    // skipped with an empty reveal instead of waiting out the whole phase.
    if (res.to === 'pick' && !this.isConnected(game.drawerUserId)) {
      game.drawerGraceAt = now + times.drawerGrace
    }
    await this.saveSafe(room)
    await this.rearm()
    this.broadcast(stateFrame(game, now))
    if (res.to === 'reveal') this.broadcast(revealFrame(game))
    if (res.to === 'drawing' && res.from === 'pick') this.sendFrame(this.connectedSocket(game.drawerUserId), yourWordFrame(game))
    if (res.to === 'pick' && res.from === 'scores') this.sendFrame(this.connectedSocket(game.drawerUserId), wordPickFrame(game))
    logEvent('game_phase', { from: res.from, to: res.to, event: res.event, round: game.round })
  }

  async abortGame(room, now) {
    const game = room.game
    if (!game || game.phase === 'lobby') return
    const from = game.phase
    await this.clearRoundStrokes(room)
    toLobby(game)
    await this.saveSafe(room)
    await this.rearm()
    this.broadcast(stateFrame(game, Date.now()))
    logEvent('game_aborted', { from, seated: Object.keys(room.seats).length })
  }

  /**
   * Best-effort clear of one round's keys. Only the round being left is
   * listed: a failed delete orphans keys under an old prefix, which is far
   * safer than a stale stroke appearing in the next round. Never deleteAll.
   */
  async clearRoundStrokes(room) {
    const prefix = roundPrefix(room.game.gameSeq, room.game.round)
    try {
      const listed = await this.state.storage.list({ prefix })
      if (listed.size) await this.state.storage.delete([...listed.keys()])
      logEvent('round_cleared', { n: listed.size })
    } catch {
      logEvent('round_clear_failed')
      this.notifyBusy()
    }
  }

  // ---- Round storage (rs: keys + snapshot) ---------------------------------

  /**
   * Persist one completed stroke under its round key, respecting the round
   * caps. Returns true if it was stored. The fit check and the seq bump are
   * synchronous (no await between them), so two strokes ending on different
   * sockets can never take the same key. On breach (or a storage failure) the
   * round becomes partial: live drawing continues, nothing more is stored, and
   * snapshots carry partial: true so the client knows it may be incomplete.
   */
  async storeRoundStroke(room, stroke) {
    const state = room.game
    const text = JSON.stringify(stroke)
    const bytes = new TextEncoder().encode(text).length
    const points = countRoundPoints(stroke.points)

    if (!roundFits(state, bytes, points)) {
      if (!state.partial) {
        state.partial = true
        logEvent('round_storage_full', { count: state.count, bytes: state.bytes })
        await this.saveSafe(room)
      }
      return false
    }

    recordRoundStroke(state, bytes, points) // sync: claims the seq before any await
    try {
      await this.state.storage.put(roundKey(state.gameSeq, state.round, state.seq), stroke)
    } catch {
      state.partial = true
      logEvent('round_store_failed')
      this.notifyBusy()
      return false
    }
    await this.saveSafe(room)
    return true
  }

  /** The current round as a snapshot frame. list() keys are zero-padded, so
   *  they arrive in paint order; the sort is a cheap defence against a future
   *  key format that would not. */
  async snapshotFrame(room) {
    const prefix = roundPrefix(room.game.gameSeq, room.game.round)
    const listed = await this.state.storage.list({ prefix, limit: MAX_ROUND_STROKES + 1 })
    const entries = [...listed.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    const stored = entries.map(([, v]) => v)
    const frame = buildSnapshot(room.game.round, room.game.partial, stored)
    if (frame.strokes.length !== stored.length) {
      logEvent('snapshot_dropped_invalid', { dropped: stored.length - frame.strokes.length })
    }
    return frame
  }

  checkOwnership(att, type, p) {
    if (type === 'stroke_start') {
      if (att.open) return false // max one open stroke per connection
      att.open = p.id
      att.openK = p.k // echoed in stroke_cancel if this socket dies mid-stroke
      return true
    }
    const id = type === 'stroke_end' ? p.stroke.id : p.id
    if (att.open !== id) return false
    if (type === 'stroke_end' || type === 'stroke_cancel') {
      att.open = null
      att.openK = null
    }
    return true
  }

  async violate(ws, att, reason) {
    att.v += 1
    ws.serializeAttachment(att)
    logEvent('violation', { reason, n: att.v })
    if (att.v >= MAX_VIOLATIONS) {
      logEvent('close_violations')
      ws.close(CLOSE_POLICY, 'too many violations')
    }
  }

  async handleKick(room, att, p, ws) {
    if (att.userId !== room.hostUserId) {
      await this.violate(ws, att, 'kick_not_host')
      return
    }
    const target = p.userId
    if (target === att.userId) {
      ws.send(JSON.stringify({ v: 1, t: 'kick_err', reason: 'self' }))
      return
    }
    const seat = room.seats[target]
    if (!seat || room.blocked[target]) {
      ws.send(JSON.stringify({ v: 1, t: 'kick_err', reason: 'not_found' }))
      return
    }
    room.blocked[target] = true
    delete room.seats[target] // released immediately: they cannot return
    // A kicked drawer gets the same grace path as a disconnect; they cannot
    // reconnect, so the round is skipped when it expires.
    if (isDrawerPhase(room.game.phase) && room.game.drawerUserId === target) {
      room.game.drawerGraceAt = Date.now() + gameTimings(this.env).drawerGrace
    }
    const wasHost = target === room.hostUserId
    const hostChanged = wasHost ? await this.promoteHost(room) : false
    await this.saveSafe(room)
    await this.rearm()

    for (const s of this.socketsFor(target)) {
      try {
        s.close(KICK_CLOSE, 'kicked')
      } catch {}
    }
    this.presence(room, 'leave', target, seat.seat)
    if (hostChanged) this.presence(room, 'host', room.hostUserId, room.seats[room.hostUserId]?.seat ?? null)
    ws.send(JSON.stringify({ v: 1, t: 'kick_ack', userId: target }))
    logEvent('kick', { host_promoted: hostChanged })

    // A kick that leaves fewer than two seats ends the game immediately.
    if (Object.keys(room.seats).length < MIN_PLAYERS && room.game.phase !== 'lobby') {
      await this.abortGame(room, Date.now())
    }
  }

  // ---- Disconnect --------------------------------------------------------

  async webSocketClose(ws) {
    await this.handleDisconnect(ws)
    // Complete the close handshake: when the CLIENT initiates the close,
    // workerd waits for the DO to close the hibernation socket before the
    // client sees its close event (observed ~14 s stall without this).
    try {
      ws.close(1000, 'bye')
    } catch {}
  }

  async webSocketError(ws) {
    await this.handleDisconnect(ws)
  }

  async handleDisconnect(ws) {
    const att = ws.deserializeAttachment?.()
    const room = await this.load()
    logEvent('disconnect_enter', { hasAtt: !!att, hasRoom: !!room, open: this.state.getWebSockets().length })
    if (!room || !att) return

    // The artist vanished mid-stroke (close, replace-4009, kick): tell the
    // others to drop the dangling line. Deliberately OUTSIDE the
    // remaining-count logic below: on a 4009 replace the same user's NEW
    // socket is already connected, so remaining !== 0. If webSocketClose
    // and webSocketError both fire this can duplicate — cancels are
    // idempotent for clients.
    if (att.open && att.openK) {
      this.broadcast({ v: 1, t: 'stroke_cancel', k: att.openK, id: att.open }, ws)
    }

    let remaining = 0
    for (const w of this.state.getWebSockets()) {
      if (w === ws) continue
      const a = w.deserializeAttachment?.()
      if (a && a.userId === att.userId) remaining++
    }
    if (remaining === 0) {
      const seat = room.seats[att.userId]
      if (seat && !seat.heldUntil) {
        // Seat is held for SEAT_HOLD_MS so a reconnect regains it. Guard on
        // heldUntil: webSocketClose and webSocketError can both fire for one
        // socket, and a reconnect clears heldUntil before the old close
        // handler runs (the remaining count above already excludes the
        // closing socket).
        seat.heldUntil = Date.now() + this.holdMs()
        await this.saveSafe(room)
        logEvent('seat_held', { until: seat.heldUntil, hold: this.holdMs() })
        this.presence(room, 'part', att.userId, seat.seat)
      } else if (!seat) {
        // Seat already gone (kicked, or released): presence already covered.
        logEvent('disconnect', { held: 0 })
      }

      // The drawer left the table: hold the round for a short grace window,
      // then skip it. Reconnecting inside the window clears this in fetch().
      if (seat && isDrawerPhase(room.game.phase) && room.game.drawerUserId === att.userId) {
        room.game.drawerGraceAt = Date.now() + gameTimings(this.env).drawerGrace
        await this.saveSafe(room)
        logEvent('drawer_grace_start')
      }
    }

    if (this.openSocketCount() === 0) {
      room.lastEmptyAt = room.lastEmptyAt || Date.now()
      await this.saveSafe(room)
    }
    await this.rearm()
  }
}
