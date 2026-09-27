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

/**
 * Pad or truncate `s` to exactly `cols` display columns — the display-width
 * analogue of `String.padEnd(n).slice(0, n)`, which miscounts CJK/wide glyphs.
 * Over-long input is ellipsis-truncated; shorter input is right-padded with
 * spaces so a column of labels aligns regardless of script.
 */
export function fitToWidth(s: string, cols: number): string {
  const t = truncateToWidth(s, cols)
  const pad = Math.max(0, cols - displayWidth(t))
  return t + ' '.repeat(pad)
}

/**
 * Hard-wrap `s` into segments each at most `maxCols` display columns wide,
 * breaking on grapheme boundaries (no word wrap — this is for code/log output
 * where a break can land anywhere). Always returns at least one segment, so an
 * empty string yields `['']` (one row). A single grapheme wider than `maxCols`
 * sits alone on its row rather than looping forever.
 */
export function wrapToWidth(s: string, maxCols: number): string[] {
  if (maxCols < 1) return [s]
  const out: string[] = []
  let cur = ''
  let used = 0
  for (const g of toGraphemes(s)) {
    const w = cellWidth(g)
    if (used + w > maxCols && cur !== '') { out.push(cur); cur = ''; used = 0 }
    cur += g
    used += w
  }
  out.push(cur)
  return out
}

/**
 * Expand tab characters to spaces so the string's measured width matches what a
 * terminal draws (string-width counts a raw '\t' as 0, but the terminal advances
 * to the next 8-column tab stop). `start` is the display column the string
 * begins at, so tab stops line up with the surrounding layout.
 */
export function expandTabs(s: string, start = 0): string {
  if (!s.includes('\t')) return s
  let out = ''
  let col = start
  for (const g of toGraphemes(s)) {
    if (g === '\t') { const n = 8 - (col % 8); out += ' '.repeat(n); col += n }
    else { out += g; col += cellWidth(g) }
  }
  return out
}

