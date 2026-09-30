import React, { useEffect, useRef, useState } from 'react'
import { PICKER_MOTION_ON, PICKER_MOTION_OFF } from '../lib/termmodes'
import { Box, Text, useInput, useStdin } from 'ink'
import { useTheme } from '../theme'
import { useT } from '../lib/i18n'
import { fitToWidth } from '../lib/text'
import { changedPathsSince } from '../lib/checkpoints'
import type { Message } from '../types'

const PAD = 1

interface Props {
  width: number
  rows: number
  messages: Message[]
  // Restore to just before the user turn `id` (both conversation and, when
  // checkpoints exist, code). The parent applies the rewind.
  onSelect: (id: string) => void
  onCancel: () => void
}

// One selectable restore point. `id` null is the synthetic "(current)" row, which
// just closes the menu without rewinding.
interface Point { id: string | null; label: string; files: number }

// First non-empty line of a user message, whitespace-collapsed, for the row label.
function preview(content: string): string {
  const line = content.split('\n').map((l) => l.trim()).find((l) => l) || content.trim()
  return line.replace(/\s+/g, ' ')
}

// The double-Esc Rewind overlay: pick an earlier user turn to restore the
// conversation (and code, when this session captured checkpoints) to the point
// before it. Mirrors SessionPicker's keyboard + hover/click/wheel handling.
export function RewindMenu({ width, rows, messages, onSelect, onCancel }: Props): React.ReactElement {
  const colors = useTheme()
  const t = useT()
  const { stdin } = useStdin()

  // Restore points = real user turns, oldest→newest, plus a trailing "(current)".
  const points = useRef<Point[]>(
    (() => {
      const turns = messages.filter((m) => m.role === 'user' && m.content.trim() && m.content !== '__banner__')
      const list: Point[] = turns.map((m) => ({
        id: m.id,
        label: preview(m.content),
        files: m.meta?.ts ? changedPathsSince(m.meta.ts).length : 0,
      }))
      list.push({ id: null, label: t('rewind.current'), files: 0 })
      return list
    })(),
  ).current

  // Leave room for title/subtitle/blank + blank/footer; show the most recent rows
  // (including "(current)") when there are more turns than fit.
  const maxRows = Math.max(3, rows - 7)
  const start = Math.max(0, points.length - maxRows)
  const shown = points.slice(start)
  // Default the cursor to the "(current)" row (last), matching the target UI.
  const [index, setIndex] = useState(shown.length - 1)
  const onSelectRef = useRef(onSelect); onSelectRef.current = onSelect
  const onCancelRef = useRef(onCancel); onCancelRef.current = onCancel

  const choose = (row: Point): void => {
    if (row.id === null) onCancelRef.current()
    else onSelectRef.current(row.id)
  }

  useInput((input, key) => {
    if (key.escape) { onCancel(); return }
    if (shown.length === 0) { onCancel(); return }
    if (key.return) { choose(shown[index]); return }
    if (key.upArrow) { setIndex((i) => (i - 1 + shown.length) % shown.length); return }
    if (key.downArrow) { setIndex((i) => (i + 1) % shown.length); return }
    if (/\x1b?\[<\d+;\d+;\d+[Mm]/.test(input) || /\x1b?\[M/.test(input)) return
    const n = Number(input)
    if (!Number.isNaN(n) && n >= 1 && n <= shown.length) setIndex(n - 1)
  })

  // Screen-row geometry for mouse hit-testing: title(1)/subtitle(2)/blank(3), then
  // the list. SGR y is 1-based.
  const listTop = 4
  const layoutRef = useRef({ firstItemRow: listTop, lastItemRow: listTop + shown.length - 1 })
  layoutRef.current = { firstItemRow: listTop, lastItemRow: listTop + shown.length - 1 }

  // Mouse: hover moves the highlight, click selects, wheel moves the cursor. Enable
  // any-motion reporting (?1003h) on mount; on unmount re-assert the app's base
  // modes so the wheel keeps scrolling the transcript afterwards.
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
          if (release) choose(shown[real])
          else setIndex((i) => (i === real ? i : real))
        }
      }
    }
    stdin?.on('data', onData)
    return () => { stdin?.off('data', onData); try { out.write(PICKER_MOTION_OFF) } catch { /* best-effort */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdin])

  const titleW = Math.max(10, width - 24) // leave a right column for the code-scope label

  return (
    <Box flexDirection="column" width={width} paddingX={PAD}>
      <Text bold color={colors.accent}>{t('rewind.title')}</Text>
      <Text color={colors.dim}>{t('rewind.subtitle')}</Text>
      <Text> </Text>
      {shown.length === 0 ? (
        <Text color={colors.dim}>{t('rewind.empty')}</Text>
      ) : (
        shown.map((row, i) => {
          const cursor = i === index
          const scope = row.id === null ? '' : row.files === 0 ? t('rewind.noCode') : t('rewind.filesChanged', { n: row.files })
          return (
            <Text key={row.id ?? '__current__'} color={cursor ? colors.accentBright : colors.text} wrap="truncate">
              {cursor ? '❯ ' : '  '}{fitToWidth(row.label, titleW)}  <Text color={colors.dim}>{scope}</Text>
            </Text>
          )
        })
      )}
      <Text> </Text>
      <Text color={colors.dim}>{t('rewind.footer')}</Text>
    </Box>
  )
}
