import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput, useStdin } from 'ink'
import { useTheme } from '../theme'
import { useT } from '../lib/i18n'
import { listSessions, type SessionMeta } from '../lib/sessions'
import { fitToWidth } from '../lib/text'

const PAD = 1

interface Props {
  width: number
  rows: number
  onSelect: (id: string) => void
  onCancel: () => void
}

// A short "3m ago" / "2h ago" / "5d ago" relative age for a save time.
function ago(ms: number, t: ReturnType<typeof useT>): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return t('resume.justNow')
  const m = Math.floor(s / 60)
  if (m < 60) return t('resume.minsAgo', { n: m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('resume.hoursAgo', { n: h })
  return t('resume.daysAgo', { n: Math.floor(h / 24) })
}

// The /resume overlay: a newest-first list of saved sessions. Picking one remounts
// the app seeded with that session's transcript (see app.tsx onResume). Mirrors
// ThemePicker's keyboard + hover/click/wheel handling.
export function SessionPicker({ width, rows, onSelect, onCancel }: Props): React.ReactElement {
  const colors = useTheme()
  const t = useT()
  const { stdin } = useStdin()
  const sessions = useRef<SessionMeta[]>(listSessions()).current
  // Leave room for title/subtitle/blank + blank/footer; cap the visible rows.
  const maxRows = Math.max(3, rows - 7)
  const shown = sessions.slice(0, maxRows)
  const [index, setIndex] = useState(0)
  const onSelectRef = useRef(onSelect); onSelectRef.current = onSelect

  useInput((input, key) => {
    if (key.escape) { onCancel(); return }
    if (shown.length === 0) return
    if (key.return) { onSelect(shown[index].id); return }
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
  // modes (?1000h?1002h?1006h) so the wheel keeps scrolling the transcript instead
  // of falling back to ↑/↓ arrows on single-mouse-mode terminals.
  useEffect(() => {
    const out = process.stdout
    try { out.write('\x1b[?1003h') } catch { /* best-effort */ }
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
          if (release) onSelectRef.current(shown[real].id)
          else setIndex((i) => (i === real ? i : real))
        }
      }
    }
    stdin?.on('data', onData)
    return () => { stdin?.off('data', onData); try { out.write('\x1b[?1003l\x1b[?1000h\x1b[?1002h\x1b[?1006h') } catch { /* best-effort */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdin])

  const titleW = Math.max(10, width - 24) // leave a right column for the age/count

  return (
    <Box flexDirection="column" width={width} paddingX={PAD}>
      <Text bold color={colors.accent}>{t('resume.title')}</Text>
      <Text color={colors.dim}>{t('resume.subtitle')}</Text>
      <Text> </Text>
      {shown.length === 0 ? (
        <Text color={colors.dim}>{t('resume.empty')}</Text>
      ) : (
        shown.map((sess, i) => {
          const cursor = i === index
          const meta = t('resume.meta', { n: sess.messageCount, age: ago(sess.savedAt, t) })
          return (
            <Text key={sess.id} color={cursor ? colors.accentBright : colors.text} wrap="truncate">
              {cursor ? '❯ ' : '  '}{i + 1}. {fitToWidth(sess.title, titleW)}  <Text color={colors.dim}>{meta}</Text>
            </Text>
          )
        })
      )}
      <Text> </Text>
      <Text color={colors.dim}>{t('resume.footer')}</Text>
    </Box>
  )
}
