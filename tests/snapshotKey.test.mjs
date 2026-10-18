import { SNAPSHOT_KEY_RE, previewKey, snapshotKey } from '../src/lib/snapshotKey.js'

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

// Every key our render job can produce must be one the OG endpoint will
// accept; a key we start writing and then refuse would silently drop the
// project to the placeholder image.
const dates = [
  new Date('2026-10-18T00:54:47.102Z'),
  new Date('2026-10-18T00:54:47.000Z'),
  new Date('2026-12-31T23:59:59.999Z'),
  new Date('2027-01-01T00:00:00.000Z'),
  new Date('2100-02-28T12:00:00.500Z'),
  new Date(0),
]
for (const date of dates) {
  const key = snapshotKey(date)
  check(`snapshot key ${key} is accepted`, SNAPSHOT_KEY_RE.test(key), `for ${date.toISOString()}`)

  const preview = previewKey(key)
  check(`preview key ${preview} is accepted`, SNAPSHOT_KEY_RE.test(preview))
  check('preview shares the snapshot stem', preview === `${key.slice(0, -4)}.jpg`, preview)
  check('snapshot keys end in .png, previews in .jpg',
    key.endsWith('.png') && preview.endsWith('.jpg'), preview)
}

check('a date without milliseconds still gets a clean key',
  snapshotKey(new Date('2026-10-18T00:54:47Z')) === '2026-10-18T00-54-47Z.png',
  snapshotKey(new Date('2026-10-18T00:54:47Z')))
check('previewKey appends .jpg to anything else', previewKey('board') === 'board.jpg')

// What the endpoint must refuse: the key reaches a Location header, so path
// separators, traversal, dot files, escapes and whitespace all have to die here.
const refused = [
  '',
  '../secret.png',
  'a/b.png',
  '/abs.png',
  '.hidden.png',
  'x.png/../../y',
  'key with space.png',
  'key\n.png',
  'key.png%2f..',
  'key;drop.png',
  'é.png',
  '..',
]
for (const candidate of refused) {
  check(`refuses ${JSON.stringify(candidate)}`, !SNAPSHOT_KEY_RE.test(candidate))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
