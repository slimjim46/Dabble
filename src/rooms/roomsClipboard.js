/**
 * Copy a room code, in a secure context or not.
 *
 * navigator.clipboard is undefined on an insecure origin (http://<lan-ip>:5173
 * is a normal way to sit on the sofa and draw with someone), so the fallback
 * selects the text in place with createRange() + getSelection() and tells the
 * visitor to copy it. Nothing here throws: a blocked clipboard is an outcome,
 * not an error.
 *
 * @returns {'clipboard'|'selected'|'failed'}
 */
export async function copyText(text, { target, clipboard, document: doc } = {}) {
  const clip = clipboard ?? globalThis.navigator?.clipboard
  if (clip && typeof clip.writeText === 'function') {
    try {
      await clip.writeText(text)
      return 'clipboard'
    } catch {
      // Permission denied, insecure origin mid-navigation, disabled clipboard:
      // fall through to the selection path.
    }
  }

  const d = doc ?? globalThis.document
  if (!d || !target || typeof d.createRange !== 'function') return 'failed'
  try {
    const range = d.createRange()
    range.selectNodeContents(target)
    const selection = typeof d.getSelection === 'function' ? d.getSelection() : null
    if (!selection || typeof selection.addRange !== 'function') return 'failed'
    selection.removeAllRanges()
    selection.addRange(range)
    return 'selected'
  } catch {
    return 'failed'
  }
}
