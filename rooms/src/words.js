// Word prompts for the drawing game (v2 Phase 4). Every entry is tagged with
// a category and a difficulty, and every word is a single lowercase ASCII
// token so the wire validator, hints and guess matching stay as they are.
//
// Difficulty is our own judgement, used only to mix the three options a drawer
// is offered; category is a tag for later phases (daily challenge, filtering)
// and never crosses the wire. Nothing here is filtered: we author these words,
// so none of them is hostile. Untrusted custom words go through the blocked
// list in v2 Phase 4c instead.
import { MAX_CUSTOM_WORDS, MAX_WORD_LENGTH, MIN_CUSTOM_WORDS, MIN_WORD_LENGTH, WORD_OPTIONS } from './config.js'

export const WORDS = Object.freeze([
  // animals
  { word: 'bird', category: 'animals', difficulty: 'easy' },
  { word: 'dolphin', category: 'animals', difficulty: 'medium' },
  { word: 'dinosaur', category: 'animals', difficulty: 'hard' },
  { word: 'dragon', category: 'animals', difficulty: 'medium' },
  { word: 'eagle', category: 'animals', difficulty: 'medium' },
  { word: 'frog', category: 'animals', difficulty: 'easy' },
  { word: 'lion', category: 'animals', difficulty: 'easy' },
  { word: 'lizard', category: 'animals', difficulty: 'medium' },
  { word: 'monkey', category: 'animals', difficulty: 'medium' },
  { word: 'owl', category: 'animals', difficulty: 'easy' },
  { word: 'panda', category: 'animals', difficulty: 'medium' },
  { word: 'penguin', category: 'animals', difficulty: 'medium' },
  { word: 'pony', category: 'animals', difficulty: 'medium' },
  { word: 'rabbit', category: 'animals', difficulty: 'medium' },
  { word: 'shark', category: 'animals', difficulty: 'medium' },
  { word: 'snail', category: 'animals', difficulty: 'medium' },
  { word: 'snake', category: 'animals', difficulty: 'easy' },
  { word: 'spider', category: 'animals', difficulty: 'medium' },
  { word: 'squirrel', category: 'animals', difficulty: 'hard' },
  { word: 'tiger', category: 'animals', difficulty: 'easy' },
  { word: 'turtle', category: 'animals', difficulty: 'easy' },
  { word: 'whale', category: 'animals', difficulty: 'easy' },
  { word: 'zebra', category: 'animals', difficulty: 'easy' },

  // food
  { word: 'apple', category: 'food', difficulty: 'easy' },
  { word: 'cookie', category: 'food', difficulty: 'easy' },
  { word: 'lemon', category: 'food', difficulty: 'easy' },
  { word: 'mushroom', category: 'food', difficulty: 'medium' },
  { word: 'onion', category: 'food', difficulty: 'medium' },
  { word: 'orange', category: 'food', difficulty: 'easy' },
  { word: 'pizza', category: 'food', difficulty: 'easy' },
  { word: 'potato', category: 'food', difficulty: 'easy' },
  { word: 'pumpkin', category: 'food', difficulty: 'medium' },
  { word: 'sandwich', category: 'food', difficulty: 'medium' },
  { word: 'strawberry', category: 'food', difficulty: 'medium' },
  { word: 'tomato', category: 'food', difficulty: 'easy' },

  // objects
  { word: 'arrow', category: 'objects', difficulty: 'medium' },
  { word: 'basket', category: 'objects', difficulty: 'medium' },
  { word: 'bell', category: 'objects', difficulty: 'easy' },
  { word: 'book', category: 'objects', difficulty: 'easy' },
  { word: 'bucket', category: 'objects', difficulty: 'medium' },
  { word: 'camera', category: 'objects', difficulty: 'easy' },
  { word: 'candle', category: 'objects', difficulty: 'medium' },
  { word: 'chair', category: 'objects', difficulty: 'medium' },
  { word: 'coin', category: 'objects', difficulty: 'easy' },
  { word: 'crown', category: 'objects', difficulty: 'easy' },
  { word: 'cup', category: 'objects', difficulty: 'easy' },
  { word: 'door', category: 'objects', difficulty: 'easy' },
  { word: 'drum', category: 'objects', difficulty: 'easy' },
  { word: 'fence', category: 'objects', difficulty: 'medium' },
  { word: 'gift', category: 'objects', difficulty: 'easy' },
  { word: 'guitar', category: 'objects', difficulty: 'medium' },
  { word: 'hammer', category: 'objects', difficulty: 'medium' },
  { word: 'kettle', category: 'objects', difficulty: 'medium' },
  { word: 'key', category: 'objects', difficulty: 'easy' },
  { word: 'kite', category: 'objects', difficulty: 'medium' },
  { word: 'ladder', category: 'objects', difficulty: 'medium' },
  { word: 'lamp', category: 'objects', difficulty: 'easy' },
  { word: 'mailbox', category: 'objects', difficulty: 'hard' },
  { word: 'nest', category: 'objects', difficulty: 'medium' },
  { word: 'paint', category: 'objects', difficulty: 'medium' },
  { word: 'pencil', category: 'objects', difficulty: 'easy' },
  { word: 'piano', category: 'objects', difficulty: 'medium' },
  { word: 'pillow', category: 'objects', difficulty: 'medium' },
  { word: 'pocket', category: 'objects', difficulty: 'medium' },
  { word: 'robot', category: 'objects', difficulty: 'medium' },
  { word: 'rocket', category: 'objects', difficulty: 'medium' },
  { word: 'shovel', category: 'objects', difficulty: 'medium' },
  { word: 'snowman', category: 'objects', difficulty: 'medium' },
  { word: 'spoon', category: 'objects', difficulty: 'easy' },
  { word: 'table', category: 'objects', difficulty: 'easy' },
  { word: 'teapot', category: 'objects', difficulty: 'hard' },
  { word: 'tooth', category: 'objects', difficulty: 'easy' },
  { word: 'tower', category: 'objects', difficulty: 'medium' },
  { word: 'umbrella', category: 'objects', difficulty: 'medium' },
  { word: 'wagon', category: 'objects', difficulty: 'medium' },
  { word: 'window', category: 'objects', difficulty: 'easy' },

  // nature
  { word: 'beach', category: 'nature', difficulty: 'easy' },
  { word: 'cactus', category: 'nature', difficulty: 'medium' },
  { word: 'cloud', category: 'nature', difficulty: 'easy' },
  { word: 'comet', category: 'nature', difficulty: 'hard' },
  { word: 'flower', category: 'nature', difficulty: 'easy' },
  { word: 'forest', category: 'nature', difficulty: 'medium' },
  { word: 'garden', category: 'nature', difficulty: 'easy' },
  { word: 'island', category: 'nature', difficulty: 'medium' },
  { word: 'jungle', category: 'nature', difficulty: 'medium' },
  { word: 'moon', category: 'nature', difficulty: 'easy' },
  { word: 'mountain', category: 'nature', difficulty: 'medium' },
  { word: 'ocean', category: 'nature', difficulty: 'easy' },
  { word: 'planet', category: 'nature', difficulty: 'medium' },
  { word: 'plant', category: 'nature', difficulty: 'easy' },
  { word: 'rainbow', category: 'nature', difficulty: 'medium' },
  { word: 'star', category: 'nature', difficulty: 'easy' },
  { word: 'sun', category: 'nature', difficulty: 'easy' },
  { word: 'tree', category: 'nature', difficulty: 'easy' },
  { word: 'volcano', category: 'nature', difficulty: 'hard' },

  // vehicles
  { word: 'bicycle', category: 'vehicles', difficulty: 'medium' },
  { word: 'boat', category: 'vehicles', difficulty: 'easy' },
  { word: 'bus', category: 'vehicles', difficulty: 'easy' },
  { word: 'helicopter', category: 'vehicles', difficulty: 'hard' },
  { word: 'sailboat', category: 'vehicles', difficulty: 'hard' },
  { word: 'train', category: 'vehicles', difficulty: 'easy' },
  { word: 'truck', category: 'vehicles', difficulty: 'medium' },

  // places
  { word: 'bridge', category: 'places', difficulty: 'medium' },
  { word: 'castle', category: 'places', difficulty: 'medium' },
  { word: 'lighthouse', category: 'places', difficulty: 'hard' },

  // clothing
  { word: 'hat', category: 'clothing', difficulty: 'easy' },
  { word: 'jacket', category: 'clothing', difficulty: 'easy' },
  { word: 'mitten', category: 'clothing', difficulty: 'medium' },
  { word: 'scarf', category: 'clothing', difficulty: 'medium' },
  { word: 'shoe', category: 'clothing', difficulty: 'easy' },
  { word: 'sock', category: 'clothing', difficulty: 'easy' },
  { word: 'sweater', category: 'clothing', difficulty: 'medium' },

  // people
  { word: 'wizard', category: 'people', difficulty: 'hard' },
])

const DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard'])

function shuffle(list, rng) {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/** `count` distinct entries, partial Fisher-Yates on a copy. */
function sampleDistinct(list, count, rng) {
  const pool = [...list]
  const n = Math.min(count, pool.length)
  const out = []
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (pool.length - i))
    const tmp = pool[i]
    pool[i] = pool[j]
    pool[j] = tmp
    out.push(pool[i])
  }
  return out
}

/**
 * `count` distinct words from the curated list, mixed across difficulty: the
 * count is spread as evenly as possible over easy/medium/hard, then the result
 * is shuffled so the difficulty order is not predictable. `rng` is injectable
 * so the unit test can make it deterministic.
 */
export function pickWords(count = WORD_OPTIONS, rng = Math.random) {
  const buckets = { easy: [], medium: [], hard: [] }
  for (const entry of WORDS) buckets[entry.difficulty].push(entry.word)
  const n = Math.min(Math.max(1, count), WORDS.length)
  const per = Array(DIFFICULTIES.length).fill(Math.floor(n / DIFFICULTIES.length))
  let remainder = n % DIFFICULTIES.length
  for (let i = 0; i < DIFFICULTIES.length && remainder > 0; i++) {
    per[i]++
    remainder--
  }
  const picked = []
  for (let i = 0; i < DIFFICULTIES.length; i++) {
    picked.push(...sampleDistinct(buckets[DIFFICULTIES[i]], per[i], rng))
  }
  return shuffle(picked, rng)
}

/** `count` distinct words drawn uniformly from an arbitrary string list. */
export function pickFromPool(pool, count = WORD_OPTIONS, rng = Math.random) {
  return sampleDistinct(pool, count, rng)
}

/**
 * The options for the next pick: custom words when the room has enough of
 * them, otherwise the curated (difficulty-mixed) list. Custom words are
 * host-set and pre-filtered, so they are trusted here.
 */
export function pickOptions(customWords, count = WORD_OPTIONS, rng = Math.random) {
  if (Array.isArray(customWords) && customWords.length >= count) {
    return pickFromPool(customWords, count, rng)
  }
  return pickWords(count, rng)
}

// Custom-word shape: one lowercase ASCII token, MIN_WORD_LENGTH..MAX_WORD_LENGTH.
const CUSTOM_WORD_RE = /^[a-z]{3,40}$/

/**
 * Validate a host's custom-word list. Returns a cleaned array of distinct
 * words, or null when the list is malformed (wrong length, not a token, a
 * duplicate). Used by the Worker and the DO so both reject the same shapes.
 */
export function sanitizeCustomWords(input) {
  if (!Array.isArray(input)) return null
  if (input.length < MIN_CUSTOM_WORDS || input.length > MAX_CUSTOM_WORDS) return null
  const seen = new Set()
  const out = []
  for (const raw of input) {
    if (typeof raw !== 'string') return null
    if (raw.length < MIN_WORD_LENGTH || raw.length > MAX_WORD_LENGTH || !CUSTOM_WORD_RE.test(raw)) return null
    if (seen.has(raw)) return null
    seen.add(raw)
    out.push(raw)
  }
  return out
}
