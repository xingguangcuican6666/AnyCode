import React, { useEffect, useRef, useState } from 'react'
import { PICKER_MOTION_ON, PICKER_MOTION_OFF } from '../lib/termmodes'
import { Box, Text, useInput, useStdin } from 'ink'
import { themeList, getTheme, AUTO_THEME, useTheme, type ThemeColors } from '../theme'
import { useT } from '../lib/i18n'

interface Option { name: string; title: string }

// Auto first (resolves to light/dark at render time), then every concrete theme.
// The Auto row's label is localized at render time (see optionTitle); concrete
// themes keep their catalog titles.
const OPTIONS: Option[] = [
  { name: AUTO_THEME, title: 'Auto' },
  ...themeList().map((t) => ({ name: t.name, title: t.title })),
]

const PAD = 1 // paddingX: content col c ↔ 1-based screen x = c + PAD + 1

interface Props {
  current: string
  width: number
  onSelect: (name: string) => void
  onCancel: () => void
}

// A live diff preview rendered in the *highlighted* theme's palette, so moving
// the cursor shows what that theme looks like before you commit to it.
function Preview({ colors, title, t }: { colors: ThemeColors; title: string; t: ReturnType<typeof useT> }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.dim} paddingX={1}>
      <Text><Text color={colors.dim}>1  </Text><Text color={colors.accent}>function </Text><Text color={colors.text}>greet() {'{'}</Text></Text>
      <Text><Text color={colors.dim}>2  </Text><Text color={colors.error}>- console.log("Hello, World!")</Text></Text>
      <Text><Text color={colors.dim}>2  </Text><Text color={colors.success}>+ console.log("Hello, Claude!")</Text></Text>
      <Text><Text color={colors.dim}>3  </Text><Text color={colors.text}>{'}'}</Text></Text>
      <Text> </Text>
      <Text><Text color={colors.accent}>{'> '}</Text><Text color={colors.text}>{t('theme.previewAccent')}</Text><Text color={colors.dim}>{t('theme.previewHints')}</Text><Text color={colors.warning}>{t('theme.previewWarnings')}</Text></Text>
      <Text color={colors.accentBright}>{title}</Text>
    </Box>
  )
}

export function ThemePicker({ current, width, onSelect, onCancel }: Props): React.ReactElement {
  const colors = useTheme()
  const t = useT()
  const { stdin } = useStdin()
  // The Auto row's label localizes; every other theme shows its catalog title.
  const optionTitle = (o: Option): string => (o.name === AUTO_THEME ? t('theme.autoOption') : o.title)
  const startIdx = Math.max(0, OPTIONS.findIndex((o) => o.name === current))
  const [index, setIndex] = useState(startIdx === -1 ? 0 : startIdx)
  const onSelectRef = useRef(onSelect); onSelectRef.current = onSelect

  useInput((input, key) => {
    if (key.escape) { onCancel(); return }
    if (key.return) { onSelect(OPTIONS[index].name); return }
    if (key.upArrow) { setIndex((i) => (i - 1 + OPTIONS.length) % OPTIONS.length); return }
    if (key.downArrow) { setIndex((i) => (i + 1) % OPTIONS.length); return }
    // Drop mouse reports Ink may surface here as text (see the stdin listener).
    if (/\x1b?\[<\d+;\d+;\d+[Mm]/.test(input) || /\x1b?\[M/.test(input)) return
    // Number keys jump the cursor to that row (still requires Enter to apply).
    const n = Number(input)
    if (!Number.isNaN(n) && n >= 1 && n <= OPTIONS.length) setIndex(n - 1)
  })

  // Screen-row geometry for mouse hit-testing. Top-anchored (the modal wrapper is a
  // default row-direction flex box, so justifyContent doesn't move it vertically):
  // title on screen row 1, list starts after title/subtitle/blank. SGR y is 1-based;
  // content col c ↔ screen x = c + PAD + 1.
  const listTop = 4 // after title(1)/subtitle(2)/blank(3)
  const layoutRef = useRef({ firstItemRow: listTop, lastItemRow: listTop + OPTIONS.length - 1 })
  layoutRef.current = { firstItemRow: listTop, lastItemRow: listTop + OPTIONS.length - 1 }

  // Mouse: hover moves the highlight, click selects, wheel moves the cursor. Enable
  // any-motion reporting (?1003h) on mount; on unmount re-assert the app's base
  // modes (?1000h?1002h?1006h). A bare ?1003l is not enough: some terminals track
  // mouse mode as a single value, so ?1003l clears tracking entirely and the wheel
  // then falls back to ↑/↓ arrows (which PromptInput reads as history navigation).
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
        if (b === 64 || b === 65) {
          const d = b === 65 ? 1 : -1
          setIndex((i) => (i + d + OPTIONS.length) % OPTIONS.length)
          continue
        }
        if (y >= L.firstItemRow && y <= L.lastItemRow) {
          const real = y - L.firstItemRow
          if (real < 0 || real >= OPTIONS.length) continue
          if (release) onSelectRef.current(OPTIONS[real].name)
          else setIndex((i) => (i === real ? i : real))
        }
      }
    }
    stdin?.on('data', onData)
    return () => { stdin?.off('data', onData); try { out.write(PICKER_MOTION_OFF) } catch { /* best-effort */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdin])

  const preview = getTheme(OPTIONS[index].name).colors

  return (
    <Box flexDirection="column" width={width} paddingX={PAD}>
      <Text bold color={colors.accent}>{t('theme.title')}</Text>
      <Text color={colors.dim}>{t('theme.subtitle')}</Text>
      <Text> </Text>
      {OPTIONS.map((o, i) => {
        const cursor = i === index
        const isCurrent = o.name === current
        return (
          <Text key={o.name} color={cursor ? colors.accentBright : colors.text} wrap="truncate">
            {cursor ? '❯ ' : '  '}{i + 1}. {optionTitle(o)}
            {isCurrent ? <Text color={colors.success}> ✔</Text> : ''}
          </Text>
        )
      })}
      <Text> </Text>
      <Preview colors={preview} title={optionTitle(OPTIONS[index])} t={t} />
      <Text color={colors.dim}>{t('theme.footer', { n: OPTIONS.length })}</Text>
    </Box>
  )
}
