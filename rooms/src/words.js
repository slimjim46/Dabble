// Word prompts for the drawing game. Placeholder list for v2 Phase 3: no
// profanity list and no database table yet (that is Phase 4). Every entry is
// a single lowercase token so the wire validator and hints stay simple.
import { WORD_OPTIONS } from './config.js'

export const WORDS = Object.freeze([
  'apple', 'arrow', 'basket', 'beach', 'bell', 'bicycle', 'bird', 'boat',
  'book', 'bridge', 'bucket', 'bus', 'cactus', 'camera', 'candle', 'castle',
  'chair', 'cloud', 'coin', 'comet', 'cookie', 'crown', 'cup', 'dinosaur',
  'dolphin', 'door', 'dragon', 'drum', 'eagle', 'fence', 'flower', 'forest',
  'frog', 'garden', 'gift', 'guitar', 'hammer', 'hat', 'helicopter', 'island',
  'jacket', 'jungle', 'kettle', 'key', 'kite', 'ladder', 'lamp', 'lemon',
  'lighthouse', 'lion', 'lizard', 'mailbox', 'mitten', 'monkey', 'moon',
  'mountain', 'mushroom', 'nest', 'ocean', 'onion', 'orange', 'owl', 'paint',
  'panda', 'pencil', 'penguin', 'piano', 'pillow', 'pizza', 'planet', 'plant',
  'pocket', 'pony', 'potato', 'pumpkin', 'rabbit', 'rainbow', 'robot', 'rocket',
  'sailboat', 'sandwich', 'scarf', 'shark', 'shoe', 'shovel', 'snail', 'snake',
  'snowman', 'sock', 'spider', 'spoon', 'squirrel', 'star', 'strawberry', 'sun',
  'sweater', 'table', 'teapot', 'tiger', 'tomato', 'tooth', 'tower', 'train',
  'tree', 'truck', 'turtle', 'umbrella', 'volcano', 'wagon', 'whale', 'window',
  'wizard', 'zebra',
])

/**
 * `count` distinct words, chosen uniformly. Partial Fisher-Yates on a copy;
 * `rng` is injectable so the unit test can make it deterministic.
 */
export function pickWords(count = WORD_OPTIONS, rng = Math.random) {
  const n = Math.min(Math.max(1, count), WORDS.length)
  const pool = [...WORDS]
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (pool.length - i))
    const tmp = pool[i]
    pool[i] = pool[j]
    pool[j] = tmp
  }
  return pool.slice(0, n)
}
