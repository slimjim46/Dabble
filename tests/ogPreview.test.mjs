import assert from 'node:assert/strict'
import { busiestBandTop } from '../src/lib/ogPreview.js'

let pass = 0
let fail = 0
function check(name, ok, extra) {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

const profile = (rows, ink) => Array.from({ length: rows }, (_, r) => (ink[r] ?? 0))

{
  // A band that is as tall as the profile just starts at the top.
  check('band covering everything starts at 0',
    busiestBandTop(profile(10, { 3: 5 }), 10) === 0)
}

{
  // Ink only near the top: the band must sit on it, and among the windows that
  // catch all of it (0..7 here) the one nearest the middle wins.
  const rows = profile(200, { 10: 4, 12: 4, 14: 4 })
  const top = busiestBandTop(rows, 105)
  check('band covers ink in the top corner', top <= 14 && top + 105 > 14, `top=${top}`)
  // windows 0..10 all hold every marked row; 10 is the one nearest the middle
  check('tie goes to the window nearest the middle', top === 10, `top=${top}`)
}

{
  // The busy end beats the middle.
  const rows = profile(200, {})
  for (let r = 60; r < 70; r++) rows[r] = 10
  const top = busiestBandTop(rows, 30)
  check('busy rows are chosen over the empty centre', top === 60, `top=${top}`)
}

{
  // Two clusters, one denser.
  const rows = profile(200, {})
  for (let r = 0; r < 5; r++) rows[r] = 3 // 15 total, near the top
  for (let r = 90; r < 100; r++) rows[r] = 4 // 40 total, near the middle
  const top = busiestBandTop(rows, 60)
  check('the denser cluster wins', top <= 90 && top + 60 > 100, `top=${top}`)
}

{
  // Nothing drawn: the frame stays centred.
  const top = busiestBandTop(profile(200, {}), 105)
  check('empty canvas centred', Math.abs(top - 48) <= 1, `top=${top}`)
}

{
  // Always a legal offset, whatever comes in.
  const rows = profile(200, { 0: 9, 199: 9 })
  for (const band of [1, 105, 200, 500]) {
    const top = busiestBandTop(rows, band)
    const span = Math.min(Math.round(band), 200)
    check(`offset stays in range for band ${band}`, top >= 0 && top + span <= 200, `top=${top}`)
  }
}

{
  // Degenerate inputs resolve to 0 rather than throwing.
  check('empty profile', busiestBandTop([], 105) === 0)
  check('zero band', busiestBandTop(profile(200, { 5: 1 }), 0) === 0)
  check('negative band', busiestBandTop(profile(200, { 5: 1 }), -3) === 0)
  check('NaN band', busiestBandTop(profile(200, { 5: 1 }), Number.NaN) === 0)
}

assert.ok(true)
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
