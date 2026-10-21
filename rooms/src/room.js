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
  MAX_GUESSES_PER_ROUND,
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
  awardGuess,
  finishDrawingEarly,
  isDrawerPhase,
  judgeGuess,
  newGameState,
  normaliseGuess,
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
import { logDiag, logEvent } from './log.js'
import { countRoundPoints, recordRoundStroke, roundFits, roundKey, roundPrefix } from './round.js'
import { pickWords } from './words.js'
import { buildSnapshot, CLIENT_TYPES, STROKE_TYPES, parseEnvelope } from './wire.js'

const OPEN = 1 // WebSocket.OPEN

function groupOf(type) {
  if (type === 'cursor') return 'cursor'
  if (type === 'stroke_points') return 'stroke_points'
  if (type === 'guess') return 'guess'
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
    this.loading = null // the in-flight room load, shared by every caller
    this.socketChains = new WeakMap() // ws -> tail of that socket's work
    // ALARM_DIAG (dev only): a cold start means the DO was evicted and
    // re-instantiated. If a late alarm coincides with a do_start just before
    // it, the lateness is a platform wake, not a wrong stored deadline.
    if (env?.ALARM_DIAG === 'dev') {
      logDiag('do_start', { now: Date.now(), room: state.id?.toString?.() || null })
    }
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

  /**
   * The room state, loaded once.
   *
   * Two handlers that find the room unloaded would each read it from storage
   * and each get their OWN copy: they would then mutate different rooms and
   * the last save would win, silently dropping the other handler's changes
   * (a round sequence number claimed twice, a phase deadline, a drawer
   * grace). One in-flight load is shared by every caller instead, so there is
   * only ever one room in memory.
   */
  async load() {
    if (this.room === null) {
      if (!this.loading) {
        this.loading = this.state.storage.get('room').then((v) => {
          const room = v || null
          // Rooms created before v2 Phase 3 (or before step 2) get their missing
          // game fields backfilled in memory; the next save() persists them.
          if (room) room.game = upgradeGameState(room.game)
          return room
        })
        // A failed read must not poison the next load.
        this.loading.catch(() => {
          this.loading = null
        })
      }
      this.room = await this.loading
    }
    return this.room
  }

  /** The room is gone (expired or deleted): the next load reads it again. */
  invalidateRoom() {
    this.room = null
    this.loading = null
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

  // User ids of non-drawer seats with a live socket right now. Deduped (one
  // user may hold several sockets), and only seats that can actually guess.
  connectedNonDrawerIds(room) {
    const drawer = room?.game?.drawerUserId
    const seen = new Set()
    for (const ws of this.state.getWebSockets()) {
      if (ws.readyState !== OPEN) continue
      const a = ws.deserializeAttachment?.()
      if (!a || !a.userId || a.seat === null || a.seat === undefined) continue
      if (a.userId === drawer) continue
      seen.add(a.userId)
    }
    return [...seen]
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
    const deadlines = [[room.createdAt + MAX_ROOM_LIFETIME_MS, 'room_lifetime']]
    for (const s of Object.values(room.seats)) {
      if (s.heldUntil) deadlines.push([s.heldUntil, 'seat_hold'])
      // A held seat stops blocking an early finish at this earlier deadline,
      // while still keeping its seat: arm the alarm for whichever comes first.
      if (s.earlyFinishUntil) deadlines.push([s.earlyFinishUntil, 'early_finish'])
    }
    if (this.openSocketCount() === 0 && room.lastEmptyAt) {
      deadlines.push([room.lastEmptyAt + this.graceMs(), 'empty_grace'])
    }
    if (room.game?.deadlineAt) deadlines.push([room.game.deadlineAt, 'game_deadline'])
    if (room.game?.drawerGraceAt) deadlines.push([room.game.drawerGraceAt, 'drawer_grace'])

    let chosen = deadlines[0]
    for (const d of deadlines) if (d[0] < chosen[0]) chosen = d
    const [at, src] = chosen

    const diag = this.env?.ALARM_DIAG === 'dev'
    if (diag) {
      const prev = this.alarmMeta || null
      if (!prev || prev.at !== at || prev.src !== src) {
        logDiag('alarm_set', { now, at, src, prev_at: prev ? prev.at : null, prev_src: prev ? prev.src : null })
        this.alarmMeta = { at, src }
        try {
          await this.state.storage.put('alarmMeta', this.alarmMeta)
        } catch {}
      }
      // Defensive, LOG-ONLY: a deadline already passed AND already armed means
      // the alarm would re-fire immediately. That is the shape of the
      // re-armed-past-due loop this fix removes; log it so a regression is
      // visible. Behavior is unchanged: setAlarm still runs below, because
      // skipping it could leave the room with no alarm and stall it.
      if (at <= now && this.alarmMeta && this.alarmMeta.at === at && this.alarmMeta.src === src) {
        logDiag('alarm_past_due_rearm', { src, at, now })
      }
    }

    try {
      await this.state.storage.setAlarm(at)
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

  async alarm(alarmInfo) {
    const retryCount = alarmInfo?.retryCount ?? 0
    const isRetry = alarmInfo?.isRetry === true
    const alarmInfoPresent = alarmInfo != null
    try {
      await this.alarmHandler(retryCount, isRetry, alarmInfoPresent)
    } catch (err) {
      // ALARM_DIAG (dev only): a throwing alarm is retried with exponential
      // backoff (~2+4+8+16 s), which can look like platform lateness. Log and
      // RETHROW: behavior must not change (the runtime still owns the retry).
      if (this.env?.ALARM_DIAG === 'dev') {
        logDiag('alarm_error', {
          now: Date.now(),
          message: String(err?.message ?? err),
          stack: String(err?.stack ?? '').split('\n').slice(0, 3).join(' | '),
          retryCount,
        })
      }
      throw err
    }
  }

  async alarmHandler(retryCount, isRetry, alarmInfoPresent = false) {
    const room = await this.load()
    if (!room) return
    const now = Date.now()
    logEvent('alarm_enter', { now, created: room.createdAt })
    if (this.env?.ALARM_DIAG === 'dev') {
      const meta = this.alarmMeta || (await this.state.storage.get('alarmMeta')) || null
      logDiag('alarm_enter_diag', {
        now,
        deadline: meta ? meta.at : null,
        src: meta ? meta.src : null,
        lateness_ms: meta ? now - meta.at : null,
        // The DO is a plain class (not `extends DurableObject`), so the
        // runtime passes no alarmInfo: retry state is unavailable here. A
        // throwing attempt still shows up as a preceding alarm_error event.
        retry_state: alarmInfoPresent ? 'provided' : 'unavailable',
        retryCount,
        isRetry,
      })
    }

    if (now >= room.createdAt + MAX_ROOM_LIFETIME_MS) {
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.close(1001, 'room expired')
        } catch {}
      }
      logEvent('room_expired')
      await this.state.storage.deleteAll()
      this.invalidateRoom()
      return
    }

    // A drawer who is gone: evaluate the round skip BEFORE the seat release
    // below. The platform can deliver an alarm seconds late; if the release
    // ran first the room would drop below MIN_PLAYERS and the game would
    // abort to the lobby, so the round would never be skipped and no reveal
    // would be sent.
    await this.skipAbsentDrawer(room, now)

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

    // Early-finish windows: a held seat that has been gone longer than
    // EARLY_FINISH_HOLD_MS stops blocking the round while still keeping its
    // seat. This alarm fires at the earliest such window, so re-check now;
    // a seat whose window has not passed keeps blocking. Covers both a fresh
    // release above and a window expiry with no release.
    //
    // Consume every window that has expired (clear it) BEFORE acting: a window
    // that has fired must never be re-armed, or rearm() would keep setting a
    // past timestamp and the alarm would re-fire in a tight loop whenever the
    // round cannot finish (e.g. a lobby room, or a guesser not yet correct).
    // If nothing finished the round, persist the clears so a hibernation reload
    // cannot resurrect the past value.
    let expiredWindow = false
    for (const seat of Object.values(room.seats)) {
      if (seat.earlyFinishUntil && now >= seat.earlyFinishUntil) {
        seat.earlyFinishUntil = null
        expiredWindow = true
      }
    }
    if (released.length || expiredWindow) {
      const finished = await this.endDrawingEarly(room)
      if (expiredWindow && !finished) await this.saveSafe(room)
    }

    // Empty-room grace.
    if (
      this.openSocketCount() === 0 &&
      room.lastEmptyAt &&
      now >= room.lastEmptyAt + this.graceMs()
    ) {
      logEvent('room_grace_expired')
      await this.state.storage.deleteAll()
      this.invalidateRoom()
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
      room.seats[userId] = { seat, claimedAt: now, heldUntil: null, earlyFinishUntil: null }
      logEvent('seat_claimed', { seat })
    } else {
      room.seats[userId].heldUntil = null // reconnect regains the seat
      // Reconnect re-blocks an early finish: the player is present again and
      // must guess (or the round must end) before it can finish.
      room.seats[userId].earlyFinishUntil = null
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

  /**
   * Run one unit of work for a socket after everything already queued for
   * that socket has finished.
   *
   * The message handler reads the connection attachment, awaits the room
   * load and writes the attachment back. If a second message of the SAME
   * socket were handled while the first was still suspended on that read,
   * the second handler would still hold the attachment copy it read BEFORE
   * the first handler wrote the open-stroke slot: the ownership check would
   * find no open stroke, reject the frame as a stroke_ownership violation,
   * and the stroke would be neither relayed nor stored — a stroke that
   * vanishes with no error on the socket. The chain makes the order of one
   * socket's messages explicit instead of leaving it to event delivery.
   */
  enqueue(ws, fn) {
    const prev = this.socketChains.get(ws) ?? Promise.resolve()
    // then(fn, fn): a failed link must not poison the queue for the next
    // message of this socket.
    const next = prev.then(fn, fn)
    this.socketChains.set(ws, next)
    return next
  }

  async webSocketMessage(ws, message) {
    await this.enqueue(ws, () => this.handleMessage(ws, message))
  }

  async handleMessage(ws, message) {
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

    // Only the current drawer may paint, and only during the drawing phase.
    // Checked BEFORE stroke ownership so an ignored frame can never claim or
    // corrupt the connection's open-stroke slot. The message has already been
    // billed and counted against the per-type budget above, so a non-drawer
    // flood still closes 1008 — we just never relay or store it. Silently
    // ignored (no violation): a phase flip can race a legitimate in-flight
    // frame, and that must not close a good socket.
    if (STROKE_TYPES.includes(env.t) && !this.mayDraw(room, att)) {
      ws.serializeAttachment(att) // keep the decremented budget bucket
      logEvent('stroke_ignored', { t: env.t, phase: room.game.phase })
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
    if (env.t === 'guess') {
      await this.handleGuess(room, att, p, ws)
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

  /** True only for the current drawer while the round is in its drawing phase. */
  mayDraw(room, att) {
    // No game running: the room is a free-draw canvas (the plaza stays the
    // lobby), so any connected member may paint.
    if (room.game.phase === 'lobby') return true
    // During a game only the current drawer may paint, and only while drawing.
    return room.game.phase === 'drawing' && !!att.userId && att.userId === room.game.drawerUserId
  }

  /**
   * A seat is "held" while a disconnected player may still reconnect to it
   * (`heldUntil` set). A released seat (kicked, or the hold expired) is gone.
   * The drawer grace only makes sense for a held seat: a released drawer
   * cannot come back, so their round is skipped at the next alarm, not after
   * a 10 s wait.
   */
  drawerSeatHeld(room, userId) {
    const seat = userId ? room.seats[userId] : null
    return !!seat && !!seat.heldUntil
  }

  connectedSocket(userId) {
    return this.socketsFor(userId).find((ws) => ws.readyState === OPEN) || null
  }

  /**
   * User ids of non-drawer seats that must guess before a drawing round may
   * finish early. A CONNECTED seat always blocks until it guesses. A
   * disconnected (held) seat blocks only inside its early-finish window
   * (`seat.earlyFinishUntil`, set when it dropped): a slow reconnect gets a
   * chance, but after that window it stops blocking while KEEPING its seat, so
   * a single absent player cannot stall the round for the whole seat hold. A
   * released seat (kicked, or hold expired) is never in it.
   */
  pendingGuesserIds(room, now = Date.now()) {
    const game = room.game
    const drawer = game?.drawerUserId
    const ids = []
    for (const uid of Object.keys(room.seats)) {
      if (uid === drawer) continue
      const seat = room.seats[uid]
      if (!seat) continue
      if (this.isConnected(uid)) {
        ids.push(uid)
      } else if (seat.earlyFinishUntil && now < seat.earlyFinishUntil) {
        ids.push(uid)
      }
    }
    return ids
  }

  /**
   * End the drawing phase early when every required non-drawer seat has guessed
   * correctly, with at least one such guesser. Converges on the SAME round-end
   * as the timer — `beginReveal` -> `afterGameStep` (the timer reaches it via
   * `advance()`, this method via `finishDrawingEarly`) — so the phase flip and
   * the alarm rearm are identical. The drawer's still-open stroke is NOT stored
   * by either path (only `stroke_end` stores); because the phase flips, a later
   * `stroke_end` is ignored by `mayDraw`, so watchers keep the dangling live
   * line and drop it when the `reveal` frame arrives (client `clearLive`).
   * Guarded on phase, so a second call in the same tick — or a stale drawing
   * alarm afterwards — is a no-op. Returns true if it finished the round.
   */
  async endDrawingEarly(room) {
    const game = room.game
    if (!game || game.phase !== 'drawing') return false
    const pending = this.pendingGuesserIds(room)
    if (pending.length === 0) return false
    if (!pending.every((uid) => game.correct.includes(uid))) return false
    const times = gameTimings(this.env)
    const from = game.phase
    finishDrawingEarly(game, Date.now(), times)
    // Idempotency key: gameSeq + round + phase. beginRevealEarly flips the
    // phase to reveal and re-points the deadline, so the drawing deadline alarm
    // that is still scheduled becomes a no-op (gameTick sees a new phase).
    await this.afterGameStep(room, { from, to: 'reveal', event: 'early_finish' }, times)
    logEvent('early_finish', { gameSeq: game.gameSeq, round: game.round, guessers: pending.length })
    return true
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
   * One guess from a non-drawer during drawing. The text is normalised,
   * compared and discarded: it is never stored, relayed or logged. Every
   * ignored guess still keeps its decremented rate bucket (the attachment is
   * re-serialised before returning), exactly like the stroke gate, so an
   * ignored-guess flood still closes 1008 rather than being free.
   */
  async handleGuess(room, att, p, ws) {
    const game = room.game
    const ignore = (reason) => {
      ws.serializeAttachment(att) // keep the decremented guess budget bucket
      logEvent('guess_ignored', { reason })
    }
    if (game.phase !== 'drawing') return ignore('phase')
    if (!att.userId || att.userId === game.drawerUserId) return ignore('drawer')
    if (game.correct.includes(att.userId)) return ignore('already')
    // The drawing deadline has passed but the alarm has not fired yet (a hint
    // alarm can lag the true end). The round is over: ignore the guess, but
    // still spend rate budget and persist the attachment (condition A).
    if (game.phaseEndsAt && Date.now() >= game.phaseEndsAt) return ignore('ended')
    const text = normaliseGuess(p.text)
    if (text.length === 0) return ignore('empty')

    // Per-user cap: the 21st accepted guess in a round is a transient error for
    // that guesser only, never a close. The counter lives in game.guessCount
    // and is NOT persisted here (only a correct guess saves).
    const used = game.guessCount[att.userId] || 0
    if (used >= MAX_GUESSES_PER_ROUND) {
      ws.serializeAttachment(att)
      this.sendFrame(ws, { v: 1, t: 'error', reason: 'guess_cap' })
      logEvent('guess_capped', { used })
      return
    }
    game.guessCount[att.userId] = used + 1

    const { status } = judgeGuess(game.word, p.text)
    if (status === 'correct') {
      // Score first: the guesser's points and the drawer's per-guesser reward
      // land in scores/roundGains, then the correct-guess save persists both
      // (no extra row). Idempotent: awardGuess refuses a repeat user.
      awardGuess(game, att.userId, game.drawerUserId, Date.now())
      // Persist so the correct list survives hibernation or eviction.
      await this.saveSafe(room)
      this.broadcast(stateFrame(game, Date.now()))
      this.sendFrame(ws, { v: 1, t: 'guess_ack', ok: true, close: false })
      logEvent('guess_correct', { n: game.correct.length })
      // Everyone who must guess has now guessed: end the round now, running the
      // same reveal path as the timer. No-op if a held/connected seat remains.
      await this.endDrawingEarly(room)
      return
    }
    // Wrong: private feedback only. The guesser's own text never leaves here.
    ws.serializeAttachment(att)
    this.sendFrame(ws, { v: 1, t: 'guess_ack', ok: false, close: status === 'close' })
    logEvent('guess_wrong', { close: status === 'close' })
  }

  /**
   * Skip the round of a drawer who is gone. Returns true when the round was
   * skipped.
   *
   * The drawer is gone and either their seat is released (kicked, or the hold
   * expired: they cannot return) or an in-progress grace has run out. A held
   * seat still inside its grace keeps waiting, and a drawer who was never
   * connected falls through to the phase deadline, so an expired pick still
   * auto-picks and an expired drawing still reveals.
   *
   * The room must still be able to play a round: below MIN_PLAYERS the game
   * goes back to the lobby instead (the spec: "too few players (back to the
   * lobby)"). The seats are counted BEFORE the expired seats are released, so
   * an alarm that arrives late (the platform can deliver one seconds late)
   * still skips the round instead of dropping the room below MIN_PLAYERS and
   * aborting it.
   */
  async skipAbsentDrawer(room, now) {
    const game = room.game
    if (!game || !isDrawerPhase(game.phase)) return false
    if (this.isConnected(game.drawerUserId)) return false
    if (Object.keys(room.seats).length < MIN_PLAYERS) return false
    const released = !this.drawerSeatHeld(room, game.drawerUserId)
    const graceOver = !!game.drawerGraceAt && now >= game.drawerGraceAt
    if (!released && !graceOver) return false
    const from = game.phase
    game.drawerGraceAt = 0
    const times = gameTimings(this.env)
    skipRound(game, now, times)
    await this.afterGameStep(room, { from, to: game.phase, event: 'drawer_absent' }, times)
    return true
  }

  /**
   * One alarm step for the game. A vanished drawer never stalls a round:
   * if their seat is held they get `drawerGrace` to reconnect, and if the
   * seat is already released the round is skipped at the next alarm. Hints
   * are catch-up steps inside drawing; every other transition is one step.
   */
  async gameTick(room, now) {
    const game = room.game
    if (!game || game.phase === 'lobby') return
    const times = gameTimings(this.env)

    // The skip is evaluated before the too-few-players abort: the room can
    // still play the round at this point, and a late alarm must not turn a
    // skippable round into an aborted game.
    if (await this.skipAbsentDrawer(room, now)) return

    if (Object.keys(room.seats).length < MIN_PLAYERS) {
      await this.abortGame(room, now)
      return
    }

    if (game.drawerGraceAt && now >= game.drawerGraceAt) game.drawerGraceAt = 0

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
    // window when their turn starts — but only if their seat is held, i.e.
    // they may still reconnect. A released seat cannot come back, so the
    // gameTick below skips that round at the very next alarm.
    if (res.to === 'pick' && !this.isConnected(game.drawerUserId) && this.drawerSeatHeld(room, game.drawerUserId)) {
      game.drawerGraceAt = now + times.drawerGrace
    }
    // Drawing just began: snapshot the non-drawer seats that are connected
    // right now. This is the perfect-round eligibility set (a mid-round joiner
    // never counts, even though they may still guess and score).
    if (res.to === 'drawing') {
      game.presentAtDrawStart = this.connectedNonDrawerIds(room)
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
    // A kicked drawer's seat is released, so gameTick skips their round right
    // away; schedule an immediate alarm (drawerGraceAt = now) so it does not
    // wait for the phase deadline.
    if (isDrawerPhase(room.game.phase) && room.game.drawerUserId === target) {
      room.game.drawerGraceAt = Date.now()
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
    } else {
      // Otherwise a kicked seat no longer blocks an early finish: if it was the
      // last non-drawer who had not guessed, end the round now.
      await this.endDrawingEarly(room)
    }
  }

  // ---- Disconnect --------------------------------------------------------

  async webSocketClose(ws) {
    await this.enqueue(ws, () => this.handleSocketClose(ws))
  }

  async webSocketError(ws) {
    await this.enqueue(ws, () => this.handleSocketError(ws))
  }

  async handleSocketClose(ws) {
    await this.handleDisconnect(ws)
    // Complete the close handshake: when the CLIENT initiates the close,
    // workerd waits for the DO to close the hibernation socket before the
    // client sees its close event (observed ~14 s stall without this).
    try {
      ws.close(1000, 'bye')
    } catch {}
  }

  async handleSocketError(ws) {
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
        // The round is not stalled by the full hold: this seat stops blocking
        // an early finish after EARLY_FINISH_HOLD_MS, while still keeping its
        // seat. A reconnect clears it (the seat blocks again).
        seat.earlyFinishUntil = Date.now() + gameTimings(this.env).earlyFinishHold
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
    // A seat that just became held still blocks an early finish inside its
    // window (the player may reconnect and guess); a seat already released
    // (kicked) does not. Either way, re-check: if the last required guesser is
    // accounted for, end now. The window's own deadline is armed by rearm().
    await this.endDrawingEarly(room)
    await this.rearm()
  }
}
