import React, { useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { WorkflowAgent, WorkflowSnapshot } from '../types'
import { useTheme, type ThemeColors } from '../theme'

// One-line summary of a running `workflow` tool call, shown in the live region
// so the user always sees progress (the "啥都看不见" fix). Press ↓ to expand it
// into <WorkflowView>. Mirrors the goal/loop status lines above the input.
export function WorkflowCollapsed({ snapshot, selected = false }: { snapshot: WorkflowSnapshot; selected?: boolean }): React.ReactElement {
  const colors = useTheme()
  const by = (s: WorkflowAgent['state']): number => snapshot.agents.filter((a) => a.state === s).length
  const errored = by('error')
  const counts = `✓ ${by('done')}  ▶ ${by('running')}  ⋯ ${by('queued')}${errored ? `  ✗ ${errored}` : ''}`
  return (
    <Box paddingLeft={1}>
      <Text color={selected ? colors.accentBright : colors.accent} wrap="truncate">
        {selected ? '❯ ' : '▸ '}{snapshot.title} · <Text color={colors.dim}>{counts}</Text>
        {snapshot.paused ? <Text color={colors.warning}> · paused</Text> : null}
        {snapshot.done
          ? <Text color={colors.success}> · done</Text>
          : <Text color={colors.dim}>{selected ? '  ·  ↵ expand' : '  ·  ↓ select'}</Text>}
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
      if (!c) { setNote('save unavailable'); return }
      setNote('saving…')
      c.save().then((p) => setNote(`saved → ${p}`)).catch((e) => setNote(`save failed: ${(e as Error).message}`))
      return
    }
    if (key.upArrow) { setSel((s) => Math.max(0, s - 1)); return }
    if (key.downArrow) { setSel((s) => Math.min(agents.length - 1, s + 1)); return }
  })

  const detail = (a: WorkflowAgent): string => {
    if (a.state === 'running') return `running ${Math.max(0, Math.round((now - (a.startedAt ?? now)) / 1000))}s`
    if (a.state === 'done') return `done${a.elapsedMs != null ? ` in ${Math.max(1, Math.round(a.elapsedMs / 1000))}s` : ''} · ${a.steps} tool call${a.steps === 1 ? '' : 's'}`
    if (a.state === 'error') return `error: ${a.error ?? 'failed'}`
    return 'queued'
  }

  const labelW = Math.max(12, Math.min(40, width - 30))
  const completed = agents.filter((a) => a.state === 'done' || a.state === 'error').length

  return (
    <Box flexDirection="column" width={width}>
      <Box borderStyle="round" borderColor={colors.accent} flexDirection="column" paddingX={1}>
        <Text color={colors.accentBright} wrap="truncate">
          {snapshot.title} · {completed}/{agents.length} complete{snapshot.paused ? ' · paused' : ''}{snapshot.done ? ' · done' : ''}
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
      <Text color={colors.dim} wrap="truncate">  ↑↓ select · p {snapshot.paused ? 'resume' : 'pause'} · s save · x stop · esc back</Text>
      {note ? <Text color={colors.dim} wrap="truncate">  {note}</Text> : null}
    </Box>
  )
}
