import React, { useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from '../theme'
import { useT } from '../lib/i18n'

export type PermissionChoice = 'once' | 'always' | 'deny'

interface Props {
  tool: string
  summary: string
  input: Record<string, unknown>
  mode: string
  width: number
  // The `questionTimeout` setting: seconds before the prompt auto-continues with
  // the default (allow-once) option. 0 = never (wait indefinitely for an answer).
  autoContinueSecs: number
  onDecide: (choice: PermissionChoice) => void
}

// A short, human-readable detail for the tool being gated: the shell command for
// `bash`, the target path for the file tools, else the raw arguments. Trimmed to
// a few lines so the dialog stays compact.
function detailFor(tool: string, input: Record<string, unknown>): string {
  if (tool === 'bash') return String(input.command ?? '')
  if (tool === 'write_file' || tool === 'edit_file') return String(input.path ?? '')
  try {
    return JSON.stringify(input)
  } catch {
    return ''
  }
}

// Inline permission prompt shown in place of the input box (the transcript stays
// visible above), mirroring Claude Code's "Allow this tool?" gate. Keyboard-only;
// it owns all keys while open (App's useInput early-returns on it). Enter confirms
// the highlighted option; y/a/n are shortcuts; esc denies. When questionTimeout is
// set, an idle prompt auto-continues with "Allow once" after the countdown.
export function PermissionDialog({ tool, summary, input, mode, width, autoContinueSecs, onDecide }: Props): React.ReactElement {
  const colors = useTheme()
  const t = useT()
  const options: Array<{ choice: PermissionChoice; label: string }> = [
    { choice: 'once', label: t('perm.optOnce') },
    { choice: 'always', label: t('perm.optAlways', { tool }) },
    { choice: 'deny', label: t('perm.optDeny') },
  ]
  const [index, setIndex] = useState(0)
  const [left, setLeft] = useState(autoContinueSecs)

  // Countdown → auto-continue with the default (allow-once). Disabled when the
  // setting is 0. Guarded so it fires exactly once.
  useEffect(() => {
    if (autoContinueSecs <= 0) return
    setLeft(autoContinueSecs)
    const id = setInterval(() => {
      setLeft((s) => {
        if (s <= 1) { clearInterval(id); onDecide('once'); return 0 }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, summary, autoContinueSecs])

  useInput((ch, key) => {
    if (key.upArrow) { setIndex((i) => Math.max(0, i - 1)); return }
    if (key.downArrow) { setIndex((i) => Math.min(options.length - 1, i + 1)); return }
    if (key.return) { onDecide(options[index].choice); return }
    if (key.escape) { onDecide('deny'); return }
    const c = ch.toLowerCase()
    if (c === 'y') { onDecide('once'); return }
    if (c === 'a') { onDecide('always'); return }
    if (c === 'n') { onDecide('deny'); return }
    if (ch === '1') { onDecide('once'); return }
    if (ch === '2') { onDecide('always'); return }
    if (ch === '3') { onDecide('deny'); return }
  })

  const detail = detailFor(tool, input)

  return (
    <Box flexDirection="column" width={width} paddingX={1} borderStyle="round" borderColor={colors.warning}>
      <Box justifyContent="space-between">
        <Text color={colors.warning} bold>⚠ {t('perm.title')}</Text>
        <Text color={colors.dim}>{t('perm.mode', { mode })}</Text>
      </Box>
      <Box>
        <Text color={colors.accentBright} wrap="truncate">{summary}</Text>
      </Box>
      {detail ? (
        <Box>
          <Text color={colors.dim} wrap="truncate">{detail.split('\n').slice(0, 3).join(' ⏎ ')}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {options.map((o, i) => (
          <Text key={o.choice} color={i === index ? colors.accentBright : colors.text} bold={i === index}>
            {i === index ? '❯ ' : '  '}{i + 1}. {o.label}
          </Text>
        ))}
      </Box>
      <Box justifyContent="space-between" marginTop={1}>
        <Text color={colors.dim} wrap="truncate">{t('perm.footer')}</Text>
        {autoContinueSecs > 0 ? <Text color={colors.warning}>{t('perm.countdown', { secs: left })}</Text> : null}
      </Box>
    </Box>
  )
}
