import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { themeList, getTheme, AUTO_THEME, useTheme, type ThemeColors } from '../theme'

interface Option { name: string; title: string }

// Auto first (resolves to light/dark at render time), then every concrete theme.
const OPTIONS: Option[] = [
  { name: AUTO_THEME, title: 'Auto (match terminal)' },
  ...themeList().map((t) => ({ name: t.name, title: t.title })),
]

interface Props {
  current: string
  width: number
  onSelect: (name: string) => void
  onCancel: () => void
}

// A live diff preview rendered in the *highlighted* theme's palette, so moving
// the cursor shows what that theme looks like before you commit to it.
function Preview({ colors, title }: { colors: ThemeColors; title: string }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.dim} paddingX={1}>
      <Text><Text color={colors.dim}>1  </Text><Text color={colors.accent}>function </Text><Text color={colors.text}>greet() {'{'}</Text></Text>
      <Text><Text color={colors.dim}>2  </Text><Text color={colors.error}>- console.log("Hello, World!")</Text></Text>
      <Text><Text color={colors.dim}>2  </Text><Text color={colors.success}>+ console.log("Hello, Claude!")</Text></Text>
      <Text><Text color={colors.dim}>3  </Text><Text color={colors.text}>{'}'}</Text></Text>
      <Text> </Text>
      <Text><Text color={colors.accent}>{'> '}</Text><Text color={colors.text}>the terracotta accent, </Text><Text color={colors.dim}>muted hints, </Text><Text color={colors.warning}>warnings</Text></Text>
      <Text color={colors.accentBright}>{title}</Text>
    </Box>
  )
}

export function ThemePicker({ current, width, onSelect, onCancel }: Props): React.ReactElement {
  const colors = useTheme()
  const startIdx = Math.max(0, OPTIONS.findIndex((o) => o.name === current))
  const [index, setIndex] = useState(startIdx === -1 ? 0 : startIdx)

  useInput((input, key) => {
    if (key.escape) { onCancel(); return }
    if (key.return) { onSelect(OPTIONS[index].name); return }
    if (key.upArrow) { setIndex((i) => (i - 1 + OPTIONS.length) % OPTIONS.length); return }
    if (key.downArrow) { setIndex((i) => (i + 1) % OPTIONS.length); return }
    // Number keys jump the cursor to that row (still requires Enter to apply).
    const n = Number(input)
    if (!Number.isNaN(n) && n >= 1 && n <= OPTIONS.length) setIndex(n - 1)
  })

  const preview = getTheme(OPTIONS[index].name).colors

  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      <Text bold color={colors.accent}>Theme</Text>
      <Text color={colors.dim}>Choose the palette that looks best with your terminal</Text>
      <Text> </Text>
      {OPTIONS.map((o, i) => {
        const cursor = i === index
        const isCurrent = o.name === current
        return (
          <Text key={o.name} color={cursor ? colors.accentBright : colors.text} wrap="truncate">
            {cursor ? '❯ ' : '  '}{i + 1}. {o.title}
            {isCurrent ? <Text color={colors.success}> ✔</Text> : ''}
          </Text>
        )
      })}
      <Text> </Text>
      <Preview colors={preview} title={OPTIONS[index].title} />
      <Text color={colors.dim}>↑↓ navigate · 1-{OPTIONS.length} jump · ↵ select · esc cancel</Text>
    </Box>
  )
}
