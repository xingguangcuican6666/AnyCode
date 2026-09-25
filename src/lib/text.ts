import stringWidth from 'string-width'

/**
 * Text measurement helpers for the terminal. The input box and any horizontal
 * windowing must reason in *display columns* (a CJK/wide glyph is 2 columns, a
 * combining mark 0) and must never split a character mid-way, so all editing
 * works on grapheme clusters rather than UTF-16 code units.
 */

// Intl.Segmenter gives true grapheme clusters (emoji ZWJ sequences, flags,
// combining marks). Fall back to code-point splitting if it's unavailable —
// that still keeps surrogate pairs intact, just not multi-code-point clusters.
const segmenter =
  typeof Intl !== 'undefined' && typeof (Intl as { Segmenter?: unknown }).Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

export function toGraphemes(s: string): string[] {
  if (!s) return []
  if (segmenter) return Array.from(segmenter.segment(s), (seg) => seg.segment)
  return Array.from(s)
}

/** Display width in terminal columns. */
export function displayWidth(s: string): number {
  return stringWidth(s)
}

// A cluster occupies at least one column for cursor/layout purposes.
const cellWidth = (cluster: string): number => Math.max(1, displayWidth(cluster))

/**
 * Compute a horizontal window over `graphemes` that fits within `maxCols`
 * display columns and always keeps the cursor visible. Returns the visible
 * clusters and the cursor's index within them. Grows left from the cursor to
 * fill the budget, then extends right with whatever room remains — so long
 * lines scroll instead of breaking the box border.
 */
export function computeWindow(
  graphemes: string[],
  cursor: number,
  maxCols: number,
): { visible: string[]; rel: number } {
  const atEnd = cursor >= graphemes.length
  const caretW = atEnd ? 1 : cellWidth(graphemes[cursor])
  let budget = Math.max(0, maxCols - caretW)

  let start = cursor
  while (start > 0) {
    const w = cellWidth(graphemes[start - 1])
    if (w > budget) break
    budget -= w
    start--
  }

  let end = atEnd ? cursor : cursor + 1
  while (end < graphemes.length) {
    const w = cellWidth(graphemes[end])
    if (w > budget) break
    budget -= w
    end++
  }

  return { visible: graphemes.slice(start, end), rel: cursor - start }
}

/** Truncate a string to `maxCols` display columns, adding an ellipsis if cut. */
export function truncateToWidth(s: string, maxCols: number): string {
  if (displayWidth(s) <= maxCols) return s
  let out = ''
  let used = 0
  for (const cluster of toGraphemes(s)) {
    const w = cellWidth(cluster)
    if (used + w > Math.max(0, maxCols - 1)) break
    out += cluster
    used += w
  }
  return out + '…'
}
