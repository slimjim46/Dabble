// Draft persistence for the daily challenge. The in-progress strokes are kept
// in localStorage keyed by entry id, so a refresh mid-attempt restores the
// same drawing. Every access is wrapped in try/catch (private mode / full
// storage must never break the drawing) and the draft is cleared on submit.
const PREFIX = 'dabble:daily:draft:'

export function draftKey(entryId) {
  return `${PREFIX}${entryId}`
}

export function saveDraft(entryId, strokes) {
  try {
    localStorage.setItem(draftKey(entryId), JSON.stringify(strokes))
  } catch {
    // Storage unavailable or full: drawing still works, it just won't survive
    // a refresh.
  }
}

export function loadDraft(entryId) {
  try {
    const raw = localStorage.getItem(draftKey(entryId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function clearDraft(entryId) {
  try {
    localStorage.removeItem(draftKey(entryId))
  } catch {
    // Nothing useful to do.
  }
}
