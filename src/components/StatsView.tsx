import React, { useMemo } from 'react'
import { Box, Text } from 'ink'
import { useTheme, type ThemeColors } from '../theme'
import {
  loadStats, overview, modelBreakdown, heatmap, rangeTotals,
  funFact, type Range, type StatsStore,
} from '../lib/stats'
import { fmtTokens, fmtDuration, bar } from '../lib/usage'
import { fmtUsd } from '../lib/pricing'

// The Stats tab body: a lifetime dashboard modeled on GitHub's contribution
// graph. Two sub-views — Overview (headline numbers + an activity heatmap) and
// Models (per-model token share). Purely presentational: the parent
// (SettingsPanel) owns the sub/range selection and passes them as props; the
// lifetime store is read from ~/.anycode/stats.json (see lib/stats).

export type StatsSub = 'overview' | 'models'

interface Props {
  width: number
  rows: number       // panel body height — decides whether the heatmap fits
  sub: StatsSub
  range: Range
  focusRow?: number  // which selector row has the ↑↓ focus cursor: 0 = view, 1 = range
}

// A heatmap bucket (0..4, or -1 for a future day) → a glyph + theme color: an
// intensity ramp over the accent shades, with block density reinforcing it.
function bucketStyle(b: number, c: ThemeColors): { ch: string; color: string } {
  switch (b) {
    case 0: return { ch: '░', color: c.dim }
    case 1: return { ch: '▒', color: c.accentDim }
    case 2: return { ch: '▒', color: c.accent }
    case 3: return { ch: '▓', color: c.accentBright }
    case 4: return { ch: '█', color: c.accentBright }
    default: return { ch: ' ', color: c.dim }
  }
}

// Sun→Sat labels; only Mon/Wed/Fri are shown (like GitHub) to reduce noise.
const WEEKDAYS = ['   ', 'Mon', '   ', 'Wed', '   ', 'Fri', '   ']

// "label   value" line used throughout the overview column.
function Stat({ label, value, colors, w }: { label: string; value: string; colors: ThemeColors; w: number }): React.ReactElement {
  return (
    <Text wrap="truncate"><Text color={colors.dim}>{label.padEnd(w)}</Text><Text color={colors.text}>{value}</Text></Text>
  )
}

function ActivityHeatmap({ store, width, colors }: { store: StatsStore; width: number; colors: ThemeColors }): React.ReactElement {
  // Fit week-columns to the width (4-char row label + 1 char/week), max a year.
  const weeks = Math.max(8, Math.min(52, width - 8))
  const hm = useMemo(() => heatmap(store, weeks), [store, weeks])
  // Month labels aligned over the column each month starts on (3 chars each).
  const buf: string[] = new Array(hm.weeks).fill(' ')
  hm.monthLabels.forEach((m, c) => { if (m) for (let i = 0; i < 3 && c + i < hm.weeks; i++) buf[c + i] = m[i] })
  const monthRow = '    ' + buf.join('')
  return (
    <Box flexDirection="column">
      <Text color={colors.dim}>{monthRow}</Text>
      {[0, 1, 2, 3, 4, 5, 6].map((r) => (
        <Text key={r}>
          <Text color={colors.dim}>{WEEKDAYS[r]} </Text>
          {hm.cells[r].map((b, c) => {
            const s = bucketStyle(b, colors)
            return <Text key={c} color={s.color}>{s.ch}</Text>
          })}
        </Text>
      ))}
      <Text>
        <Text color={colors.dim}>Less </Text>
        {[0, 1, 2, 3, 4].map((b) => {
          const s = bucketStyle(b, colors)
          return <Text key={b} color={s.color}>{s.ch}</Text>
        })}
        <Text color={colors.dim}> More</Text>
      </Text>
    </Box>
  )
}

function Overview({ store, width, rows, range, colors, focused }: { store: StatsStore; width: number; rows: number; range: Range; colors: ThemeColors; focused: boolean }): React.ReactElement {
  const ov = overview(store)
  const rt = rangeTotals(store, range)
  const w = 18
  const fav = ov.favoriteModel ? ov.favoriteModel.model : '—'
  const most = ov.mostActiveDay ? `${ov.mostActiveDay.day} (${fmtTokens(ov.mostActiveDay.tokens)})` : '—'
  const ff = funFact(ov.totalTokens)
  // The heatmap only appears when the overview body has room for all of it
  // (≈11 stat lines + a spacer + the 9-row graph); otherwise it is dropped so the
  // Stats tab never spills past the panel's height budget.
  const showHeat = rows >= 21
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={focused ? colors.accentBright : colors.dim}>{focused ? '❯ ' : '  '}Range </Text>
        {(['all', '30d', '7d'] as Range[]).map((rg) => (
          <Text key={rg} inverse={rg === range} bold={rg === range} color={rg === range ? undefined : colors.dim}>{` ${rg} `}</Text>
        ))}
      </Text>
      <Text> </Text>
      <Stat label="Cost (range)" value={fmtUsd(rt.cost)} colors={colors} w={w} />
      <Stat label="Tokens (range)" value={`${fmtTokens(rt.tokens)}  ·  ${rt.turns} turns`} colors={colors} w={w} />
      <Stat label="Active days" value={String(rt.activeDays)} colors={colors} w={w} />
      <Stat label="Sessions" value={String(ov.sessions)} colors={colors} w={w} />
      <Stat label="Streak" value={`${ov.currentStreak} days · longest ${ov.longestStreak}`} colors={colors} w={w} />
      <Stat label="Longest session" value={fmtDuration(ov.longestSessionMs)} colors={colors} w={w} />
      <Stat label="Most active day" value={most} colors={colors} w={w} />
      <Stat label="Top model" value={fav} colors={colors} w={w} />
      {ff ? <Text color={colors.accentDim}>{ff}</Text> : null}
      {showHeat ? <Text> </Text> : null}
      {showHeat ? <ActivityHeatmap store={store} width={width} colors={colors} /> : null}
    </Box>
  )
}

function Models({ store, colors }: { store: StatsStore; colors: ThemeColors }): React.ReactElement {
  const list = modelBreakdown(store)
  if (list.length === 0) return <Text color={colors.dim}>No model usage recorded yet.</Text>
  const nameW = Math.min(28, Math.max(8, ...list.map((r) => r.model.length)))
  return (
    <Box flexDirection="column">
      <Text bold color={colors.accent}>Models by tokens (all-time)</Text>
      <Text> </Text>
      {list.slice(0, 8).map((r) => (
        <Text key={r.model} wrap="truncate">
          <Text color={colors.text}>{r.model.padEnd(nameW).slice(0, nameW)}</Text>
          {'  '}<Text color={colors.accent}>{bar(r.pct, 10)}</Text>
          {'  '}<Text color={colors.dim}>{`${fmtTokens(r.tokens)}  ${Math.round(r.pct * 100)}%`}</Text>
        </Text>
      ))}
    </Box>
  )
}

export function StatsView({ width, rows, sub, range, focusRow = 0 }: Props): React.ReactElement {
  const colors = useTheme()
  const store = useMemo(() => loadStats(), [])
  const empty = store.sessions === 0 && Object.keys(store.days).length === 0
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={focusRow === 0 ? colors.accentBright : colors.dim}>{focusRow === 0 ? '❯ ' : '  '}</Text>
        {(['overview', 'models'] as StatsSub[]).map((s) => (
          <Text key={s} inverse={s === sub} bold={s === sub} color={s === sub ? undefined : colors.dim}>{` ${s === 'overview' ? 'Overview' : 'Models'} `}</Text>
        ))}
      </Text>
      <Text> </Text>
      {empty ? (
        <Text color={colors.dim}>No lifetime stats yet — they accrue as you use AnyCode.</Text>
      ) : sub === 'overview' ? (
        <Overview store={store} width={width} rows={Math.max(1, rows - 2)} range={range} colors={colors} focused={focusRow === 1} />
      ) : (
        <Models store={store} colors={colors} />
      )}
    </Box>
  )
}
