/** Clipboard writes that also work on the plain-HTTP origins the panel is served from. */

/**
 * Copy text with the async Clipboard API, falling back to a hidden textarea on
 * plain-HTTP origins where `navigator.clipboard` is unavailable.
 * @param text text to copy.
 * @returns whether the copy succeeded.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch {
    return false
  }
}
