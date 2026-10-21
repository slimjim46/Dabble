// Rendering data for the room scoreboards (v2 Phase 3 scoreboards).
//
// Pure and dependency-free so tests/roomClient.test.mjs can exercise it
// directly. Two hard rules, both from the client contract:
//   - Scores and gains are only ever READ from the server's userId-keyed maps
//     (`state.scores`, `reveal.gains`). Nothing here adds, sums or otherwise
//     invents a number: the server only records a player once they are awarded
//     points, so a present player missing from a present map is an explicit 0,
//     while a frame with no map at all renders nothing (null).
//   - Identity comes only from the server's player list, looked up by userId.
//     A score whose owner has left the room (scores are never pruned on leave)
//     gets the placeholder name 'Player' and no flag — the value still counts,
//     so the ranks stay truthful.
// Sorting and rank numbers are display only; they never change a value. Ties
// share a rank number (1, 1, 3) via a stable sort: equal totals keep the
// players-list order, with departed entries after everyone still seated.

const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * One player's current total for the room's player list, or null when there is
 * no game frame yet (nothing to render). A present player missing from a
 * present map is 0 — the same rule as standings(); see the header comment.
 */
export function playerTotal(game, userId) {
  if (!game || game.phase === 'lobby' || !isMap(game.scores)) return null
  return game.scores[userId] ?? 0
}

/**
 * Ranked rows for the running board and the final standings, or null when the
 * frame carried no scores map (an older frame): render nothing for it.
 * Row: { userId, name, country, total, rank }.
 */
export function standings(game, players) {
  if (!game || !isMap(game.scores)) return null
  const scores = game.scores
  const rows = []
  const seen = new Set()
  for (const p of players) {
    if (!p || typeof p.userId !== 'string') continue
    seen.add(p.userId)
    rows.push({
      userId: p.userId,
      name: p.name,
      country: p.country ?? null,
      total: scores[p.userId] ?? 0,
    })
  }
  for (const [uid, total] of Object.entries(scores)) {
    if (seen.has(uid)) continue
    rows.push({ userId: uid, name: 'Player', country: null, total })
  }
  rows.sort((a, b) => b.total - a.total)
  let prevTotal = null
  rows.forEach((row, i) => {
    row.rank = prevTotal !== null && row.total === prevTotal ? rows[i - 1].rank : i + 1
    prevTotal = row.total
  })
  return rows
}

/**
 * Rows for this round's gains, shown beside the revealed word. A player with
 * no entry in the map gets nothing (unlike the running board: a gain really is
 * "nothing this round", not a default zero). A gainer who has since left the
 * room still appears as 'Player'. Null when the frame carried no gains map.
 * Row: { userId, name, country, points }, highest points first.
 */
export function gainRows(reveal, players) {
  if (!reveal || !isMap(reveal.gains)) return null
  const gains = reveal.gains
  const rows = []
  const seen = new Set()
  for (const p of players) {
    if (!p || typeof p.userId !== 'string') continue
    seen.add(p.userId)
    if (gains[p.userId] === undefined) continue
    rows.push({ userId: p.userId, name: p.name, country: p.country ?? null, points: gains[p.userId] })
  }
  for (const [uid, points] of Object.entries(gains)) {
    if (seen.has(uid)) continue
    rows.push({ userId: uid, name: 'Player', country: null, points })
  }
  rows.sort((a, b) => b.points - a.points)
  return rows
}
