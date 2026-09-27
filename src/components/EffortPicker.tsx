import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from '../theme'
import { useT } from '../lib/i18n'
import { EFFORT_LEVELS, type EffortLevel } from '../lib/settings'
import { displayWidth } from '../lib/text'

const PAD = 1
const GAP = 3 // spaces between adjacent level labels

// A slider stop: one of the five effort levels, or the special "ultracode" stop
// beyond `max` (effort xhigh + workflow orchestration), drawn after a divider.
export type EffortChoice = { kind: 'level'; level: EffortLevel } | { kind: 'ultracode' }

const POSITIONS: EffortChoice[] = [
  ...EFFORT_LEVELS.map((level) => ({ kind: 'level' as const, level })),
  { kind: 'ultracode' as const },
]

const sameChoice = (a: EffortChoice, b: EffortChoice): boolean =>
  a.kind === b.kind && (a.kind === 'level' && b.kind === 'level' ? a.level === b.level : true)

// The violet "charge-up" ripple that fills the panel when the slider lands on
// ultracode: dark→bright shades, chosen per cell so an outward-travelling wave
// reads as a pixelated ripple diffusing across the whole panel.
const PURPLE = ['#3b0764', '#4c1d95', '#5b21b6', '#6d28d9', '#7c3aed', '#8b5cf6', '#a78bfa']
const FILL_FG = '#f5f3ff' // near-white text drawn over the violet flood
const ANIM_MS = 80        // ms per tick (runs continuously while on ultracode)
const FILL_TICKS = 12     // ticks for the flood front to grow from center → full
const RING = 6.5          // cells between successive ripple crests
const WAVE_SPEED = 1.15   // cells a crest advances outward per tick
const VY = 2.1            // vertical weight (cells are ~2× taller than wide)

interface Props {
  current: EffortChoice
  width: number
  onSelect: (choice: EffortChoice, sessionOnly: boolean) => void
  onCancel: () => void
}

// One laid-out label with its content-column span (0-based, inclusive) and center.
interface Seg { label: string; start: number; end: number; center: number }

// One display column of a rendered row (a wide CJK char leaves an empty
// continuation cell in its second column so rows stay column-aligned).
interface Cell { ch: string; color: string; bold: boolean }

// Lay the stop labels out across the full track width `targetW`, spreading them
// with EQUAL gaps edge-to-edge (low flush left, ultracode flush right) so the
// slider stretches with the terminal instead of bunching on the left. The
// divider ("│") is centred in the gap between the last level (max) and ultracode.
// Returns the segments and the divider column (−1 if <2 stops).
function layout(labels: string[], targetW: number): { segs: Seg[]; dividerCol: number } {
  const n = labels.length
  const widths = labels.map((l) => displayWidth(l))
  const sumW = widths.reduce((a, b) => a + b, 0)
  const slack = Math.max(n - 1, targetW - sumW) // total blank to spread; ≥1 col/gap
  const baseGap = Math.floor(slack / (n - 1))
  const extra = slack - baseGap * (n - 1) // first `extra` gaps get +1 so it sums exactly
  const segs: Seg[] = []
  let col = 0
  for (let i = 0; i < n; i++) {
    if (i > 0) col += baseGap + (i - 1 < extra ? 1 : 0)
    const start = col
    const end = col + widths[i] - 1
    segs.push({ label: labels[i], start, end, center: Math.floor((start + end) / 2) })
    col = end + 1
  }
  const dividerCol = n >= 2 ? Math.floor((segs[n - 2].end + segs[n - 1].start) / 2) : -1
  return { segs, dividerCol }
}

// Lay a string into per-display-column cells; a wide (CJK) char occupies its
// first column and leaves an empty continuation cell in the next.
function toCells(s: string, color: string, bold = false): Cell[] {
  const out: Cell[] = []
  for (const g of s) {
    const w = Math.max(1, displayWidth(g))
    out.push({ ch: g, color, bold })
    for (let k = 1; k < w; k++) out.push({ ch: '', color, bold })
  }
  return out
}

// The /effort overlay: a Faster↔Smarter slider mirroring Claude Code's picker.
// Rendered inline in place of the input box (the transcript stays visible above);
// keyboard-only, no mouse. Enter confirms + persists; `s` applies for this
// session only. Landing on the ultracode stop floods the panel with a violet
// ripple that diffuses outward from the slider until it covers the whole panel.
export function EffortPicker({ current, width, onSelect, onCancel }: Props): React.ReactElement {
  const colors = useTheme()
  const t = useT()
  const startIdx = Math.max(0, POSITIONS.findIndex((p) => sameChoice(p, current)))
  const [index, setIndex] = useState(startIdx)

  const labels = POSITIONS.map((p) => (p.kind === 'level' ? p.level : t('effort.ultracode')))
  const sub = t('effort.ultracodeSub')

  // The panel spans the full input-area width so the slider bar and the violet
  // ripple fill the ENTIRE bottom edge-to-edge — but never narrower than what the
  // content needs: a minimum track (labels + a gap each), the title, footer, and
  // the right-aligned sub-line. layout() then spreads the stops across panelW.
  const minTrackW = labels.reduce((s, l) => s + displayWidth(l), 0) + (labels.length - 1) * GAP
  const subLineW = displayWidth(sub)
  const titleW = displayWidth(t('effort.title'))
  const footerW = displayWidth(t('effort.footer'))
  const panelW = Math.max(minTrackW, subLineW, titleW, footerW, width - PAD * 2)
  const { segs, dividerCol } = useMemo(() => layout(labels, panelW), [labels.join('|'), panelW])

  useInput((input, key) => {
    if (key.escape) { onCancel(); return }
    if (key.return) { onSelect(POSITIONS[index], false); return }
    if (key.leftArrow) { setIndex((i) => Math.max(0, i - 1)); return }
    if (key.rightArrow) { setIndex((i) => Math.min(POSITIONS.length - 1, i + 1)); return }
    if (input === 's' || input === 'S') { onSelect(POSITIONS[index], true); return }
  })

  // ultracode ripple: while the slider sits on the last stop a tick counter runs
  // continuously; the flood front grows to cover the panel over FILL_TICKS and
  // then holds, while travelling crests keep rippling outward. Stepping away
  // resets it.
  const atUltra = POSITIONS[index].kind === 'ultracode'
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!atUltra) { setTick(0); return }
    setTick(0)
    const id = setInterval(() => setTick((x) => x + 1), ANIM_MS)
    return () => clearInterval(id)
  }, [atUltra])

  // Stable per-cell noise so the ripple front is ragged/pixelated but doesn't
  // reshuffle every frame (only the travelling phase moves).
  const noise = useMemo(() => Array.from({ length: 12 }, () => Array.from({ length: 640 }, () => Math.random())), [])

  const header =
    t('effort.faster') +
    ' '.repeat(Math.max(1, panelW - displayWidth(t('effort.faster')) - displayWidth(t('effort.smarter')))) +
    t('effort.smarter')

  // Every row as a column-aligned Cell[] (padded to panelW) so the flood overlay
  // walks the same grid. Rows: title, blank, header, track, labels, sub, blank,
  // footer.
  const rows = useMemo<Cell[][]>(() => {
    const pad = (cells: Cell[]): Cell[] => {
      if (cells.length >= panelW) return cells
      const out = cells.slice()
      while (out.length < panelW) out.push({ ch: ' ', color: colors.dim, bold: false })
      return out
    }
    const track: Cell[] = Array.from({ length: panelW }, () => ({ ch: ' ', color: colors.dim, bold: false }))
    // The slider bar spans the FULL panel width (更快 ↔ 更强 at the ends), not just
    // the clustered stops, so it stretches with the terminal like the input box.
    for (let c = 0; c < panelW; c++) track[c] = { ch: '─', color: colors.dim, bold: false }
    if (dividerCol >= 0) track[dividerCol] = { ch: '┆', color: colors.dim, bold: false }
    track[segs[index].center] = { ch: '▲', color: colors.accentBright, bold: true }
    const lab: Cell[] = Array.from({ length: panelW }, () => ({ ch: ' ', color: colors.dim, bold: false }))
    if (dividerCol >= 0) lab[dividerCol] = { ch: '│', color: colors.dim, bold: false }
    segs.forEach((seg, i) => {
      const isCurrent = i === index
      const isUltra = i === segs.length - 1
      const color = isCurrent ? colors.accentBright : isUltra ? colors.accent : colors.text
      for (let c = seg.start, k = 0; c <= seg.end; c++, k++) lab[c] = { ch: seg.label[k] ?? ' ', color, bold: isCurrent }
    })
    return [
      pad(toCells(t('effort.title'), colors.accent, true)),
      pad([]),
      pad(toCells(header, colors.dim)),
      track,
      lab,
      pad(toCells(' '.repeat(Math.max(0, panelW - subLineW)) + sub, colors.dim)),
      pad([]),
      pad(toCells(t('effort.footer'), colors.dim)),
    ]
  }, [segs, index, dividerCol, panelW, subLineW, sub, colors, header, t])

  // Flood geometry: centred on the ultracode stop near the track/label rows,
  // growing to cover the panel's bounding box (panelW × row count).
  const W = panelW
  const H = rows.length
  const cx = segs[segs.length - 1].center
  const cy = 4 // labels row index
  const maxDist = useMemo(() => {
    const corners = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]]
    return Math.max(...corners.map(([x, y]) => Math.hypot(x - cx, (y - cy) * VY)))
  }, [W, H, cx])
  const fillRadius = atUltra ? Math.min(1, tick / FILL_TICKS) * (maxDist + 3) : 0

  const bgAt = (row: number, col: number): string | undefined => {
    if (fillRadius <= 0 || col >= W) return undefined
    const d = Math.hypot(col - cx, (row - cy) * VY)
    const n = noise[row]?.[col] ?? 0.5
    if (d > fillRadius - n * 2.2) return undefined // ragged, jittered growing front
    // Travelling crest: a sine in (distance − time) makes bright bands ripple
    // outward from the slider; distance-falloff keeps the core brighter; noise
    // roughens each cell so it reads pixelated rather than as smooth rings.
    const wave = Math.sin(((d - tick * WAVE_SPEED) / RING) * 2 * Math.PI) * 0.5 + 0.5
    const base = 1 - d / (maxDist || 1)
    const bright = base * 0.45 + wave * 0.4 + n * 0.15
    const idx = Math.round(bright * (PURPLE.length - 1))
    return PURPLE[Math.min(PURPLE.length - 1, Math.max(0, idx))]
  }

  const renderRow = (cells: Cell[], row: number): React.ReactElement => {
    const spans: { text: string; color: string; bold: boolean; bg?: string }[] = []
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c]
      const bg = bgAt(row, c)
      const color = bg ? FILL_FG : cell.color
      const last = spans[spans.length - 1]
      if (last && last.color === color && last.bold === cell.bold && last.bg === bg) last.text += cell.ch
      else spans.push({ text: cell.ch, color, bold: cell.bold, bg })
    }
    return (
      <Text key={row} wrap="truncate">
        {spans.map((sp, i) => (
          <Text key={i} color={sp.color} bold={sp.bold} backgroundColor={sp.bg}>{sp.text}</Text>
        ))}
      </Text>
    )
  }

  return (
    <Box flexDirection="column" width={Math.min(width, panelW + PAD * 2)} paddingX={PAD}>
      {rows.map((r, i) => renderRow(r, i))}
    </Box>
  )
}
