import React, { useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { symbols, useTheme } from '../theme'
import type { CommandSpec } from '../types'
import { toGraphemes, computeWindow, truncateToWidth } from '../lib/text'

interface Props {
  active: boolean
  placeholder: string
  width: number
  /** Slash commands offered by the autocomplete menu when the line starts "/". */
  commands: readonly CommandSpec[]
  onSubmit: (value: string) => void
  // Called when ↓ overflows past the input while NOT browsing history, so the
  // host can repurpose it (here: enter workflow-selection mode). Returning true
  // means the host consumed the key; PromptInput then leaves the line untouched.
  onOverflowDown?: () => boolean
}

// Highest number of command rows shown at once; longer match lists scroll to
// keep the selected row visible.
const MENU_MAX_ROWS = 8

// The menu is only relevant while the user is typing the command *token* itself:
// a leading "/" followed by no whitespace. Once a space is typed the user has
// moved on to arguments (e.g. `/model opus`) and the menu gets out of the way.
const COMMAND_TOKEN = /^\/(\S*)$/

// Prefix matches first (ranked the way a user expects), then looser substring
// matches, so `/mod` surfaces `model` at the top and `/x` still finds anything
// containing an "x". Matching considers aliases too.
function filterCommands(commands: readonly CommandSpec[], query: string): CommandSpec[] {
  const q = query.toLowerCase()
  if (!q) return [...commands]
  const starts: CommandSpec[] = []
  const contains: CommandSpec[] = []
  for (const c of commands) {
    const names = [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase())
    if (names.some((n) => n.startsWith(q))) starts.push(c)
    else if (names.some((n) => n.includes(q))) contains.push(c)
  }
  return [...starts, ...contains]
}

export function PromptInput({ active, placeholder, width, commands, onSubmit, onOverflowDown }: Props): React.ReactElement {
  const colors = useTheme()
  const [value, setValue] = useState('')
  // `cursor` is a grapheme-cluster index into `value`, never a UTF-16 offset,
  // so navigation and editing never land inside an emoji or combining sequence.
  const [cursor, setCursor] = useState(0)
  // Autocomplete-menu state: which row is highlighted, and whether the user has
  // dismissed the menu for the current query (Esc). Any edit re-opens it.
  const [selected, setSelected] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const history = useRef<string[]>([])
  const histIdx = useRef<number>(-1)

  // Derive the menu from the current line. Everything the key handler needs is
  // computed here so its closure always sees the latest render's values.
  const tokenMatch = active ? COMMAND_TOKEN.exec(value) : null
  const matches = tokenMatch && !dismissed ? filterCommands(commands, tokenMatch[1]) : []
  const menuOpen = matches.length > 0
  const sel = menuOpen ? Math.min(selected, matches.length - 1) : 0

  const submit = (v: string): void => {
    if (v.trim().length === 0) return
    history.current.unshift(v)
    histIdx.current = -1
    setValue('')
    setCursor(0)
    setSelected(0)
    setDismissed(false)
    onSubmit(v)
  }

  // Fill the line with a chosen command name plus a trailing space, ready for
  // arguments. The trailing space closes the menu (the token now has whitespace).
  const complete = (name: string): void => {
    const v = `/${name} `
    setValue(v)
    setCursor(toGraphemes(v).length)
    setSelected(0)
  }

  useInput((input, key) => {
    const g = toGraphemes(value)

    // --- Autocomplete menu takes priority over history / submit while open ---
    if (menuOpen) {
      const n = matches.length
      if (key.upArrow) { setSelected((s) => (Math.min(s, n - 1) - 1 + n) % n); return }
      if (key.downArrow) { setSelected((s) => (Math.min(s, n - 1) + 1) % n); return }
      if (key.tab) { complete(matches[sel].name); return }
      if (key.return) { submit(`/${matches[sel].name}`); return }
      if (key.escape) { setDismissed(true); return }
      // other keys (typing, backspace, cursor moves) fall through below
    }

    if (key.return) { submit(value); return }
    if (key.leftArrow) { setCursor((c) => Math.max(0, c - 1)); return }
    if (key.rightArrow) { setCursor((c) => Math.min(g.length, c + 1)); return }
    if (key.upArrow) {
      const h = history.current
      if (h.length === 0) return
      histIdx.current = Math.min(h.length - 1, histIdx.current + 1)
      const v = h[histIdx.current] ?? ''
      setValue(v); setCursor(toGraphemes(v).length)
      return
    }
    if (key.downArrow) {
      const h = history.current
      if (histIdx.current <= 0) {
        // At/below the newest history entry. When not browsing history, offer ↓
        // to the host first (enter workflow-selection mode); if it consumes the
        // key we stop, else fall back to clearing the line as before.
        if (histIdx.current < 0 && onOverflowDown?.()) return
        histIdx.current = -1; setValue(''); setCursor(0); return
      }
      histIdx.current -= 1
      const v = h[histIdx.current] ?? ''
      setValue(v); setCursor(toGraphemes(v).length)
      return
    }
    if (key.backspace || key.delete) {
      if (cursor <= 0) return
      setValue(g.slice(0, cursor - 1).join('') + g.slice(cursor).join(''))
      setCursor((c) => Math.max(0, c - 1))
      // A fresh edit re-opens a menu the user had dismissed and resets the pick.
      setDismissed(false); setSelected(0)
      return
    }
    if (key.ctrl && input === 'a') { setCursor(0); return }
    if (key.ctrl && input === 'e') { setCursor(g.length); return }
    if (key.ctrl && input === 'u') { setValue(''); setCursor(0); setDismissed(false); setSelected(0); return }
    if (key.ctrl && input === 'k') { setValue(g.slice(0, cursor).join('')); return }
    // ignore other control/navigation keys
    if (key.ctrl || key.meta || key.escape || key.tab || key.pageUp || key.pageDown) return
    if (!input) return
    // Defensive: mouse reports can reach useInput as text when the pointer is
    // over the input box. cli.tsx enables SGR mouse tracking and App scrolls on
    // the wheel by reading stdin directly; Ink may ALSO surface the same bytes
    // here (ESC stripped), which would otherwise insert literal junk like
    // "[<65;10;10M". Drop the SGR (\x1b[<b;x;yM/m) and legacy (\x1b[M…) forms.
    if (/\x1b?\[<\d+;\d+;\d+[Mm]/.test(input) || /\x1b?\[M/.test(input)) return
    // A real Enter arrives as key.return, but paste or bulk input can deliver a
    // chunk with an embedded CR/LF — submit the first line in that case.
    if (/[\r\n]/.test(input)) {
      const firstLine = input.split(/\r\n|\r|\n/)[0]
      submit(g.slice(0, cursor).join('') + firstLine + g.slice(cursor).join(''))
      return
    }
    setValue(g.slice(0, cursor).join('') + input + g.slice(cursor).join(''))
    setCursor((c) => c + toGraphemes(input).length)
    setDismissed(false); setSelected(0)
  }, { isActive: active })

  const border = active ? colors.accent : colors.dim
  const isEmpty = value.length === 0

  // Single-line window over `value`, measured in display columns so wide (CJK)
  // and zero-width glyphs never overflow or break the rounded border.
  // Inner width = box width minus borders, padding and the "> " marker.
  const inner = Math.max(8, width - 6)
  const g = toGraphemes(value)
  const { visible, rel } = computeWindow(g, cursor, inner)
  const before = visible.slice(0, rel).join('')
  const at = visible[rel] ?? ' '
  const after = visible.slice(rel + 1).join('')
  // Reserve one extra column for the inverse cursor block that precedes the hint
  // while the input is active, so marker + cursor + hint can never exceed the
  // box's inner width.
  const hint = truncateToWidth(placeholder, Math.max(8, inner - (active ? 1 : 0)))

  return (
    <Box flexDirection="column" width={width}>
      {menuOpen ? <CommandMenu matches={matches} selected={sel} width={width} /> : null}

      {/* flexDirection="column" is load-bearing. In the default row direction a
          single Text child is sized to its own (Yoga-measured) intrinsic width
          and left-aligned; once messages exist above, that measurement of the
          marker+cursor+hint run comes back short, so Ink wraps the hint onto the
          bottom border (`╰──commands)──╯`) or truncate clips it. As a column, the
          Text is the cross-axis child and stretches to the box's full inner
          width, so wrap/truncate uses the real width (≈ terminal − 4) and the
          one-line content never wraps. */}
      <Box borderStyle="round" borderColor={border} paddingX={1} flexDirection="column" width={width}>
        <Text wrap="truncate">
          <Text color={colors.accent}>{symbols.userPrompt} </Text>
          {isEmpty ? (
            <Text>
              {active ? <Text inverse> </Text> : null}
              <Text color={colors.dim}>{hint}</Text>
            </Text>
          ) : (
            <Text color={colors.text}>
              {before}
              {active ? <Text inverse>{at}</Text> : null}
              {active ? after : visible.slice(rel).join('')}
            </Text>
          )}
        </Text>
      </Box>
    </Box>
  )
}

// The dropdown of slash-command suggestions, rendered just above the input box.
// A column of one Text per row: each row stretches to `width` (cross-axis of the
// column) so `wrap="truncate"` clips long descriptions at the real terminal edge
// instead of wrapping. The list scrolls to keep the selected row visible.
function CommandMenu({
  matches,
  selected,
  width,
}: {
  matches: CommandSpec[]
  selected: number
  width: number
}): React.ReactElement {
  const colors = useTheme()
  const total = matches.length
  const rows = Math.min(MENU_MAX_ROWS, total)
  // Scroll window: center the selection when the list is longer than the cap.
  const start =
    total <= rows ? 0 : Math.min(Math.max(0, selected - Math.floor(rows / 2)), total - rows)
  const windowed = matches.slice(start, start + rows)
  // Width of the "/name" column, so descriptions line up. Bounded so a long
  // command name can't eat the whole row on a narrow terminal.
  const labelWidth = Math.min(18, Math.max(...matches.map((c) => c.name.length + 1)))

  return (
    <Box flexDirection="column" width={width} paddingLeft={1}>
      {windowed.map((c, i) => {
        const isSel = start + i === selected
        const label = `/${c.name}`.padEnd(labelWidth + 2)
        return (
          <Text key={c.name} wrap="truncate">
            <Text color={isSel ? colors.accentBright : colors.dim}>{isSel ? '▸ ' : '  '}</Text>
            <Text color={isSel ? colors.accentBright : colors.accent} bold={isSel}>{label}</Text>
            <Text color={isSel ? colors.text : colors.dim}>{c.description}</Text>
          </Text>
        )
      })}
      <Text color={colors.dim} wrap="truncate">
        {'  '}
        {total > rows ? `${selected + 1}/${total} · ` : ''}
        ↑↓ select · ↵ run · tab complete · esc dismiss
      </Text>
    </Box>
  )
}
