import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput, useStdin, useStdout } from 'ink'
import { symbols, useTheme } from '../theme'
import { useT } from '../lib/i18n'
import type { CommandSpec } from '../types'
import { toGraphemes, truncateToWidth, displayWidth } from '../lib/text'
import { loadHistory, appendHistory } from '../lib/history'
import { copyToClipboard } from '../lib/clipboard'
import { stashClipboardImage } from '../lib/images'

interface Props {
  active: boolean
  placeholder: string
  width: number
  /** Slash commands offered by the autocomplete menu when the line starts "/". */
  commands: readonly CommandSpec[]
  // Workspace file completion for the `@`-mention picker: given the text typed
  // after an `@`, return the workspace-relative paths to offer (already ranked,
  // filtered and capped by the host, which also honors the `respectGitignore`
  // setting). Absent = no file picker (typing `@` just inserts a literal `@`).
  atFiles?: (query: string) => string[]
  onSubmit: (value: string) => void
  // Called on ↑ when the input is EMPTY: pulls the most recent type-ahead line the
  // user queued while the model was streaming back into the box, so they can edit
  // or retract the pending interjection. Returns the recalled text (removed from
  // the queue), or null when nothing is queued — in which case ↑ browses history.
  recallPending?: () => string | null
  // Called when ↓ overflows past the input while NOT browsing history, so the
  // host can repurpose it (here: enter workflow-selection mode). Returning true
  // means the host consumed the key; PromptInput then leaves the line untouched.
  onOverflowDown?: () => boolean
  // Called when ← is pressed at column 0. Returning true means the host consumed
  // it (e.g. opened the agent switcher) and the cursor should stay put.
  onLeftAtStart?: () => boolean
  // Key-binding scheme for the input (the `editorMode` setting): 'normal' (the
  // default, plain editing), 'emacs' (adds the standard C-b/f/d/w, M-b/f, C-p/n
  // motions), or 'vim' (modal — Esc enters normal mode, i/a/I/A return to insert).
  editorMode?: string
  // Mouse text-selection inside the input box (the "对话框" area). The box is
  // bottom-anchored, so we locate its rows from the screen bottom: `screenRows`
  // is the terminal height and `bottomOffset` the number of screen rows rendered
  // BELOW the box's bottom border (agent switcher + workflows + suggest + PR +
  // footer). App keeps its own transcript selection off these rows so the two
  // never fight. `copyOnSelect` mirrors the setting: a drag always copies on
  // release, and additionally clears the highlight when this is on.
  screenRows?: number
  bottomOffset?: number
  mouseSelect?: boolean
  copyOnSelect?: boolean
}

// Word boundaries for vim/emacs word motion: treat runs of non-space as words.
// `nextWord` lands on the start of the next word after the cursor; `prevWord`
// on the start of the current/previous word — matching vim's w and b closely
// enough for a prompt line.
function nextWord(g: string[], cursor: number): number {
  let i = cursor
  while (i < g.length && /\s/.test(g[i])) i++      // skip leading space (rare at cursor)
  while (i < g.length && !/\s/.test(g[i])) i++      // skip the current word
  while (i < g.length && /\s/.test(g[i])) i++       // skip the gap to the next word
  return i
}
function prevWord(g: string[], cursor: number): number {
  let i = cursor - 1
  while (i > 0 && /\s/.test(g[i])) i--              // skip trailing space behind us
  while (i > 0 && !/\s/.test(g[i - 1])) i--         // walk to the word's start
  return Math.max(0, i)
}

// Highest number of command rows shown at once; longer match lists scroll to
// keep the selected row visible.
const MENU_MAX_ROWS = 8

// The menu is only relevant while the user is typing the command *token* itself:
// a leading "/" followed by no whitespace. Once a space is typed the user has
// moved on to arguments (e.g. `/model opus`) and the menu gets out of the way.
const COMMAND_TOKEN = /^\/(\S*)$/

// The @-mention picker is relevant while the caret sits inside an `@…` token:
// the run of non-whitespace immediately left of the cursor that begins with `@`
// (at line start or after a space). Returns the token's start grapheme index and
// the query (text after the `@`), or null when the caret isn't in such a token.
function atToken(g: string[], cursor: number): { start: number; query: string } | null {
  let s = cursor
  while (s > 0 && !/\s/.test(g[s - 1])) s--
  if (g[s] !== '@') return null
  return { start: s, query: g.slice(s + 1, cursor).join('') }
}

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

export function PromptInput({ active, placeholder, width, commands, atFiles, onSubmit, recallPending, onOverflowDown, onLeftAtStart, editorMode = 'normal', screenRows = 0, bottomOffset = 0, mouseSelect = false, copyOnSelect = false }: Props): React.ReactElement {
  const colors = useTheme()
  const [value, setValue] = useState('')
  // `cursor` is a grapheme-cluster index into `value`, never a UTF-16 offset,
  // so navigation and editing never land inside an emoji or combining sequence.
  const [cursor, setCursor] = useState(0)
  // Autocomplete-menu state: which row is highlighted, and whether the user has
  // dismissed the menu for the current query (Esc). Any edit re-opens it.
  const [selected, setSelected] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  // Vim modal state (only meaningful when editorMode === 'vim'). We start in
  // insert mode so the prompt behaves normally until the user presses Esc; a
  // pending 'd' waits for the second key of a `dd` (clear line).
  const [vimNormal, setVimNormal] = useState(false)
  const pendingD = useRef(false)
  // Mouse text-selection over the input's own content, as an (anchor, head) pair
  // of grapheme indices into `value` (null = nothing selected). A left press in
  // the box anchors it, a left-drag moves the head, release copies it. Cleared
  // whenever `value` changes (i.e. the user edits), so a stale highlight never
  // lingers over freshly-typed text.
  const [msel, setMsel] = useState<{ a: number; b: number } | null>(null)
  const { stdin } = useStdin()
  const { stdout } = useStdout()
  // Refs so the stdin mouse listener (attached once) always reads live values
  // rather than its mount-time closure.
  const mselRef = useRef(msel); mselRef.current = msel
  const valueRef = useRef(value); valueRef.current = value
  const cursorRef = useRef(cursor); cursorRef.current = cursor
  const activeRef = useRef(active); activeRef.current = active
  const mouseSelectRef = useRef(mouseSelect); mouseSelectRef.current = mouseSelect
  const copyOnSelectRef = useRef(copyOnSelect); copyOnSelectRef.current = copyOnSelect
  const selectingRef = useRef(false)
  const draggedRef = useRef(false)
  const pressIdxRef = useRef(0)
  // Live input-box geometry (screen rows the content occupies + wrap layout),
  // refreshed each render below so the listener can map a click to a grapheme.
  const geomRef = useRef<{ rows: string[][]; rowStart: number[]; startRow: number; contentRows: number; contentTop: number }>(
    { rows: [[]], rowStart: [0], startRow: 0, contentRows: 1, contentTop: 0 },
  )

  // Map a click at display column `x` (1-based screen col) on visible row `j`
  // (0-based, top of the box's content) to a grapheme index into `value`.
  const ptToIndex = (j: number, x: number): number => {
    const g = geomRef.current
    const absRow = g.startRow + j
    const rowG = g.rows[absRow] ?? []
    const gs0 = g.rowStart[absRow] ?? 0
    // Content starts after the border (1) + padding (1) + 2-col "> "/"  " marker.
    const c = Math.max(0, x - 1 - 4)
    let acc = 0
    let off = rowG.length
    for (let k = 0; k < rowG.length; k++) {
      const w = Math.max(1, displayWidth(rowG[k]))
      if (acc + w > c) { off = k; break }
      acc += w
    }
    return gs0 + off
  }

  useEffect(() => {
    if (!stdin) return
    const onData = (data: Buffer): void => {
      if (!activeRef.current || !mouseSelectRef.current) return
      const s = data.toString('utf8')
      const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
      let m: RegExpExecArray | null
      while ((m = re.exec(s)) !== null) {
        const b = Number(m[1])
        const x = Number(m[2])
        const y = Number(m[3])
        const release = m[4] === 'm'
        const g = geomRef.current
        const j = y - g.contentTop
        const inBox = j >= 0 && j < g.contentRows
        if (b === 0 && !release) {
          // Left press: anchor a selection here — but only inside the box. A press
          // elsewhere clears any highlight and lets App's transcript handler run.
          if (!inBox) { setMsel(null); continue }
          const idx = ptToIndex(j, x)
          selectingRef.current = true
          draggedRef.current = false
          pressIdxRef.current = idx
          setMsel({ a: idx, b: idx })
        } else if (b === 32 && !release) {
          // Left-drag: extend the head (clamped to the box's rows).
          if (!selectingRef.current) continue
          draggedRef.current = true
          const jj = Math.max(0, Math.min(g.contentRows - 1, j))
          const idx = ptToIndex(jj, x)
          setMsel((cur) => (cur ? { a: cur.a, b: idx } : { a: idx, b: idx }))
        } else if (release) {
          const was = selectingRef.current
          selectingRef.current = false
          if (!was) continue
          if (draggedRef.current) {
            // A real drag: copy the highlight to the clipboard. Keep the highlight
            // visible (unlike the transcript's copyOnSelect, which clears it) so
            // the user can see what was copied; typing clears it.
            const cur = mselRef.current
            if (cur && cur.a !== cur.b) {
              const gs = toGraphemes(valueRef.current)
              const lo = Math.min(cur.a, cur.b), hi = Math.max(cur.a, cur.b)
              copyToClipboard(gs.slice(lo, hi).join(''), stdout)
              if (copyOnSelectRef.current) setMsel(null)
            }
          } else {
            // A no-drag click just moves the caret there (and clears any highlight).
            setCursor(pressIdxRef.current)
            setMsel(null)
          }
        }
      }
    }
    stdin.on('data', onData)
    return () => { stdin.off('data', onData) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdin])

  // Any edit to the line dismisses a stale selection highlight.
  useEffect(() => { setMsel(null) }, [value])
  // Prompt history for ↑/↓ recall, newest-first. Loaded from disk once (lazy ref
  // init) so recall spans restarts like a shell / Claude Code; `histIdx` is the
  // browse cursor (-1 = editing a fresh line, not in history).
  const history = useRef<string[] | null>(null)
  if (history.current === null) history.current = loadHistory()
  const histIdx = useRef<number>(-1)

  // Derive the menu from the current line. Everything the key handler needs is
  // computed here so its closure always sees the latest render's values.
  const tokenMatch = active ? COMMAND_TOKEN.exec(value) : null
  const matches = tokenMatch && !dismissed ? filterCommands(commands, tokenMatch[1]) : []
  const menuOpen = matches.length > 0
  const sel = menuOpen ? Math.min(selected, matches.length - 1) : 0

  // The @-file picker shares `selected`/`dismissed` with the command menu — the
  // two are mutually exclusive (a `/token` fills the whole line; an `@token` is
  // mid-line), so one set of highlight/dismiss state serves both. Suppressed
  // while the command menu is up or the host offers no file source.
  const atTok = active && !menuOpen && atFiles ? atToken(toGraphemes(value), cursor) : null
  const atMatches = atTok && !dismissed ? atFiles!(atTok.query) : []
  const atOpen = atMatches.length > 0
  const atSel = atOpen ? Math.min(selected, atMatches.length - 1) : 0

  const submit = (v: string): void => {
    if (v.trim().length === 0) return
    const h = history.current ?? (history.current = [])
    if (h[0] !== v) h.unshift(v) // in-memory recall (this session); no consecutive dupes
    appendHistory(v)             // persist for future sessions (best-effort)
    histIdx.current = -1
    setValue('')
    setCursor(0)
    setSelected(0)
    setDismissed(false)
    setVimNormal(false); pendingD.current = false // next prompt starts in insert
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

  // Replace the active `@…` token with the chosen workspace path (keeping the
  // `@` marker) plus a trailing space, so the picker closes and the caret is
  // ready for the next word. Recomputes the token from live state at call time.
  const completeAt = (rel: string): void => {
    const g = toGraphemes(value)
    const tok = atToken(g, cursor)
    if (!tok) return
    const head = g.slice(0, tok.start).join('') + `@${rel} `
    const v = head + g.slice(cursor).join('')
    setValue(v)
    setCursor(toGraphemes(head).length)
    setSelected(0)
  }

  // ↑ recall of a pending interjection: only when the input is empty (so we never
  // clobber a line being typed) and the host has something queued. Pulls it into
  // the box for editing; returns true when it consumed the key so ↑ skips history.
  const tryRecallPending = (): boolean => {
    if (value.length !== 0 || !recallPending) return false
    const p = recallPending()
    if (p === null) return false
    setValue(p)
    setCursor(toGraphemes(p).length)
    histIdx.current = -1
    setDismissed(false)
    setSelected(0)
    return true
  }

  useInput((input, key) => {
    const g = toGraphemes(value)

    // --- Vim normal mode (editorMode === 'vim' after an Esc) ---
    // Owns the keyboard entirely: motions/edits here, and i/a/I/A (or Enter to
    // submit) return to insert. Insert mode itself is the plain editing below.
    if (editorMode === 'vim' && vimNormal) {
      if (key.return) { submit(value); return }
      // Second key of a `dd`: clear the whole line.
      if (pendingD.current) {
        pendingD.current = false
        if (input === 'd') { setValue(''); setCursor(0); return }
      }
      switch (input) {
        case 'i': setVimNormal(false); return
        case 'a': setVimNormal(false); setCursor((c) => Math.min(g.length, c + 1)); return
        case 'I': setVimNormal(false); setCursor(0); return
        case 'A': setVimNormal(false); setCursor(g.length); return
        case 'h': setCursor((c) => Math.max(0, c - 1)); return
        case 'l': setCursor((c) => Math.min(g.length, c + 1)); return
        case '0': setCursor(0); return
        case '$': setCursor(g.length); return
        case 'w': setCursor(nextWord(g, cursor)); return
        case 'b': setCursor(prevWord(g, cursor)); return
        case 'x':
          if (cursor < g.length) { setValue(g.slice(0, cursor).join('') + g.slice(cursor + 1).join('')) }
          return
        case 'D': setValue(g.slice(0, cursor).join('')); return
        case 'd': pendingD.current = true; return
        default: return // swallow everything else while in normal mode
      }
    }

    // --- Autocomplete menu takes priority over history / submit while open ---
    if (menuOpen) {
      const n = matches.length
      if (key.upArrow) { setSelected((s) => (Math.min(s, n - 1) - 1 + n) % n); return }
      if (key.downArrow) { setSelected((s) => (Math.min(s, n - 1) + 1) % n); return }
      if (key.tab && !key.shift) { complete(matches[sel].name); return }
      if (key.return) { submit(`/${matches[sel].name}`); return }
      if (key.escape) { setDismissed(true); return }
      // other keys (typing, backspace, cursor moves) fall through below
    }

    // --- @-file picker: same precedence as the command menu, but Enter/Tab
    // INSERT the path (and keep editing) instead of submitting. ---
    if (atOpen) {
      const n = atMatches.length
      if (key.upArrow) { setSelected((s) => (Math.min(s, n - 1) - 1 + n) % n); return }
      if (key.downArrow) { setSelected((s) => (Math.min(s, n - 1) + 1) % n); return }
      if ((key.tab && !key.shift) || key.return) { completeAt(atMatches[atSel]); return }
      if (key.escape) { setDismissed(true); return }
      // other keys fall through to normal editing (which re-opens the picker)
    }

    // Vim: Esc from insert mode drops into normal mode (handled above). Do this
    // before the generic control-key swallow further down.
    if (editorMode === 'vim' && key.escape) { setVimNormal(true); return }

    // Manual newline (shift/alt/ctrl+Enter) vs submit (plain Enter). Terminals
    // don't agree on shift+Enter, and Ink can't see a shift modifier on Return
    // (it flags EVERY Return as shift). What we CAN rely on: plain Enter is CR
    // with key.return=true; a linefeed (Ctrl+J, and shift+Enter on terminals that
    // send LF) arrives as input '\n' with key.return=false; alt/⌥+Enter arrives
    // as ESC+CR, which Ink strips to a bare '\r' with key.return=false. So: LF, or
    // a CR that ISN'T the parsed Return, inserts a newline. Ctrl+J always works.
    const isNewline = input === '\n' || (input === '\r' && !key.return)
    if (isNewline) {
      setValue(g.slice(0, cursor).join('') + '\n' + g.slice(cursor).join(''))
      setCursor((c) => c + 1)
      setDismissed(false); setSelected(0)
      return
    }
    if (key.return) { submit(value); return }
    if (key.leftArrow) {
      // At column 0 the host may repurpose ← (the `leftArrowOpensAgents` setting
      // opens the agent switcher). If it consumes the key, leave the line be.
      if (cursor === 0 && onLeftAtStart?.()) return
      setCursor((c) => Math.max(0, c - 1)); return
    }
    if (key.rightArrow) { setCursor((c) => Math.min(g.length, c + 1)); return }
    if (key.upArrow) {
      // A queued interjection takes precedence over history recall on an empty line.
      if (tryRecallPending()) return
      const h = history.current ?? []
      if (h.length === 0) return
      histIdx.current = Math.min(h.length - 1, histIdx.current + 1)
      const v = h[histIdx.current] ?? ''
      setValue(v); setCursor(toGraphemes(v).length)
      return
    }
    if (key.downArrow) {
      const h = history.current ?? []
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
    // Ctrl+V: if the system clipboard holds an IMAGE, stash it to a temp file and
    // insert its path at the cursor — submit-time processImagePrompt then turns it
    // into an [Image #N] attachment. No clipboard image → no-op (ctrl+v is ignored
    // otherwise), so ordinary text paste (which arrives via bracketed paste) is
    // untouched. The read is async, so we fire-and-forget and setState on arrival.
    if (key.ctrl && input === 'v') {
      void (async () => {
        let p: string | null = null
        try { p = await stashClipboardImage() } catch { p = null }
        if (!p) return
        const gg = toGraphemes(valueRef.current)
        const at = Math.min(cursorRef.current, gg.length)
        const lead = at > 0 && !/\s/.test(gg[at - 1] ?? ' ') ? ' ' : ''
        const ins = `${lead}${p} `
        setValue(gg.slice(0, at).join('') + ins + gg.slice(at).join(''))
        setCursor(at + toGraphemes(ins).length)
        setDismissed(false); setSelected(0)
      })()
      return
    }
    // Emacs mode adds the motions/edits the default scheme lacks. All additive
    // and gated on editorMode === 'emacs', so they never shadow normal editing.
    if (editorMode === 'emacs' && key.ctrl) {
      if (input === 'b') { setCursor((c) => Math.max(0, c - 1)); return }
      if (input === 'f') { setCursor((c) => Math.min(g.length, c + 1)); return }
      if (input === 'd') {
        if (cursor < g.length) setValue(g.slice(0, cursor).join('') + g.slice(cursor + 1).join(''))
        return
      }
      if (input === 'w') {
        const start = prevWord(g, cursor)
        setValue(g.slice(0, start).join('') + g.slice(cursor).join('')); setCursor(start); return
      }
      if (input === 'p') { // like ↑ (older history)
        if (tryRecallPending()) return
        const h = history.current ?? []
        if (h.length === 0) return
        histIdx.current = Math.min(h.length - 1, histIdx.current + 1)
        const v = h[histIdx.current] ?? ''; setValue(v); setCursor(toGraphemes(v).length); return
      }
      if (input === 'n') { // like ↓ (newer history)
        const h = history.current ?? []
        if (histIdx.current <= 0) { histIdx.current = -1; setValue(''); setCursor(0); return }
        histIdx.current -= 1; const v = h[histIdx.current] ?? ''
        setValue(v); setCursor(toGraphemes(v).length); return
      }
    }
    if (editorMode === 'emacs' && key.meta) {
      if (input === 'b') { setCursor(prevWord(g, cursor)); return }
      if (input === 'f') { setCursor(nextWord(g, cursor)); return }
    }
    // ignore other control/navigation keys
    if (key.ctrl || key.meta || key.escape || key.tab || key.pageUp || key.pageDown) return
    if (!input) return
    // Defensive: mouse reports can reach useInput as text when the pointer is
    // over the input box. cli.tsx enables SGR mouse tracking and App scrolls on
    // the wheel by reading stdin directly; Ink may ALSO surface the same bytes
    // here (ESC stripped), which would otherwise insert literal junk like
    // "[<65;10;10M". Drop the SGR (\x1b[<b;x;yM/m) and legacy (\x1b[M…) forms.
    if (/\x1b?\[<\d+;\d+;\d+[Mm]/.test(input) || /\x1b?\[M/.test(input)) return
    // Same for terminal focus-reporting (?1004h in cli.tsx): CSI I / CSI O arrive
    // on every focus change. App reads them off stdin for notification gating, but
    // Ink surfaces them here too (as \x1b[I / \x1b[O, or ESC-stripped [I / [O) and
    // would otherwise insert literal "[I"/"[O" junk into the line — drop them.
    if (/^(?:\x1b?\[[IO])+$/.test(input)) return
    // Paste or bulk input can deliver a chunk with embedded CR/LF. The input is
    // multi-line now, so insert the whole thing at the cursor (normalising line
    // endings to '\n') instead of submitting the first line.
    if (/[\r\n]/.test(input)) {
      const chunk = input.replace(/\r\n|\r/g, '\n')
      setValue(g.slice(0, cursor).join('') + chunk + g.slice(cursor).join(''))
      setCursor((c) => c + toGraphemes(chunk).length)
      setDismissed(false); setSelected(0)
      return
    }
    setValue(g.slice(0, cursor).join('') + input + g.slice(cursor).join(''))
    setCursor((c) => c + toGraphemes(input).length)
    setDismissed(false); setSelected(0)
  }, { isActive: active })

  const border = active ? colors.accent : colors.dim
  const isEmpty = value.length === 0
  // In vim normal mode the prompt glyph flips to a filled block as a mode cue.
  const vimNorm = editorMode === 'vim' && vimNormal && active
  const promptGlyph = vimNorm ? '▮' : symbols.userPrompt

  // Inner text width = box width minus borders (2), padding (2) and the 2-col
  // "> "/indent prefix every row carries. `value` soft-wraps to this width and
  // also breaks on the manual '\n' newlines from shift/ctrl+Enter.
  const inner = Math.max(8, width - 6)
  const { rows, cRow, cCol, rowStart } = layoutInput(value, cursor, inner)
  // Cap the visible height and window to keep the cursor row on screen, so a very
  // long prompt scrolls inside the box instead of pushing the transcript away.
  let startRow = 0
  if (rows.length > MAX_INPUT_ROWS) {
    startRow = Math.min(Math.max(0, cRow - MAX_INPUT_ROWS + 1), rows.length - MAX_INPUT_ROWS)
  }
  const visibleRows = rows.slice(startRow, startRow + MAX_INPUT_ROWS)
  // Reserve one extra column for the inverse cursor block that precedes the hint
  // while the input is active, so marker + cursor + hint can never exceed width.
  const hint = truncateToWidth(placeholder, Math.max(8, inner - (active ? 1 : 0)))

  // Stash live geometry for the mouse listener: how many screen rows the content
  // occupies and the screen row of its first line. The box is bottom-anchored, so
  // its bottom border sits at screen row (screenRows - bottomOffset) and the top
  // content row is that many rows above the content height — no fragile top-down
  // math. contentTop is 1-based to match SGR mouse y coordinates.
  const contentRows = isEmpty ? 1 : visibleRows.length
  const contentTop = screenRows > 0 ? screenRows - bottomOffset - contentRows : 0
  geomRef.current = { rows, rowStart, startRow, contentRows, contentTop }

  // Selection span in absolute grapheme indices (empty when a==b or unset).
  const selLo = msel && msel.a !== msel.b ? Math.min(msel.a, msel.b) : -1
  const selHi = msel && msel.a !== msel.b ? Math.max(msel.a, msel.b) : -1
  const hasSel = selLo >= 0

  return (
    <Box flexDirection="column" width={width}>
      {menuOpen ? <CommandMenu matches={matches} selected={sel} width={width} /> : atOpen ? <AtMenu matches={atMatches} selected={atSel} width={width} /> : null}

      {/* flexDirection="column" is load-bearing: each row is the cross-axis child
          and stretches to the box's full inner width, so wrap="truncate" measures
          the real width (≈ terminal − 4) rather than the row's short intrinsic
          width (which would push content onto the bottom border). We wrap the
          text ourselves (layoutInput) and let the box grow in height. */}
      <Box borderStyle="round" borderColor={border} paddingX={1} flexDirection="column" width={width}>
        {isEmpty ? (
          <Text wrap="truncate">
            <Text color={colors.accent}>{promptGlyph} </Text>
            {active ? <Text inverse> </Text> : null}
            <Text color={colors.dim}>{hint}</Text>
          </Text>
        ) : (
          visibleRows.map((rowG, i) => {
            const absRow = startRow + i
            const marker = absRow === 0 ? `${promptGlyph} ` : '  '
            const gStart = rowStart[absRow] ?? 0
            // Draw the caret block only when nothing is highlighted, so a live
            // selection doesn't show two competing inverse spans.
            const isCursorRow = active && absRow === cRow && !hasSel
            const rowLo = gStart, rowHi = gStart + rowG.length
            const selTouches = hasSel && selHi > rowLo && selLo < rowHi
            // Fast path: plain row (no highlight, not the cursor row).
            if (!isCursorRow && !selTouches) {
              return (
                <Text key={absRow} wrap="truncate">
                  <Text color={colors.accent}>{marker}</Text>
                  <Text color={colors.text}>{rowG.join('')}</Text>
                </Text>
              )
            }
            // Per-grapheme render so the selection highlight (and/or caret block)
            // lands on exactly the right cells.
            const parts: React.ReactElement[] = []
            for (let k = 0; k < rowG.length; k++) {
              const idx = gStart + k
              const inSel = hasSel && idx >= selLo && idx < selHi
              const isCur = isCursorRow && k === cCol
              parts.push(<Text key={k} inverse={inSel || isCur} color={colors.text}>{rowG[k]}</Text>)
            }
            // Caret parked at the row's end (no grapheme under it).
            if (isCursorRow && cCol >= rowG.length) parts.push(<Text key="end" inverse> </Text>)
            return (
              <Text key={absRow} wrap="truncate">
                <Text color={colors.accent}>{marker}</Text>
                {parts}
              </Text>
            )
          })
        )}
      </Box>
    </Box>
  )
}

// Highest number of input rows drawn at once; a longer prompt scrolls within the
// box (the cursor row is always kept visible).
const MAX_INPUT_ROWS = 10

// Lay `value` (which may hold manual '\n' newlines from shift/ctrl+Enter) into
// visual rows that each fit `inner` display columns, soft-wrapping long logical
// lines on grapheme boundaries. Returns the rows (as grapheme arrays) plus the
// cursor's visual position — row index and grapheme offset within that row — so
// the inverse cursor block lands exactly where the terminal will draw the caret.
function layoutInput(value: string, cursor: number, inner: number): { rows: string[][]; cRow: number; cCol: number; rowStart: number[] } {
  const gs = toGraphemes(value)
  const rows: string[][] = [[]]
  // rowStart[r] = grapheme index in `value` at which visual row r begins, so a
  // mouse click on row r, column c maps back to an absolute grapheme index.
  const rowStart: number[] = [0]
  let colW = 0
  let cRow = 0
  let cCol = 0
  let placed = false
  for (let i = 0; i <= gs.length; i++) {
    if (i === cursor) { cRow = rows.length - 1; cCol = rows[rows.length - 1].length; placed = true }
    if (i === gs.length) break
    const ch = gs[i]
    if (ch === '\n') { rows.push([]); rowStart.push(i + 1); colW = 0; continue }
    const w = Math.max(1, displayWidth(ch))
    if (colW + w > inner && rows[rows.length - 1].length > 0) { rows.push([]); rowStart.push(i); colW = 0 }
    rows[rows.length - 1].push(ch)
    colW += w
  }
  if (!placed) { cRow = rows.length - 1; cCol = rows[rows.length - 1].length }
  return { rows, cRow, cCol, rowStart }
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
  const t = useT()
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
        {t('menu.footer')}
      </Text>
    </Box>
  )
}

// The @-mention file picker dropdown, rendered above the input box like the
// command menu. Shows workspace-relative paths; the basename is emphasized (that
// is what the user is usually matching on) and the directory dimmed.
function AtMenu({
  matches,
  selected,
  width,
}: {
  matches: string[]
  selected: number
  width: number
}): React.ReactElement {
  const colors = useTheme()
  const t = useT()
  const total = matches.length
  const rows = Math.min(MENU_MAX_ROWS, total)
  const start =
    total <= rows ? 0 : Math.min(Math.max(0, selected - Math.floor(rows / 2)), total - rows)
  const windowed = matches.slice(start, start + rows)

  return (
    <Box flexDirection="column" width={width} paddingLeft={1}>
      {windowed.map((f, i) => {
        const isSel = start + i === selected
        const cut = f.lastIndexOf('/') + 1
        const dir = f.slice(0, cut)
        const base = f.slice(cut)
        return (
          <Text key={f} wrap="truncate">
            <Text color={isSel ? colors.accentBright : colors.dim}>{isSel ? '▸ ' : '  '}</Text>
            {dir ? <Text color={colors.dim}>{dir}</Text> : null}
            <Text color={isSel ? colors.accentBright : colors.text} bold={isSel}>{base}</Text>
          </Text>
        )
      })}
      <Text color={colors.dim} wrap="truncate">
        {'  '}
        {total > rows ? `${selected + 1}/${total} · ` : ''}
        {t('menu.atFooter')}
      </Text>
    </Box>
  )
}
