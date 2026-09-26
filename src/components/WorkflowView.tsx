import React, { useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { WorkflowAgent, WorkflowSnapshot } from '../types'
import { useTheme, type ThemeColors } from '../theme'
import { useT } from '../lib/i18n'

// One-line summary of a running `workflow` tool call, shown in the live region
// so the user always sees progress (the "啥都看不见" fix). Press ↓ to expand it
// into <WorkflowView>. Mirrors the goal/loop status lines above the input.
export function WorkflowCollapsed({ snapshot, selected = false }: { snapshot: WorkflowSnapshot; selected?: boolean }): React.ReactElement {
  const colors = useTheme()
  const t = useT()
  const by = (s: WorkflowAgent['state']): number => snapshot.agents.filter((a) => a.state === s).length
  const errored = by('error')
  const counts = `✓ ${by('done')}  ▶ ${by('running')}  ⋯ ${by('queued')}${errored ? `  ✗ ${errored}` : ''}`
  return (
    <Box paddingLeft={1}>
      <Text color={selected ? colors.accentBright : colors.accent} wrap="truncate">
        {selected ? '❯ ' : '▸ '}{snapshot.title} · <Text color={colors.dim}>{counts}</Text>
        {snapshot.paused ? <Text color={colors.warning}>{t('workflow.pausedSuffix')}</Text> : null}
        {snapshot.done
          ? <Text color={colors.success}>{t('workflow.doneSuffix')}</Text>
          : <Text color={colors.dim}>{selected ? t('workflow.expandHint') : t('workflow.selectHint')}</Text>}
      </Text>
    </Box>
  )
}

// Status glyph + color for one agent's state.
function statusStyle(state: WorkflowAgent['state'], colors: ThemeColors): { icon: string; color: string } {
  switch (state) {
    case 'running': return { icon: '▶', color: colors.accentBright }
    case 'done': return { icon: '✓', color: colors.success }
    case 'error': return { icon: '✗', color: colors.error }
    default: return { icon: '⋯', color: colors.dim }
  }
}

interface Props {
  snapshot: WorkflowSnapshot
  width: number
  onExit: () => void
  onStop: () => void
}

// The expanded, live workflow progress tree (opened with ↓ from the collapsed
// line). Owns the keyboard while open: ↑↓ move the selection, x stops the whole
// workflow (interrupts the turn), esc/q returns to the collapsed line. A local
// 250ms ticker re-renders so running agents show a live elapsed timer.
export function WorkflowView({ snapshot, width, onExit, onStop }: Props): React.ReactElement {
  const colors = useTheme()
  const t = useT()
  const agents = snapshot.agents
  const [sel, setSel] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const active = !snapshot.done && agents.some((a) => a.state === 'running')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [active])

  useInput((input, key) => {
    if (key.escape || input === 'q') { onExit(); return }
    if (input === 'x') { onStop(); onExit(); return }
    if (input === 'p') {
      if (snapshot.paused) snapshot.controls?.resume()
      else snapshot.controls?.pause()
      return
    }
    if (input === 's') {
      const c = snapshot.controls
      if (!c) { setNote(t('workflow.saveUnavailable')); return }
      setNote(t('workflow.saving'))
      c.save().then((p) => setNote(t('workflow.saved', { path: p }))).catch((e) => setNote(t('workflow.saveFailed', { error: (e as Error).message })))
      return
    }
    if (key.upArrow) { setSel((s) => Math.max(0, s - 1)); return }
    if (key.downArrow) { setSel((s) => Math.min(agents.length - 1, s + 1)); return }
  })

  const detail = (a: WorkflowAgent): string => {
    if (a.state === 'running') return t('workflow.detailRunning', { seconds: Math.max(0, Math.round((now - (a.startedAt ?? now)) / 1000)) })
    if (a.state === 'done') {
      const inPart = a.elapsedMs != null ? t('workflow.detailDoneIn', { seconds: Math.max(1, Math.round(a.elapsedMs / 1000)) }) : ''
      const calls = a.steps === 1 ? t('workflow.detailToolCall', { steps: a.steps }) : t('workflow.detailToolCalls', { steps: a.steps })
      return `${t('workflow.detailDone')}${inPart}${calls}`
    }
    if (a.state === 'error') return t('workflow.detailError', { error: a.error ?? t('workflow.detailFailed') })
    return t('workflow.detailQueued')
  }

  const labelW = Math.max(12, Math.min(40, width - 30))
  const completed = agents.filter((a) => a.state === 'done' || a.state === 'error').length

  return (
    <Box flexDirection="column" width={width}>
      <Box borderStyle="round" borderColor={colors.accent} flexDirection="column" paddingX={1}>
        <Text color={colors.accentBright} wrap="truncate">
          {snapshot.title} · {t('workflow.complete', { completed, total: agents.length })}{snapshot.paused ? t('workflow.pausedSuffix') : ''}{snapshot.done ? t('workflow.doneSuffix') : ''}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {agents.map((a, i) => {
            const { icon, color } = statusStyle(a.state, colors)
            const selected = i === sel
            return (
              <Box key={i} width={width - 4}>
                <Text color={selected ? colors.accentBright : color} wrap="truncate">
                  {selected ? '❯ ' : '  '}{icon} {a.label.padEnd(labelW).slice(0, labelW)}
                </Text>
                <Text color={colors.dim} wrap="truncate">  {detail(a)}</Text>
              </Box>
            )
          })}
        </Box>
      </Box>
      <Text color={colors.dim} wrap="truncate">{t('workflow.help', { action: snapshot.paused ? t('workflow.resume') : t('workflow.pause') })}</Text>
      {note ? <Text color={colors.dim} wrap="truncate">  {note}</Text> : null}
    </Box>
  )
}
