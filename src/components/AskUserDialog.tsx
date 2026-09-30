import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from '../theme'
import { useT } from '../lib/i18n'
import type { UserQuestion } from '../types'

interface Props {
  questions: UserQuestion[]
  width: number
  // Resolve with one answer array per question (chosen labels / typed text).
  onSubmit: (answers: string[][]) => void
  // Whole prompt dismissed (esc at the option list) → the tool reports no answer.
  onCancel: () => void
}

// Inline structured-question prompt for the `ask_user` tool, rendered in place of
// the input box (mirroring PermissionDialog). It steps through the questions one
// at a time. Each shows its options plus a trailing "Other" row that opens a
// free-form text field. Single-select confirms on ↵; multi-select toggles rows
// with space and confirms the set with ↵. Keyboard-only; it owns all keys while
// open (App's useInput early-returns on it).
export function AskUserDialog({ questions, width, onSubmit, onCancel }: Props): React.ReactElement {
  const colors = useTheme()
  const t = useT()
  const [step, setStep] = useState(0)
  const [results, setResults] = useState<string[][]>([])
  const [index, setIndex] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')

  const q = questions[step]
  const multi = q.multiSelect === true
  const otherIndex = q.options.length      // the synthetic "Other" row sits last
  const rowCount = q.options.length + 1

  const advance = (answer: string[]): void => {
    const next = [...results, answer]
    if (step + 1 >= questions.length) { onSubmit(next); return }
    setResults(next)
    setStep(step + 1)
    setIndex(0)
    setSelected(new Set())
    setTyping(false)
    setDraft('')
  }

  const confirmDraft = (): void => {
    const text = draft.trim()
    if (multi) {
      const labels = [...selected].sort((a, b) => a - b).map((i) => q.options[i].label)
      if (text) labels.push(text)
      advance(labels)
    } else {
      advance(text ? [text] : [])
    }
  }

  const confirmOptions = (): void => {
    if (index === otherIndex) { setTyping(true); setDraft(''); return }
    if (multi) {
      const chosen = selected.size > 0 ? [...selected] : [index]
      advance(chosen.sort((a, b) => a - b).map((i) => q.options[i].label))
    } else {
      advance([q.options[index].label])
    }
  }

  useInput((ch, key) => {
    if (typing) {
      if (key.return) { confirmDraft(); return }
      if (key.escape) { setTyping(false); setDraft(''); return }
      if (key.backspace || key.delete) { setDraft((d) => d.slice(0, -1)); return }
      if (ch && !key.ctrl && !key.meta && ch >= ' ') setDraft((d) => d + ch)
      return
    }
    if (key.escape) { onCancel(); return }
    if (key.upArrow) { setIndex((i) => Math.max(0, i - 1)); return }
    if (key.downArrow) { setIndex((i) => Math.min(rowCount - 1, i + 1)); return }
    if (ch === ' ' && multi && index !== otherIndex) {
      setSelected((s) => { const n = new Set(s); n.has(index) ? n.delete(index) : n.add(index); return n })
      return
    }
    if (key.return) { confirmOptions(); return }
  })

  return (
    <Box flexDirection="column" width={width} paddingX={1} borderStyle="round" borderColor={colors.accent}>
      <Box justifyContent="space-between">
        <Text color={colors.accentBright} bold>? {t('ask.title')}</Text>
        {questions.length > 1 ? <Text color={colors.dim}>{t('ask.progress', { n: step + 1, total: questions.length })}</Text> : null}
      </Box>
      <Box marginTop={1}>
        <Text color={colors.text} bold>{q.question}{multi ? <Text color={colors.dim}> {t('ask.multiHint')}</Text> : null}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {q.options.map((o, i) => {
          const on = i === index
          const box = multi ? (selected.has(i) ? '[x] ' : '[ ] ') : ''
          return (
            <Box key={i} flexDirection="column">
              <Text color={on ? colors.accentBright : colors.text} bold={on} wrap="truncate">
                {on ? '❯ ' : '  '}{box}{o.label}
              </Text>
              {o.description ? (
                <Text color={colors.dim} wrap="truncate">{'    '}{o.description}</Text>
              ) : null}
            </Box>
          )
        })}
        <Text color={index === otherIndex ? colors.accentBright : colors.dim} bold={index === otherIndex} wrap="truncate">
          {index === otherIndex ? '❯ ' : '  '}{multi ? '    ' : ''}{t('ask.other')}
        </Text>
      </Box>
      {typing ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={colors.dim}>{t('ask.otherPrompt')}</Text>
          <Text color={colors.text}>{'> '}{draft}<Text color={colors.accentBright}>▏</Text></Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={colors.dim} wrap="truncate">{t(multi ? 'ask.footerMulti' : 'ask.footerSingle')}</Text>
      </Box>
    </Box>
  )
}
