// Live rooms tests against the dev worker (dev Supabase): seats, presence,
// host/kick, ownership, payloads, rate budgets, IP cap, creation limits.
//
//   ROOMS_ALLOWED_URL must exactly match the target worker.
//   node tests/rooms.test.mjs
import {
  anonUser,
  check,
  CODE_RE,
  connect,
  createRoom,
  probeWs,
  roomStatus,
  sleep,
  summary,
  TARGET,
} from './helpers.mjs'

// ---- create + join + welcome + presence ------------------------------------
{
  const host = await anonUser()
  const created = await createRoom(host.token)
  check('create returns a valid code', created.status === 201 && CODE_RE.test(created.body.code))
  const code = created.body.code

  const a = await connect(code, host.token)
  check('first join: welcome seat 0, host true', a.welcome?.seat === 0 && a.welcome?.host === true)
  check(
    'welcome player entry carries server identity',
    a.welcome?.players?.length === 1 &&
      a.welcome.players[0].userId === host.userId &&
      a.welcome.players[0].name === 'Guest'
  )

  const other = await anonUser()
  const b = await connect(code, other.token)
  check('second join: welcome seat 1, host false', b.welcome?.seat === 1 && b.welcome?.host === false)
  const joinEv = await a.waitFor((m) => m.t === 'presence' && m.event === 'join' && m.userId === other.userId)
  check('first player sees presence join for second', !!joinEv)
  check('presence lists both connected players', joinEv?.players?.length === 2)

  await b.close()
  await a.close()
}

// ---- room_full: held + connected seats exceed MAX_PLAYERS -------------------
// One test machine cannot open 12 sockets in one room (per-IP cap, tested
// below), but held seats from closed sockets keep counting toward
// MAX_PLAYERS while connected sockets don't count against the IP cap. So:
// fill 8 seats from this IP (exactly at the dev override), close them
// (seats held for SEAT_HOLD_MS), take 4 more seats = 12, and the next join
// must see the room full.
{
  const host = await anonUser()
  const { body } = await createRoom(host.token)
  // Mint everyone up front so the second batch lands well inside the
  // SEAT_HOLD_MS window of the first batch's closes.
  const batch1 = []
  const batch2 = []
  for (let i = 0; i < 8; i++) batch1.push(await anonUser())
  for (let i = 0; i < 4; i++) batch2.push(await anonUser())
  const thirteenth = await anonUser()

  const first = []
  for (const u of batch1) {
    const c = await connect(body.code, u.token)
    if (!c.welcome) {
      check('seat batch connects', false, `status ${c.status} ${JSON.stringify(c.body)}`)
      break
    }
    first.push(c)
  }
  check('8 players seated in the first batch (at the dev IP cap)', first.length === 8)
  for (const c of first) await c.close()

  const second = []
  for (const u of batch2) {
    const c = await connect(body.code, u.token)
    if (!c.welcome) {
      check('second batch connects', false, `status ${c.status} ${JSON.stringify(c.body)}`)
      break
    }
    second.push(c)
  }
  check('4 new seats while 8 are held (12 seats total)', second.length === 4)

  const full = await probeWs(body.code, ['dabble.v1', thirteenth.token])
  check(
    '13th player -> 429 room_full',
    full.status === 429 && JSON.parse(full.body || '{}')?.error === 'room_full'
  )

  for (const c of second) await c.close()
}

// ---- reconnect regains the seat --------------------------------------------
{
  const u = await anonUser()
  const { body } = await createRoom(u.token)
  const first = await connect(body.code, u.token)
  check('initial join seat 0', first.welcome?.seat === 0)
  await first.close()
  await sleep(1200) // within SEAT_HOLD_MS (5 s on dev)
  const again = await connect(body.code, u.token)
  check('reconnect regains the same seat', again.welcome?.seat === 0)
  await again.close()
}

// ---- second tab replaces the first (4009) ----------------------------------
{
  const u = await anonUser()
  const { body } = await createRoom(u.token)
  const tab1 = await connect(body.code, u.token)
  const tab2 = await connect(body.code, u.token)
  const closed = await tab1.waitForClose(4009)
  check('older socket closed with 4009', !!closed, closed ? `code ${closed.code} ${closed.reason}` : 'no close')
  check('new socket keeps the seat', tab2.welcome?.seat === 0)
  const presence = tab2.json().filter((m) => m.t === 'presence')
  const listed = new Set(presence.flatMap((m) => (m.players || []).map((p) => p.userId)))
  check('presence never lists the user twice', listed.size <= 1 && listed.has(u.userId))
  await tab2.close()
}

// ---- host promotion after the creator's seat is released -------------------
{
  const host = await anonUser()
  const mate = await anonUser()
  const { body } = await createRoom(host.token)
  const a = await connect(body.code, host.token)
  const b = await connect(body.code, mate.token)
  check('creator is host', a.welcome?.host === true && b.welcome?.host === false)

  await a.close()
  const part = await b.waitFor((m) => m.t === 'presence' && m.event === 'part' && m.userId === host.userId)
  check('disconnect broadcasts part with no ghost', !!part && !part.players.some((p) => p.userId === host.userId))

  // SEAT_HOLD_MS is 5 s on dev; the release must promote the remaining
  // longest-connected player.
  const leave = await b.waitFor((m) => m.t === 'presence' && m.event === 'leave' && m.userId === host.userId, 12000)
  check('seat released with a leave event after the hold', !!leave)
  const hostEv = await b.waitFor((m) => m.t === 'presence' && m.event === 'host' && m.userId === mate.userId, 5000)
  check('remaining player promoted to host', !!hostEv)
  check('mate sees itself as host in presence', hostEv?.players?.find((p) => p.userId === mate.userId)?.host === true)
  await b.close()
}

// ---- kick + rejoin block ----------------------------------------------------
{
  const host = await anonUser()
  const target = await anonUser()
  const { body } = await createRoom(host.token)
  const a = await connect(body.code, host.token)
  const b = await connect(body.code, target.token)

  a.ws.send(JSON.stringify({ v: 1, t: 'kick', userId: target.userId }))
  const ack = await a.waitFor((m) => m.t === 'kick_ack' && m.userId === target.userId)
  check('host gets kick_ack', !!ack)
  const closed = await b.waitForClose(4003)
  check('kicked socket closed with 4003', !!closed, closed ? String(closed.code) : 'no close')

  const leave = await a.waitFor((m) => m.t === 'presence' && m.event === 'leave' && m.userId === target.userId)
  check('kicked player leaves presence immediately', !!leave && !leave.players.some((p) => p.userId === target.userId))

  // Rejoin attempt: accepted then closed 4003 for the room's lifetime.
  const rejoin = await connect(body.code, target.token, { waitForWelcome: false })
  if (rejoin.ws) {
    const again = await rejoin.waitForClose(4003)
    check('rejoin blocked with 4003', !!again, again ? String(again.code) : 'no close')
  } else {
    check('rejoin blocked with 4003', false, `status ${rejoin.status} ${rejoin.body}`)
  }

  const stillHost = await a.json().filter((m) => m.t === 'presence').at(-1)
  check('kicked user never reappears in presence', !stillHost?.players?.some((p) => p.userId === target.userId))
  await a.close()
}

// ---- presence has no ghosts on plain disconnect ------------------------------
{
  const host = await anonUser()
  const mate = await anonUser()
  const { body } = await createRoom(host.token)
  const a = await connect(body.code, host.token)
  const b = await connect(body.code, mate.token)
  await b.close()
  const part = await a.waitFor((m) => m.t === 'presence' && m.event === 'part')
  check('players list drops the disconnected user at once', !!part && !part.players.some((p) => p.userId === mate.userId))
  check('no other sockets are listed as ghosts', part.players.every((p) => p.userId === host.userId))
  await a.close()
}

// ---- forged identity fields are overwritten ----------------------------------
{
  const artist = await anonUser()
  const watcher = await anonUser()
  const { body } = await createRoom(artist.token)
  const a = await connect(body.code, artist.token)
  const w = await connect(body.code, watcher.token)

  a.ws.send(
    JSON.stringify({
      v: 1,
      t: 'stroke_start',
      k: 'c1',
      id: '0e0a0000-0000-4000-8000-000000000001',
      userId: 'attacker',
      userName: 'EVIL',
      country: 'XX',
      color: '#e5484d',
      width: 5,
      pts: [10, 20],
    })
  )
  const start = await w.waitFor((m) => m.t === 'stroke_start')
  check('stroke_start userId overwritten with the real one', start?.userId === artist.userId && start?.userId !== 'attacker')
  check('stroke_start userName overwritten with the real one', start?.userName === 'Guest' && start?.userName !== 'EVIL')
  check('stroke_start carries no client-forged country', start?.country !== 'XX')

  a.ws.send(
    JSON.stringify({
      v: 1,
      t: 'stroke_end',
      k: 'c1',
      stroke: {
        id: '0e0a0000-0000-4000-8000-000000000001',
        userId: 'attacker',
        userName: 'EVIL',
        color: '#e5484d',
        width: 5,
        points: [10, 20],
      },
    })
  )
  const end = await w.waitFor((m) => m.t === 'stroke_end')
  check('stroke_end identity overwritten', end?.stroke?.userId === artist.userId && end?.stroke?.userName === 'Guest')

  await a.close()
  await w.close()
}

// ---- stroke ownership: one open stroke per connection -----------------------
{
  const artist = await anonUser()
  const watcher = await anonUser()
  const { body } = await createRoom(artist.token)
  const a = await connect(body.code, artist.token)
  const w = await connect(body.code, watcher.token)

  const S1 = '0e0a0000-0000-4000-8000-000000000011'
  const S2 = '0e0a0000-0000-4000-8000-000000000022'
  a.ws.send(JSON.stringify({ v: 1, t: 'stroke_start', k: 'c', id: S1, userId: 'x', userName: 'x', color: '#e5484d', width: 5, pts: [1, 1] }))
  await w.waitFor((m) => m.t === 'stroke_start' && m.id === S1)

  // Double-start while S1 is open: dropped.
  a.ws.send(JSON.stringify({ v: 1, t: 'stroke_start', k: 'c', id: S2, userId: 'x', userName: 'x', color: '#e5484d', width: 5, pts: [2, 2] }))
  // Points/end/cancel for a stroke this connection never started: dropped.
  a.ws.send(JSON.stringify({ v: 1, t: 'stroke_points', k: 'c', id: S2, seq: 1, pts: [5, 5] }))
  a.ws.send(JSON.stringify({ v: 1, t: 'stroke_cancel', k: 'c', id: S2 }))
  await sleep(600)
  check(
    'unowned strokes never reach the other player',
    !w.json().some((m) => (m.t === 'stroke_start' && m.id === S2) || (m.t === 'stroke_points' && m.id === S2) || (m.t === 'stroke_cancel' && m.id === S2))
  )

  // Owned traffic flows.
  a.ws.send(JSON.stringify({ v: 1, t: 'stroke_points', k: 'c', id: S1, seq: 1, pts: [3, 3] }))
  const pts = await w.waitFor((m) => m.t === 'stroke_points' && m.id === S1)
  check('owned stroke_points broadcast', !!pts)
  a.ws.send(JSON.stringify({ v: 1, t: 'stroke_cancel', k: 'c', id: S1 }))
  const cancel = await w.waitFor((m) => m.t === 'stroke_cancel' && m.id === S1)
  check('owned stroke_cancel broadcast', !!cancel)

  // After cancel the id is no longer owned: points for it are dropped.
  a.ws.send(JSON.stringify({ v: 1, t: 'stroke_points', k: 'c', id: S1, seq: 2, pts: [7, 7] }))
  await sleep(400)
  check('points after cancel dropped', !w.json().some((m) => m.t === 'stroke_points' && m.seq === 2))

  await a.close()
  await w.close()
}

// ---- brush id and palette over the wire --------------------------------------
{
  const artist = await anonUser()
  const watcher = await anonUser()
  const { body } = await createRoom(artist.token)
  const a = await connect(body.code, artist.token)
  const w = await connect(body.code, watcher.token)

  const S = '0e0a0000-0000-4000-8000-000000000031'
  // No brush id sent: the server means "brush 0". An uppercase palette colour
  // is canonicalised on the way out.
  a.ws.send(JSON.stringify({ v: 1, t: 'stroke_start', k: 'b', id: S, userId: 'x', userName: 'x', color: '#E5484D', width: 5, pts: [1, 1] }))
  const started = await w.waitFor((m) => m.t === 'stroke_start' && m.id === S)
  check('stroke_start relays brush id 0 when absent', started?.b === 0, `b=${JSON.stringify(started?.b)}`)
  check('stroke_start colour canonicalised to the palette', started?.color === '#e5484d', `color=${JSON.stringify(started?.color)}`)

  // The final stroke carries the brush id too.
  a.ws.send(JSON.stringify({ v: 1, t: 'stroke_end', k: 'b', stroke: { id: S, userId: 'x', userName: 'x', color: '#e5484d', width: 5, points: [1, 1, 2, 2] } }))
  const ended = await w.waitFor((m) => m.t === 'stroke_end')
  check('stroke_end relays brush id 0 when absent', ended?.stroke?.b === 0, `b=${JSON.stringify(ended?.stroke?.b)}`)
  check('stroke_end colour canonicalised to the palette', ended?.stroke?.color === '#e5484d', `color=${JSON.stringify(ended?.stroke?.color)}`)

  await a.close()
  await w.close()
}

// ---- a colour outside the palette is a violation ------------------------------
{
  const u = await anonUser()
  const { body } = await createRoom(u.token)
  const a = await connect(body.code, u.token)
  for (let i = 0; i < 20; i++) {
    a.ws.send(JSON.stringify({ v: 1, t: 'stroke_start', k: 'c', id: '0e0a0000-0000-4000-8000-000000000041', userId: 'x', userName: 'x', color: '#112233', width: 5, pts: [1, 1] }))
  }
  const closed = await a.waitForClose(1008)
  check('non-palette colour closes with 1008', !!closed, closed ? closed.reason : 'no close')
}

// ---- a brush id outside BRUSH_IDS is a violation -------------------------------
{
  const u = await anonUser()
  const { body } = await createRoom(u.token)
  const a = await connect(body.code, u.token)
  for (let i = 0; i < 20; i++) {
    a.ws.send(JSON.stringify({ v: 1, t: 'stroke_start', k: 'c', id: '0e0a0000-0000-4000-8000-000000000051', userId: 'x', userName: 'x', color: '#e5484d', width: 5, b: 1, pts: [1, 1] }))
  }
  const closed = await a.waitForClose(1008)
  check('unknown brush id closes with 1008', !!closed, closed ? closed.reason : 'no close')
}

// ---- invalid payloads -> violations -> close 1008 ----------------------------
{
  const u = await anonUser()
  const { body } = await createRoom(u.token)
  const a = await connect(body.code, u.token)
  for (let i = 0; i < 20; i++) {
    a.ws.send(JSON.stringify({ v: 1, t: 'cursor', k: 'c', x: 99999, y: 0 })) // out of range
  }
  const closed = await a.waitForClose(1008)
  check('20 invalid payloads close with 1008', !!closed, closed ? closed.reason : 'no close')
}

// ---- unknown message types are violations too ---------------------------------
{
  const u = await anonUser()
  const { body } = await createRoom(u.token)
  const a = await connect(body.code, u.token)
  for (let i = 0; i < 20; i++) {
    a.ws.send(JSON.stringify({ v: 1, t: 'definitely_not_a_type' }))
  }
  const closed = await a.waitForClose(1008)
  check('20 unknown types close with 1008', !!closed, closed ? closed.reason : 'no close')
}

// ---- oversized message -> 1009 -------------------------------------------------
{
  const u = await anonUser()
  const { body } = await createRoom(u.token)
  const a = await connect(body.code, u.token)
  a.ws.send('x'.repeat(9000))
  const closed = await a.waitForClose(1009)
  check('oversized message closes with 1009', !!closed, closed ? closed.reason : 'no close')
}

// ---- sustained rate breach -> 1008 ---------------------------------------------
{
  const u = await anonUser()
  const { body } = await createRoom(u.token)
  const a = await connect(body.code, u.token)
  // cursor budget: burst 10, 5/s — 15 in one burst must breach.
  for (let i = 0; i < 15; i++) {
    a.ws.send(JSON.stringify({ v: 1, t: 'cursor', k: 'c', x: i, y: i }))
  }
  const closed = await a.waitForClose(1008)
  check('cursor burst over budget closes with 1008', !!closed, closed ? closed.reason : 'no close')
}

// ---- per-IP socket cap (dev override 8; forged X-IP-Hash never honored) --------
{
  const { body } = await createRoom((await anonUser()).token)
  const sockets = []
  // Each socket claims a DIFFERENT forged X-IP-Hash: if the Worker let it
  // through, all 9 would be seen as separate IPs and the 9th would pass.
  for (let i = 0; i < 8; i++) {
    const u = await anonUser()
    const c = await connect(body.code, u.token, { headers: { 'X-IP-Hash': `forged-${i}` } })
    sockets.push(c)
  }
  check('8 sockets from one IP accepted under the dev override', sockets.every((c) => c.welcome?.seat !== undefined))
  const ninth = await anonUser()
  const rejected = await probeWs(body.code, ['dabble.v1', ninth.token], { 'X-IP-Hash': 'forged-9' })
  check(
    '9th socket -> 429 too_many_connections (forged X-IP-Hash ignored)',
    rejected.status === 429 && JSON.parse(rejected.body || '{}')?.error === 'too_many_connections'
  )
  for (const c of sockets) if (c.close) await c.close()
}

// ---- room creation rate limit (5/user/hour) ---------------------------------------
{
  const u = await anonUser()
  const codes = []
  for (let i = 0; i < 5; i++) {
    const r = await createRoom(u.token)
    if (r.status === 201) codes.push(r.body.code)
  }
  check('5 creations allowed per user per hour', codes.length === 5)
  const sixth = await createRoom(u.token)
  check('6th creation -> 429 rate_limited', sixth.status === 429 && sixth.body?.error === 'rate_limited')
  check('rate limit carries Retry-After', !!sixth.headers.get('retry-after'))
}

// ---- stroke_cancel when the artist's socket dies mid-stroke ------------------
{
  const artist = await anonUser()
  const watcher = await anonUser()
  const { body } = await createRoom(artist.token)
  const a = await connect(body.code, artist.token)
  const w = await connect(body.code, watcher.token)

  const S = '0e0a0000-0000-4000-8000-000000000033'
  a.ws.send(JSON.stringify({ v: 1, t: 'stroke_start', k: 'open-at-close', id: S, userId: 'x', userName: 'x', color: '#e5484d', width: 5, pts: [1, 1] }))
  const started = await w.waitFor((m) => m.t === 'stroke_start' && m.id === S)
  check('watcher sees the stroke start before the close', !!started)

  await a.close()
  const cancel = await w.waitFor((m) => m.t === 'stroke_cancel' && m.id === S)
  check('artist close mid-stroke broadcasts stroke_cancel with the original k', !!cancel && cancel.k === 'open-at-close')
  await w.close()
}

// ---- stroke_cancel when a 4009 replace tears down the artist ----------------
{
  const artist = await anonUser()
  const watcher = await anonUser()
  const { body } = await createRoom(artist.token)
  const tab1 = await connect(body.code, artist.token)
  const w = await connect(body.code, watcher.token)

  const S = '0e0a0000-0000-4000-8000-000000000044'
  tab1.ws.send(JSON.stringify({ v: 1, t: 'stroke_start', k: 'open-at-replace', id: S, userId: 'x', userName: 'x', color: '#e5484d', width: 5, pts: [2, 2] }))
  const started = await w.waitFor((m) => m.t === 'stroke_start' && m.id === S)
  check('watcher sees the stroke start before the replace', !!started)

  const tab2 = await connect(body.code, artist.token) // same user: tab1 closed 4009
  const replaced = await tab1.waitForClose(4009)
  check('old tab closed with 4009', !!replaced)
  const cancel = await w.waitFor((m) => m.t === 'stroke_cancel' && m.id === S)
  check('replaced socket mid-stroke broadcasts stroke_cancel with the original k', !!cancel && cancel.k === 'open-at-replace')

  await tab2.close()
  await w.close()
}

// ---- non-host kick is rejected ---------------------------------------------
{
  const host = await anonUser()
  const mate = await anonUser()
  const target = await anonUser()
  const { body } = await createRoom(host.token)
  const a = await connect(body.code, host.token)
  const b = await connect(body.code, mate.token)
  const c = await connect(body.code, target.token)

  // A single non-host kick is a violation, never a kick: no ack, target stays.
  b.ws.send(JSON.stringify({ v: 1, t: 'kick', userId: target.userId }))
  await sleep(500)
  check('non-host kick yields no kick_ack', !b.json().some((m) => m.t === 'kick_ack'))
  check('target stays seated after a non-host kick', !c.closed && !c.closes.some((x) => x.code === 4003))

  // Sustained non-host kicks hit the violation budget and close 1008 (spaced
  // to stay inside the per-type rate budget, so the close is the violation path).
  for (let i = 0; i < 20; i++) {
    b.ws.send(JSON.stringify({ v: 1, t: 'kick', userId: target.userId }))
    await sleep(250)
  }
  const closed = await b.waitForClose(1008)
  check('sustained non-host kicks close with 1008', !!closed, closed ? closed.reason : 'no close')
  check('target was never actually kicked', !c.closed && !c.closes.some((x) => x.code === 4003))
  await a.close()
  await c.close()
}

// ---- empty-room grace: alarm cleanup after everyone leaves ------------------
{
  const host = await anonUser()
  const { body } = await createRoom(host.token)
  const a = await connect(body.code, host.token)
  const b = await connect(body.code, (await anonUser()).token)
  check('grace: two players seated', a.welcome?.seat === 0 && b.welcome?.seat === 1)
  await a.close()
  await b.close()

  // Within the grace window the held host seat still exists, so a newcomer is
  // NOT the host (the room survived; it was not wiped).
  await sleep(1500)
  const within = await connect(body.code, (await anonUser()).token)
  check(
    'refresh within grace keeps the room (held host seat => newcomer not host)',
    within.status === 101 && within.welcome?.host === false,
    `status ${within.status} host ${within.welcome?.host}`
  )
  await within.close()

  // Past the dev grace (15 s) the alarm deletes all state: the same code is a
  // clean room again — no old seats, no old host (nothing to list).
  await sleep(16000)
  const after = await connect(body.code, (await anonUser()).token)
  check('after grace the room is gone (404, no old seats or host)', after.status === 404, `status ${after.status}`)
  if (after.status === 101) await after.close()
}

// ---- every outbound frame carries v === 1 -----------------------------------
{
  const host = await anonUser()
  const mate = await anonUser()
  const target = await anonUser()
  const { body } = await createRoom(host.token)
  const a = await connect(body.code, host.token)
  const b = await connect(body.code, mate.token)
  const c = await connect(body.code, target.token)

  const S = '0e0a0000-0000-4000-8000-000000000077'
  a.ws.send(JSON.stringify({ v: 1, t: 'stroke_start', k: 'vk', id: S, userId: 'x', userName: 'x', color: '#e5484d', width: 5, pts: [1, 1] }))
  await b.waitFor((m) => m.t === 'stroke_start' && m.id === S)
  a.ws.send(JSON.stringify({ v: 1, t: 'stroke_points', k: 'vk', id: S, seq: 1, pts: [2, 2] }))
  await b.waitFor((m) => m.t === 'stroke_points' && m.id === S)
  b.ws.send(JSON.stringify({ v: 1, t: 'cursor', k: 'vc', x: 3, y: 3 }))
  await a.waitFor((m) => m.t === 'cursor' && m.k === 'vc')
  a.ws.send(JSON.stringify({ v: 1, t: 'kick', userId: target.userId }))
  await a.waitFor((m) => m.t === 'kick_ack' && m.userId === target.userId)
  await c.waitForClose(4003)
  await sleep(300)
  await a.close()

  const frames = [...a.json(), ...b.json(), ...c.json()]
  check('v === 1 on every outbound frame (join/draw/kick/leave)', frames.length > 0 && frames.every((m) => m.v === 1), `${frames.length} frames`)
}

// ---- pre-join probe: GET /rooms/<code>/status -----------------------------
// A browser cannot read the HTTP status of a failed WebSocket handshake, so
// room_full / unknown-room / rooms-busy would be invisible to the client.
// These are the readable answers, and they must leak nothing.
{
  const host = await anonUser()
  const created = await createRoom(host.token)
  const code = created.body.code

  const noAuth = await roomStatus(code, null)
  check('status without a token -> 401', noAuth.status === 401, `${noAuth.status}`)

  const badFormat = await roomStatus('not-a-code!!', host.token)
  check('malformed code -> 400 bad_room_code', badFormat.status === 400 && badFormat.body?.error === 'bad_room_code')

  const unknown = await roomStatus('QQQQQ', host.token)
  check('well-formed but unknown room -> 404 not_found', unknown.status === 404 && unknown.body?.error === 'not_found')

  const wrongOrigin = await roomStatus(code, host.token, { Origin: 'https://evil.example' })
  check('rejected origin -> 403 origin', wrongOrigin.status === 403 && wrongOrigin.body?.error === 'origin')

  const empty = await roomStatus(code, host.token, { Origin: 'http://localhost:5173' })
  check('empty room -> 200', empty.status === 200, `${empty.status} ${JSON.stringify(empty.body)}`)
  check('200 body is exactly {players, full}', !!empty.body && JSON.stringify(empty.body) === '{"players":0,"full":false}', JSON.stringify(empty.body))
  check('200 body carries no identity fields', !JSON.stringify(empty.body).match(/name|userId|user_id|country|seat|host/i))

  // A connected player is visible to a second visitor's probe.
  const here = await connect(code, host.token)
  const occupied = await roomStatus(code, (await anonUser()).token, { Origin: 'http://localhost:5173' })
  check('occupied room -> players: 1, full: false', occupied.status === 200 && occupied.body?.players === 1 && occupied.body?.full === false, JSON.stringify(occupied.body))
  await here.close()

  // Preflight, because Authorization is not a CORS-safelisted header.
  const pre = await fetch(`${TARGET}/rooms/${code}/status`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
  })
  check('status preflight -> 204', pre.status === 204, `${pre.status}`)
  check('preflight allows the app origin', pre.headers.get('access-control-allow-origin') === 'http://localhost:5173')
  check('preflight allows Authorization', (pre.headers.get('access-control-allow-headers') || '').includes('Authorization'))
  check('preflight allows GET', (pre.headers.get('access-control-allow-methods') || '').includes('GET'))
}

// ---- pre-join probe: kicked users read 403 ---------------------------------
{
  const host = await anonUser()
  const { body } = await createRoom(host.token)
  const target = await anonUser()
  const a = await connect(body.code, host.token)
  const b = await connect(body.code, target.token)
  a.ws.send(JSON.stringify({ v: 1, t: 'kick', userId: target.userId }))
  await a.waitFor((m) => m.t === 'kick_ack' && m.userId === target.userId)
  await b.waitForClose(4003)
  await sleep(300)

  const after = await roomStatus(body.code, target.token, { Origin: 'http://localhost:5173' })
  check('kicked user probing the room -> 403 kicked', after.status === 403 && after.body?.error === 'kicked', `${after.status} ${JSON.stringify(after.body)}`)
  await a.close()
}

// ---- v2 Phase 3 step 1: round storage + snapshot ------------------------------
// Every join gets the round (even when empty), stored strokes survive
// disconnects, the open stroke is never stored, caps flag the round partial
// without stopping the live relay, and cursors carry the sender's userId.

// A. First join: welcome, state, then an empty snapshot, always, in that order.
{
  const u = await anonUser()
  const { body } = await createRoom(u.token)
  const a = await connect(body.code, u.token)
  const snap = await a.waitFor((m) => m.t === 'snapshot')
  check('snapshot: first join always gets one (never skipped)', !!snap)
  check('snapshot: a fresh room answers with an empty round 1',
    snap?.round === 1 && snap?.partial === false && snap?.strokes?.length === 0,
    JSON.stringify(snap))
  const frames = a.json().map((m) => m.t)
  check('snapshot: wire order is exactly welcome, state, then snapshot',
    frames[0] === 'welcome' && frames[1] === 'state' && frames[2] === 'snapshot',
    JSON.stringify(frames.slice(0, 4)))
  check('snapshot: a fresh room state is the lobby at round 1',
    a.json()[1]?.phase === 'lobby' && a.json()[1]?.round === 1,
    JSON.stringify(a.json()[1]))
  await a.close()
}

// B. Late join mid-doodle: the committed stroke is there, the open one is not,
//    and a reconnect still sees it.
{
  const artist = await anonUser()
  const { body } = await createRoom(artist.token)
  const a = await connect(body.code, artist.token)

  const S1 = '0e0a0000-0000-4000-8000-000000000101'
  a.ws.send(JSON.stringify({ v: 1, t: 'stroke_start', k: 'k1', id: S1, userId: 'x', userName: 'x', color: '#e5484d', width: 5, pts: [10, 20] }))
  await sleep(150)
  a.ws.send(JSON.stringify({ v: 1, t: 'stroke_end', k: 'k1', stroke: { id: S1, userId: 'x', userName: 'x', color: '#e5484d', width: 5, points: [10, 20, 30, 40, 50, 60] } }))
  await sleep(400) // store + save finish well before the joiner reads

  const S2 = '0e0a0000-0000-4000-8000-000000000102'
  a.ws.send(JSON.stringify({ v: 1, t: 'stroke_start', k: 'k1', id: S2, userId: 'x', userName: 'x', color: '#30a46c', width: 7, pts: [100, 200] }))
  await sleep(200)

  const b = await connect(body.code, (await anonUser()).token)
  const snap = await b.waitFor((m) => m.t === 'snapshot')
  check('late join: the committed stroke is in the snapshot',
    snap?.strokes?.length === 1 && snap.strokes[0].id === S1,
    JSON.stringify(snap?.strokes?.map((s) => s.id)))
  const s = snap?.strokes?.[0]
  check('late join: identity and shape survive storage',
    !!s && s.userId === artist.userId && s.userName === 'Guest' && s.color === '#e5484d' &&
    s.width === 5 && s.b === 0 && JSON.stringify(s.points) === '[10,20,30,40,50,60]',
    JSON.stringify(s))
  check('late join: an open (never ended) stroke is not stored',
    !!snap && !snap.strokes.some((x) => x.id === S2))

  await a.close()
  await sleep(900) // seat hold is 5 s on dev: reconnect, do not re-create
  const again = await connect(body.code, artist.token)
  const snap2 = await again.waitFor((m) => m.t === 'snapshot')
  check('reconnect: the round survives the drop with its stroke',
    snap2?.strokes?.length === 1 && snap2.strokes[0].id === S1,
    JSON.stringify(snap2?.strokes?.map((x) => x.id)))
  console.log('measure ' + JSON.stringify({ case: 'snapshot_small', bytes: JSON.stringify(snap2).length, strokes: snap2?.strokes?.length }))
  await again.close()
  await b.close()
}

// C. Paint order survives storage: a late joiner sees strokes as they were drawn.
{
  const artist = await anonUser()
  const { body } = await createRoom(artist.token)
  const a = await connect(body.code, artist.token)
  const ids = [
    '0e0a0000-0000-4000-8000-000000000111',
    '0e0a0000-0000-4000-8000-000000000112',
    '0e0a0000-0000-4000-8000-000000000113',
  ]
  for (let i = 0; i < ids.length; i++) {
    a.ws.send(JSON.stringify({ v: 1, t: 'stroke_start', k: 'p', id: ids[i], userId: 'x', userName: 'x', color: '#e5484d', width: 4, pts: [i, i] }))
    await sleep(150)
    a.ws.send(JSON.stringify({ v: 1, t: 'stroke_end', k: 'p', stroke: { id: ids[i], userId: 'x', userName: 'x', color: '#e5484d', width: 4, points: [i, i, i + 1, i + 1] } }))
    await sleep(350)
  }
  const b = await connect(body.code, (await anonUser()).token)
  const snap = await b.waitFor((m) => m.t === 'snapshot')
  check('snapshot: paint order equals insertion order',
    JSON.stringify(snap?.strokes?.map((x) => x.id)) === JSON.stringify(ids),
    JSON.stringify(snap?.strokes?.map((x) => x.id)))
  await a.close()
  await b.close()
}

// D. Cursors carry the sender's userId so a watcher gets a labelled cursor
//    before the sender has drawn anything.
{
  const artist = await anonUser()
  const watcher = await anonUser()
  const { body } = await createRoom(artist.token)
  const a = await connect(body.code, artist.token)
  const w = await connect(body.code, watcher.token)
  w.ws.send(JSON.stringify({ v: 1, t: 'cursor', k: 'cur1', x: 111, y: 222 }))
  const cur = await a.waitFor((m) => m.t === 'cursor' && m.k === 'cur1')
  check('cursor: frame carries the sender userId (identity is server-set)',
    cur?.userId === watcher.userId, JSON.stringify(cur))
  check('cursor: position fields unchanged', cur?.x === 111 && cur?.y === 222, JSON.stringify(cur))
  await a.close()
  await w.close()
}

// E. Round caps: 650-point strokes from four artists (each message stays under
//    MAX_MSG_BYTES) fill MAX_ROUND_POINTS after exactly 30 strokes. The rest
//    still relay live but are not stored, and the next joiner's snapshot says
//    partial.
//
//    The strokes are paced: 300 ms between a stroke_start and its stroke_end,
//    700 ms after it. Four artists drawing at full speed put 16 messages on
//    the wire in the first second, and a per-socket rate budget (5/s, burst
//    10) plus a Durable Object busy writing 4.8 KB strokes can lose a frame
//    when they arrive back to back. Pacing keeps every socket at 2
//    messages/s, far under the budget, and gives the room time to settle
//    between two frames of the same stroke.
//
//    The room is warmed before the measured strokes. A Durable Object loads
//    its room state on the first message it handles, and the load is an
//    await. A socket's stroke_start and its stroke_end must not straddle
//    it: if they did, the stroke_end handler would read the attachment
//    from before the stroke_start was written, find no open stroke and
//    reject the frame as a stroke_ownership violation — the stroke would
//    then be neither relayed nor stored, and the room's cap would never be
//    reached. The server now serialises one socket's messages (the
//    per-socket chain in src/room.js), so the straddle cannot happen; the
//    warm-up stays as an explicit precondition check instead of a
//    workaround: a cold room now shows up as this named failure rather
//    than as a silently lost stroke. A cursor frame is relayed but never
//    stored, so the warm-up costs the round nothing.
{
  const host = await anonUser()
  const { body } = await createRoom(host.token)
  const artists = []
  for (let i = 0; i < 4; i++) {
    const u = await anonUser()
    artists.push(await connect(body.code, u.token))
  }
  const w = await connect(body.code, (await anonUser()).token)

  const warmDeadline = Date.now() + 8000
  for (const c of artists) {
    c.ws.send(JSON.stringify({ v: 1, t: 'cursor', k: 'warm', x: 1, y: 1 }))
  }
  while (w.json().filter((m) => m.t === 'cursor' && m.k === 'warm').length < artists.length && Date.now() < warmDeadline) {
    await sleep(50)
  }
  const warmed = w.json().filter((m) => m.t === 'cursor' && m.k === 'warm').length
  check('caps: the room is warm before the measured strokes', warmed === artists.length, `${warmed}/${artists.length}`)

  const big = []
  for (let j = 0; j < 1300; j++) big.push(j % 100) // 650 points, ~4.8 KB on the wire

  const draw = async (c, a) => {
    for (let i = 0; i < 8; i++) {
      const id = `0e0a0000-0000-4000-8000-${'000000000' + a + String(i).padStart(2, '0')}`
      c.ws.send(JSON.stringify({ v: 1, t: 'stroke_start', k: 'big', id, userId: 'x', userName: 'x', color: '#e5484d', width: 4, pts: [1, 1] }))
      await sleep(300)
      c.ws.send(JSON.stringify({ v: 1, t: 'stroke_end', k: 'big', stroke: { id, userId: 'x', userName: 'x', color: '#e5484d', width: 4, points: big } }))
      await sleep(700)
    }
  }
  await Promise.all(artists.map((c, a) => draw(c, a)))
  await sleep(500) // let the last storage writes settle

  // A socket that closed mid-section is the usual reason a stroke goes
  // missing: the frames were never sent and the count checks below would
  // only show a gap. Report the close first, with its code and reason.
  const dropped = artists
    .map((c, i) => (c.closed ? { artist: i, code: c.closes[0]?.code, reason: c.closes[0]?.reason } : null))
    .filter(Boolean)
  check('caps: no artist socket closed during the section', dropped.length === 0, JSON.stringify(dropped))

  // The relay must keep working after the breach.
  const sentinel = '0e0a0000-0000-4000-8000-000000000299'
  artists[0].ws.send(JSON.stringify({ v: 1, t: 'stroke_start', k: 'big', id: sentinel, userId: 'x', userName: 'x', color: '#30a46c', width: 4, pts: [5, 5] }))
  await sleep(300)
  artists[0].ws.send(JSON.stringify({ v: 1, t: 'stroke_end', k: 'big', stroke: { id: sentinel, userId: 'x', userName: 'x', color: '#30a46c', width: 4, points: [5, 5, 6, 6] } }))
  const relayed = await w.waitFor((m) => m.t === 'stroke_end' && m.stroke?.id === sentinel)
  check('caps: a breach never stops the live relay (post-breach stroke broadcast)', !!relayed)
  const seenEnds = w.json().filter((m) => m.t === 'stroke_end').length
  check('caps: every stroke still reached the live watcher', seenEnds === 33, String(seenEnds))

  // Which frames were lost? Pair every relayed stroke_start with its
  // stroke_end by stroke id: a start without an end means the room never
  // finished that stroke, an end without a start means the start itself was
  // dropped. The ids name the artist and the stroke, so a failure says
  // exactly which one went missing.
  const startedIds = w.json().filter((m) => m.t === 'stroke_start').map((m) => m.id)
  const endedIds = w.json().filter((m) => m.t === 'stroke_end').map((m) => m.stroke?.id)
  const noEnd = startedIds.filter((id) => !endedIds.includes(id))
  const noStart = endedIds.filter((id) => !startedIds.includes(id))
  check('caps: every relayed stroke_start has its stroke_end', noEnd.length === 0 && noStart.length === 0,
    JSON.stringify({ started: startedIds.length, ended: endedIds.length, noEnd, noStart }))

  const late = await connect(body.code, (await anonUser()).token)
  const snap = await late.waitFor((m) => m.t === 'snapshot')
  check('caps: the round is flagged partial once the cap breaks',
    snap?.partial === true, JSON.stringify({ partial: snap?.partial, n: snap?.strokes?.length }))
  check('caps: exactly the 30 strokes that fit MAX_ROUND_POINTS are stored',
    snap?.strokes?.length === 30, String(snap?.strokes?.length))
  console.log('measure ' + JSON.stringify({ case: 'snapshot_at_cap', bytes: JSON.stringify(snap).length, strokes: snap?.strokes?.length, partial: snap?.partial }))
  for (const c of artists) await c.close()
  await w.close()
  await late.close()
}

// F. Size of a typical short round: 10 strokes x 400 points, measured from
//    the frame a real joiner receives.
{
  const artist = await anonUser()
  const { body } = await createRoom(artist.token)
  const a = await connect(body.code, artist.token)
  for (let i = 0; i < 10; i++) {
    const id = `0e0a0000-0000-4000-8000-0000000003${String(i).padStart(2, '0')}`
    const pts = []
    for (let j = 0; j < 400; j++) pts.push((j * 7 + i) % 2000, (j * 13 + i) % 2000)
    a.ws.send(JSON.stringify({ v: 1, t: 'stroke_start', k: 'm', id, userId: 'x', userName: 'x', color: '#e5484d', width: 4, pts: [pts[0], pts[1]] }))
    await sleep(150)
    a.ws.send(JSON.stringify({ v: 1, t: 'stroke_end', k: 'm', stroke: { id, userId: 'x', userName: 'x', color: '#e5484d', width: 4, points: pts } }))
    await sleep(350)
  }
  const b = await connect(body.code, (await anonUser()).token)
  const snap = await b.waitFor((m) => m.t === 'snapshot')
  check('typical round: 10 strokes delivered to a late joiner',
    snap?.strokes?.length === 10, String(snap?.strokes?.length))
  console.log('measure ' + JSON.stringify({ case: 'snapshot_typical', bytes: JSON.stringify(snap).length, strokes: snap?.strokes?.length, points: 4000 }))
  await a.close()
  await b.close()
}

summary('rooms')

