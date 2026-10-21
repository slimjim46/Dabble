// Live check of the custom-words flow (v2 Phase 4c), run after the fast dev
// worker has been deployed: the host sets words over HTTP (filtered in the
// Worker), a blocked word is refused, a malformed list is refused, and the next
// game draws only from the custom list. Standalone (not *.test.mjs).
//
//   ROOMS_ALLOWED_URL=https://dabble-rooms-dev-fast.rowan-dev-workers.workers.dev \
//     node tests/word-custom-live.mjs
import { anonUser, check, connect, createRoom, summary, TARGET, TEST_IP } from './helpers.mjs'

const host = await anonUser()
const { body } = await createRoom(host.token)
const code = body.code

async function setWords(token, words) {
  const res = await fetch(`${TARGET}/rooms/${code}/words`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', 'X-Test-IP': TEST_IP },
    body: JSON.stringify({ words }),
  })
  let b = null
  try { b = await res.json() } catch {}
  return { status: res.status, body: b }
}

// A blocked word is refused by the Worker's filter (422), nothing stored.
const blocked = await setWords(host.token, ['badword', 'dog', 'cat'])
check('custom: a blocked word is refused', blocked.status === 422 && blocked.body?.error === 'word_rejected', JSON.stringify(blocked))

// A malformed list is refused (400).
const bad = await setWords(host.token, ['dog'])
check('custom: a too-short list is refused', bad.status === 400 && bad.body?.error === 'bad_words', JSON.stringify(bad))

// A clean list is accepted.
const ok = await setWords(host.token, ['tiger', 'rocket', 'castle', 'pizza'])
check('custom: a clean list is accepted', ok.status === 200 && ok.body?.count === 4, JSON.stringify(ok))

// Second player joins, then start: the first pick must come from the custom
// list. The HOST must connect first — if a guest joins before the host, the
// guest is promoted to host (the room has no seated host yet) and the host's
// start is rightly ignored.
const guest = await anonUser()
const hostConn = await connect(code, host.token)
const guestConn = await connect(code, guest.token)

hostConn.ws.send(JSON.stringify({ v: 1, t: 'start' }))
const pick = await hostConn.waitFor((m) => m.t === 'state' && m.phase === 'pick', 5000)
check('custom: the game enters the pick phase', !!pick, JSON.stringify(pick))
const wp = await hostConn.waitFor((m) => m.t === 'word_pick', 5000)
const custom = ['tiger', 'rocket', 'castle', 'pizza']
check('custom: the options all come from the custom list',
  !!wp && wp.options.length === 3 && wp.options.every((w) => custom.includes(w)), JSON.stringify(wp?.options))

await hostConn.close()
await guestConn.close()
summary('word-custom-live')
