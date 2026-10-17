const ADJECTIVES = [
  'Swift', 'Quiet', 'Bold', 'Lucky', 'Cosmic', 'Mellow', 'Zesty', 'Dapper',
  'Peppy', 'Witty', 'Sunny', 'Nimble', 'Cozy', 'Groovy', 'Cheeky', 'Vivid',
  'Chill', 'Spunky', 'Merry', 'Jolly', 'Perky', 'Snappy', 'Breezy', 'Dizzy',
]

const ANIMALS = [
  'Otter', 'Fox', 'Panda', 'Narwhal', 'Gecko', 'Quokka', 'Heron', 'Lynx',
  'Manatee', 'Raven', 'Tapir', 'Axolotl', 'Badger', 'Civet', 'Dormouse',
  'Egret', 'Ferret', 'Gibbon', 'Ibis', 'Jaguar', 'Kudu', 'Lemur', 'Mole',
  'Newt', 'Ocelot', 'Puffin', 'Quail', 'Sloth', 'Toucan', 'Yak',
]

const STORAGE_KEY = 'dabble:identity'

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)]
}

function randomGuestName() {
  return `${randomFrom(ADJECTIVES)} ${randomFrom(ANIMALS)}`
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID()
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function loadIdentity() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed?.id && parsed?.name) return parsed
    }
  } catch {
    // corrupted storage — fall through and regenerate
  }
  const identity = { id: randomId(), name: randomGuestName() }
  saveIdentity(identity)
  return identity
}

export function saveIdentity(identity) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity))
}
