import React, { useEffect, useRef, useState } from 'react'
import { PICKER_MOTION_ON, PICKER_MOTION_OFF } from '../lib/termmodes'
import { Box, Text, useInput, useStdin } from 'ink'
import { useTheme } from '../theme'
import { useT } from '../lib/i18n'
import { fmtTokens } from '../lib/usage'

// One choice in the /autocompact picker. `off` disables auto-compaction, `auto`
// tracks the model's own context window, and a number sets an explicit trigger
// window in tokens (the effective threshold is min(window, model context)).
export type AutoCompactChoice = { kind: 'off' } | { kind: 'auto' } | { kind: 'tokens'; tokens: number }

const PAD = 1

// Fixed token windows offered besides off/auto. Kept modest → large so the list
// spans common model context sizes without being exhaustive.
const TOKEN_OPTIONS = [32_000, 64_000, 100_000, 128_000, 200_000, 400_000, 1_000_000]

const OPTIONS: AutoCompactChoice[] = [
  { kind: 'auto' },
  { kind: 'off' },
  ...TOKEN_OPTIONS.map((tokens) => ({ kind: 'tokens' as const, tokens })),
]

function sameChoice(a: AutoCompactChoice, b: AutoCompactChoice): boolean {
  if (a.kind !== b.kind) return false
  return a.kind === 'tokens' && b.kind === 'tokens' ? a.tokens === b.tokens : true
}

interface Props {
  current: AutoCompactChoice
  modelLimit: number
  width: number
  rows: number
  onSelect: (choice: AutoCompactChoice) => void
  onCancel: () => void
}

// The /autocompact overlay: pick when auto-compaction fires. Mirrors
// SessionPicker's keyboard + hover/click/wheel handling; renders in place of the
// input cluster and owns the keyboard while open (see app.tsx).
export function AutoCompactPicker({ current, modelLimit, width, rows, onSelect, onCancel }: Props): React.ReactElement {
  const colors = useTheme()
  const t = useT()
  const { stdin } = useStdin()
  const startIdx = Math.max(0, OPTIONS.findIndex((o) => sameChoice(o, current)))
  const [index, setIndex] = useState(startIdx)
  const onSelectRef = useRef(onSelect); onSelectRef.current = onSelect

  const maxRows = Math.max(3, rows - 7)
  const shown = OPTIONS.slice(0, maxRows)

  const label = (o: AutoCompactChoice): string =>
    o.kind === 'auto' ? t('autocompact.auto')
      : o.kind === 'off' ? t('autocompact.off')
        : t('autocompact.tokens', { n: fmtTokens(o.tokens) })

  useInput((input, key) => {
    if (key.escape) { onCancel(); return }
    if (shown.length === 0) return
    if (key.return) { onSelect(shown[index]); return }
    if (key.upArrow) { setIndex((i) => (i - 1 + shown.length) % shown.length); return }
    if (key.downArrow) { setIndex((i) => (i + 1) % shown.length); return }
    if (/\x1b?\[<\d+;\d+;\d+[Mm]/.test(input) || /\x1b?\[M/.test(input)) return
    const n = Number(input)
    if (!Number.isNaN(n) && n >= 1 && n <= shown.length) setIndex(n - 1)
  })

  const listTop = 4
  const layoutRef = useRef({ firstItemRow: listTop, lastItemRow: listTop + shown.length - 1 })
  layoutRef.current = { firstItemRow: listTop, lastItemRow: listTop + shown.length - 1 }

  useEffect(() => {
    const out = process.stdout
    try { out.write(PICKER_MOTION_ON) } catch { /* best-effort */ }
    const onData = (buf: Buffer): void => {
      const s = buf.toString('utf8')
      const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
      let m: RegExpExecArray | null
      while ((m = re.exec(s)) !== null) {
        const L = layoutRef.current
        const b = Number(m[1]); const y = Number(m[3]); const release = m[4] === 'm'
        if (shown.length === 0) continue
        if (b === 64 || b === 65) {
          const d = b === 65 ? 1 : -1
          setIndex((i) => (i + d + shown.length) % shown.length)
          continue
        }
        if (y >= L.firstItemRow && y <= L.lastItemRow) {
          const real = y - L.firstItemRow
          if (real < 0 || real >= shown.length) continue
          if (release) onSelectRef.current(shown[real])
          else setIndex((i) => (i === real ? i : real))
        }
      }
    }
    stdin?.on('data', onData)
    return () => { stdin?.off('data', onData); try { out.write(PICKER_MOTION_OFF) } catch { /* best-effort */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdin])

  return (
    <Box flexDirection="column" width={width} paddingX={PAD}>
      <Text bold color={colors.accent}>{t('autocompact.title')}</Text>
      <Text color={colors.dim}>{t('autocompact.subtitle', { current: label(current), limit: fmtTokens(modelLimit) })}</Text>
      <Text> </Text>
      {shown.map((o, i) => {
        const cursor = i === index
        const mark = sameChoice(o, current) ? ' ←' : ''
        return (
          <Text key={i} color={cursor ? colors.accentBright : colors.text} wrap="truncate">
            {cursor ? '❯ ' : '  '}{i + 1}. {label(o)}<Text color={colors.dim}>{mark}</Text>
          </Text>
        )
      })}
      <Text> </Text>
      <Text color={colors.dim}>{t('autocompact.footer')}</Text>
    </Box>
  )
}
