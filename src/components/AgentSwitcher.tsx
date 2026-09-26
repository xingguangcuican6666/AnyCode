import React from 'react'
import { Box, Text } from 'ink'
import type { AgentSnapshot } from '../types'
import { useTheme } from '../theme'
import { useT } from '../lib/i18n'

// The bottom agent switcher: one row for `main` plus one per switchable sub-agent
// (`task`/`plan`). This is the conceptual centerpiece that distinguishes a
// sub-agent from a `workflow`: a workflow is a collapsed line + an expandable
// progress TREE, whereas a sub-agent is a switchable VIEW — selecting a row swaps
// the main viewport to that agent's OWN chat/transcript. ○ marks an agent you're
// not viewing, ● the one currently shown. `sel` is the row under the ↑↓ selection
// cursor (❯) while picking; null = the input owns the keyboard.
export function AgentSwitcher({ agents, sel, viewing, width }: {
  agents: AgentSnapshot[]
  sel: number | null       // index into [main, ...agents]; null = not selecting
  viewing: string | null   // agent id currently shown in the viewport (null = main)
  width: number
}): React.ReactElement {
  const colors = useTheme()
  const t = useT()
  const glyph = (a: AgentSnapshot): string => (a.state === 'done' ? '✓' : a.state === 'error' ? '✗' : '▶')
  return (
    <Box flexDirection="column" width={width} paddingLeft={1}>
      <Text color={colors.dim} wrap="truncate">
        {t('agentsw.title')}{sel !== null ? t('agentsw.hintSelecting') : t('agentsw.hintSwitch')}
      </Text>
      <Text color={sel === 0 ? colors.accentBright : colors.dim} bold={sel === 0} wrap="truncate">
        {sel === 0 ? '❯ ' : '  '}{viewing === null ? '●' : '○'} <Text color={colors.text}>main</Text>
      </Text>
      {agents.map((a, i) => {
        const cursorOn = sel === i + 1
        const secs = a.elapsedMs != null ? ` · ${Math.max(1, Math.round(a.elapsedMs / 1000))}s` : ''
        const steps = a.steps ? t('agentsw.steps', { n: a.steps, s: a.steps === 1 ? '' : 's' }) : ''
        return (
          <Text key={a.id} color={cursorOn ? colors.accentBright : colors.dim} bold={cursorOn} wrap="truncate">
            {cursorOn ? '❯ ' : '  '}{viewing === a.id ? '●' : '○'} <Text color={colors.accent}>{a.type}</Text>
            {` ${glyph(a)} ${a.label} · ${a.activity}${steps}${secs}`}
          </Text>
        )
      })}
    </Box>
  )
}
