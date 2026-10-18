// Object keys for the snapshots bucket, shared by both ends that care: the
// render job creates them (scripts/render-snapshot.mjs) and the OG endpoint
// accepts one into a Location header only after testing it with the same
// pattern (api/snapshot-latest.js). Keeping both in one file is what stops the
// two drifting — a key the renderer starts producing must never be a key the
// endpoint refuses, and vice versa.
//
// A bucket key is untrusted input by the time it reaches a Location header, so
// the pattern is deliberately narrow: an alphanumeric first character (a dot
// file or a leading ../ never passes), then only the characters an ISO
// timestamp, a hash-free filename and a .png/.jpg suffix can produce. No
// slashes, no traversal, no percent escapes, no control characters.

export const SNAPSHOT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Object key for a new snapshot: snapshots/<iso-timestamp>.png (bucket-relative). */
export function snapshotKey(date) {
  return `${date.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z')}.png`
}

/** Object key of the OG preview that accompanies a full PNG snapshot. */
export function previewKey(pngKey) {
  return pngKey.endsWith('.png') ? `${pngKey.slice(0, -4)}.jpg` : `${pngKey}.jpg`
}
