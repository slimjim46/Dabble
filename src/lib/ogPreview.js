// Where the 1200x630 Open Graph preview is cut out of the square paper.
//
// Letterboxing would keep the whole 2000x2000 board visible but leave white
// bars down both sides and shrink the drawing to a third of the frame, which
// looks like a broken image in a link preview. Instead the preview takes a
// full-width band as tall as the preview's aspect allows, positioned over the
// most ink on the board. This is the part that chooses the band's top edge:
// pure arithmetic over an ink profile, so it can be tested without a canvas.

/**
 * Top edge of the busiest band of `bandRows`, or of the central band when the
 * profile is empty. Ties (every window that holds all the ink counts the same)
 * go to the window nearest the middle, so a sparse board stays centred.
 *
 * @param {number[]} rowInk   ink per sampled row, index 0 at the top
 * @param {number} bandRows   band height in the same rows
 * @returns {number} row index of the band's top edge, always in range
 */
export function busiestBandTop(rowInk, bandRows) {
  const rows = rowInk.length
  const band = Math.round(bandRows)
  if (!(rows > 0) || !(band > 0)) return 0
  if (band >= rows) return 0

  const centre = (rows - band) / 2
  let total = 0
  for (let r = 0; r < rows; r++) total += rowInk[r]
  if (!(total > 0)) return Math.round(centre)

  let bestTop = 0
  let bestScore = -Infinity
  let bestDistance = Infinity
  for (let top = 0; top <= rows - band; top++) {
    let sum = 0
    for (let r = top; r < top + band; r++) sum += rowInk[r]
    const distance = Math.abs(top - centre)
    if (sum > bestScore || (sum === bestScore && distance < bestDistance)) {
      bestScore = sum
      bestTop = top
      bestDistance = distance
    }
  }
  return bestTop
}
