// Mouse text-selection geometry for the owned viewport. The transcript renders
// as flat, one-row-per-line entries (see lib/transcript); a selection is an
// (anchor, head) pair of points in *absolute line index + display column* space.
// These helpers normalize the pair, decide which display-column span of a given
// line is selected, and slice a line into before/selected/after spans WITHOUT
// splitting grapheme clusters or corrupting the ANSI SGR codes that markdown
// lines carry (we strip ANSI on a selected line and re-color it plainly — losing
// markdown color on that one line while it's highlighted is an acceptable trade).
import { toGraphemes, displayWidth } from './text'

// A point in the flattened transcript: `line` is the absolute index into the
// full lines array, `col` is a 0-based display column (wide/CJK cells count 2).
export interface Pt { line: number; col: number }
export interface Selection { anchor: Pt; head: Pt }

const ANSI = /\x1b\[[0-9;]*m/g
export function stripAnsi(s: string): string { return s.replace(ANSI, '') }

// Order the pair so start ≤ end in (line, then col) reading order.
export function normSelection(sel: Selection): { start: Pt; end: Pt } {
  const { anchor: a, head: h } = sel
  const aFirst = a.line < h.line || (a.line === h.line && a.col <= h.col)
  return aFirst ? { start: a, end: h } : { start: h, end: a }
}

// True when the selection covers no cells (a bare click) — nothing to highlight.
export function isEmpty(sel: Selection): boolean {
  return sel.anchor.line === sel.head.line && sel.anchor.col === sel.head.col
}

// The [a,b) display-column span selected on absolute line `line` (plain text
// `text`), or null if this line is outside the selection or contributes nothing.
// The end column clamps to the line's own width so a selection dragged past the
// end of a short line still highlights only its real cells.
export function lineSpan(sel: Selection, line: number, text: string): { a: number; b: number } | null {
  const { start, end } = normSelection(sel)
  if (line < start.line || line > end.line) return null
  const w = displayWidth(text)
  const rawA = line === start.line ? start.col : 0
  const rawB = line === end.line ? end.col : w
  const a = Math.max(0, Math.min(rawA, rawB))
  const b = Math.min(w, Math.max(rawA, rawB))
  return b > a ? { a, b } : null
}

// Split a plain string into [before, selected, after] by display-column span.
// Each grapheme cluster is assigned whole to one region by where it starts, so a
// wide cluster straddling a boundary lands in the selection rather than tearing.
export function splitByCols(text: string, a: number, b: number): [string, string, string] {
  let col = 0
  let before = '', mid = '', after = ''
  for (const g of toGraphemes(text)) {
    const w = Math.max(1, displayWidth(g))
    if (col + w <= a) before += g
    else if (col >= b) after += g
    else mid += g
    col += w
  }
  return [before, mid, after]
}

// The selected substring across all lines, joined with newlines — what the
// deferred copy-on-select will hand to the clipboard. ANSI is stripped so the
// copied text is clean. `lines[i].text` is the flattened row at absolute index i.
export function selectedText(sel: Selection, lines: Array<{ text: string }>): string {
  const { start, end } = normSelection(sel)
  const parts: string[] = []
  for (let L = start.line; L <= end.line; L++) {
    const plain = stripAnsi(lines[L]?.text ?? '')
    const span = lineSpan(sel, L, plain)
    if (!span) { parts.push(''); continue }
    parts.push(splitByCols(plain, span.a, span.b)[1])
  }
  return parts.join('\n')
}
