// Flatten the message transcript into terminal-row lines for the scroll
// viewport (see components/ScrollView). The custom scroll needs exact
// windowing math, so each returned entry must render to EXACTLY one terminal
// row — the ScrollView draws every line with wrap="truncate", so a line wider
// than the terminal is truncated to one row rather than wrapped into several,
// keeping `lines[i]` ↔ row i in lockstep. We split each message's rendered
// content on '\n' (renderMarkdown already reflows prose to the given width) and
// tag each line with a kind so the ScrollView can color it like the transcript.
import type { AgentEvent, DiffLine, Message } from '../types'
import os from 'node:os'
import { renderMarkdown } from './markdown'
import { symbols } from '../theme'
import { NAME, VERSION } from '../version'
import { summarizeToolCall } from '../tools'
import { displayWidth, wrapToWidth, expandTabs } from './text'
import { t } from './i18n'
import wrapAnsi from 'wrap-ansi'

// Render markdown, then re-wrap each line to `width` display columns. marked-
// terminal reflows PARAGRAPHS to the target width but leaves list items (and
// other non-paragraph blocks) as single long lines; the one-row-per-line
// ScrollView would then truncate them with an ellipsis (the "…" the user saw)
// instead of wrapping. wrapAnsi is ANSI-aware (keeps the syntax colouring) and
// CJK-aware (a wide glyph counts as 2 columns). A list item ("  * …" / "  1. …")
// hangs its continuation rows under the text, aligned past the marker, so a
// wrapped bullet reads like one item rather than a new one.
function mdLines(content: string, width: number): string[] {
  const out: string[] = []
  for (const line of renderMarkdown(content, width).split('\n')) {
    if (displayWidth(line) <= width) { out.push(line); continue }
    // Leading list marker is plain ASCII (marked-terminal doesn't colour it), so
    // its char length equals its display width and slicing by index is safe.
    const m = /^(\s*(?:[*\-•]|\d+[.)])\s+)/.exec(line)
    const hang = m ? m[1].length : 0
    if (hang > 0 && hang < width - 8) {
      const marker = line.slice(0, hang)
      const segs = wrapAnsi(line.slice(hang), width - hang, { hard: true, trim: false }).split('\n')
      out.push(marker + segs[0])
      for (let i = 1; i < segs.length; i++) out.push(' '.repeat(hang) + segs[i])
    } else {
      for (const seg of wrapAnsi(line, width, { hard: true, trim: false }).split('\n')) out.push(seg)
    }
  }
  return out
}

// Wrap PLAIN text (no markdown) to `width` display columns. Used for thinking
// blocks: renderMarkdown injects ANSI colour codes only on the FIRST physical
// line of each paragraph, so a markdown-rendered thinking block came out with a
// bright first line and dim continuation lines ("thinking块深浅还不统一"). By
// wrapping the raw text ourselves (no ANSI at all) every line carries the SAME
// colour from colorFor(thinking) → one uniform dim shade. CJK-aware via wrapAnsi.
function plainLines(content: string, width: number): string[] {
  const out: string[] = []
  for (const para of content.split('\n')) {
    if (para === '') { out.push(''); continue }
    for (const seg of wrapAnsi(para, width, { hard: true, trim: false }).split('\n')) out.push(seg)
  }
  return out
}

export type LineKind =
  | 'user' | 'assistant' | 'system' | 'error' | 'tool' | 'tool-header'
  | 'thinking' | 'retry' | 'blank'
  | 'collapsed' | 'diff-add' | 'diff-del' | 'diff-ctx' | 'diff-hunk'

export interface FlatLine {
  text: string   // may carry ANSI styling (from renderMarkdown); no embedded newline
  kind: LineKind
  // Groups collapsible activity: every row sharing a `group` id toggles together
  // when clicked (see app.tsx). Absent for plain, non-collapsible rows.
  group?: string
  // Marks every row of an EXPANDED collapsed block (thinking + merged tool output),
  // INCLUDING the blank padding rows between sub-blocks. app.tsx paints all of them
  // with ONE uniform background so the block reads as a single Claude-Code-style box
  // — tinting the padding rows too is what stops the terminal wallpaper leaking
  // through as patchy holes. The block's sub-blocks are told apart by FONT depth
  // (see colorFor), not by different background shades.
  tint?: boolean
  // Marks the FIRST row of each top-level transcript entry (a prose message, a
  // thinking/merged run, or a tool block). app.tsx uses these boundaries for the
  // "jump to previous message" affordance at the top of the viewport — clicking
  // it scrolls up to the nearest msgStart above the current top row.
  msgStart?: boolean
}

export interface FlattenOpts {
  banner?: boolean
  // Ids the user has toggled from their default state. For merged activity runs
  // presence = expanded (default collapsed); for diff views presence = collapsed
  // (default open). See app.tsx's click handler.
  expanded?: Set<string>
  // Force everything open (the `verbose` setting).
  expandAll?: boolean
}

// Tools whose activity is terse enough to collapse and merge into one summary
// line. Mutating/orchestration tools (write/edit/task/plan/workflow) are shown
// in full (write/edit additionally get a diff view).
const MERGE_TOOLS = new Set(['read_file', 'bash', 'list_dir', 'grep', 'glob'])

// Glyph fronting a collapsed compaction digest row (matches the ⎗ the digest
// message itself used before it became collapsible).
const COMPACT_GLYPH = '⎗'

// One summary phrase for a run of collapsed activity: "Added N lines, removed M"
// (or "No changes"). Exported so useChat/messagesFromEvents build the same line.
export function changeSummary(added: number, removed: number): string {
  if (added === 0 && removed === 0) return t('run.noChanges')
  return t('run.changeSummary', { added, removed, al: added === 1 ? '' : 's', rl: removed === 1 ? '' : 's' })
}

const baseName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p
const firstWord = (s: string): string => s.trim().split(/\s+/)[0] || s.trim()
const abbrevPath = (p: string): string => p.replace(os.homedir(), '~')
const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
// A tool header is "● <name> · <arg>"; pull the pieces back out. Accept the old
// U+23FA "⏺" marker too so tool headers in transcripts saved before the switch
// to the text-presentation U+25CF "●" still parse.
const toolNameFromHeader = (c: string): string => c.replace(/^[●⏺]\s*/, '').split(' · ')[0].trim()
const argFromHeader = (c: string): string => { const i = c.indexOf(' · '); return i < 0 ? '' : c.slice(i + 3).trim() }


// Pre-scanned transcript element: a banner marker, a prose/system message, a
// thinking block, a compaction digest, or a tool call (its "⏺" header paired
// with the following "⎿" result, if any).
type Item =
  | { kind: 'banner' }
  | { kind: 'msg'; m: Message }
  | { kind: 'think'; id: string; m: Message }
  | { kind: 'compact'; id: string; m: Message }
  | { kind: 'tool'; id: string; tool: string; arg: string; header: Message; result?: Message }

// Turn a list of messages into one flat, row-per-entry array. `width` is the
// full terminal width; prose is reflowed to width-4 (matching Message.tsx) and
// indented two columns so it reads like the live transcript. Adjacent collapsed
// activity (thinking + read/bash/list/grep/glob) merges into one summary line;
// write/edit render a line-numbered diff view. `opts.expanded`/`expandAll`
// control what is shown in full (see FlattenOpts).
export function flattenMessages(messages: Message[], width: number, opts?: FlattenOpts): FlatLine[] {
  const out: FlatLine[] = []
  const contentW = Math.max(20, width - 4)
  const expanded = opts?.expanded
  const expandAll = opts?.expandAll === true
  const push = (text: string, kind: LineKind, group?: string): void => { out.push({ text, kind, group }) }
  const spacer = (): void => { if (out.length && out[out.length - 1].kind !== 'blank') push('', 'blank') }

  // 1) Pre-scan into items, pairing each tool header with its result.
  const items: Item[] = []
  for (let k = 0; k < messages.length; k++) {
    const m = messages[k]
    if (m.role === 'system' && m.content === '__banner__') { items.push({ kind: 'banner' }); continue }
    if (m.role === 'system' && m.meta?.compacted) { items.push({ kind: 'compact', id: m.id, m }); continue }
    if (m.meta?.thinking) { items.push({ kind: 'think', id: m.id, m }); continue }
    if (m.role === 'tool' && (m.content.startsWith('●') || m.content.startsWith('⏺'))) {
      const next = messages[k + 1]
      let result: Message | undefined
      if (next && next.role === 'tool' && next.content.startsWith('⎿')) { result = next; k++ }
      items.push({ kind: 'tool', id: m.id, tool: toolNameFromHeader(m.content), arg: argFromHeader(m.content), header: m, result })
      continue
    }
    if (!m.content.trim() && m.role !== 'tool') continue
    items.push({ kind: 'msg', m })
  }

  // 2) Emit. Mergeable runs collapse/merge; everything else renders in full.
  const mergeable = (it: Item): boolean => it.kind === 'think' || (it.kind === 'tool' && MERGE_TOOLS.has(it.tool))
  // Mark the first row emitted for a top-level entry as a message boundary, so
  // app.tsx can jump between entries (see FlatLine.msgStart).
  const markStart = (from: number): void => { if (out[from]) out[from].msgStart = true }
  for (let k = 0; k < items.length; k++) {
    const it = items[k]
    if (it.kind === 'banner') { if (opts?.banner) { for (const l of bannerLines(width)) out.push(l); spacer() } continue }
    if (it.kind === 'compact') {
      // A compaction digest: a single collapsed "⎗ Context compacted · N folded"
      // row by default (click to expand → the full summary the model sees), reusing
      // the same group/expanded toggle as merged activity runs. Never dumps the
      // whole summary into the transcript (issue: "而不是全文展示给用户").
      const gid = it.id
      const open = expandAll || (expanded?.has(gid) ?? false)
      const s = out.length
      const head = `  ${COMPACT_GLYPH} ${t('compact.collapsed', { n: it.m.meta?.foldedCount ?? 0 })}`
      if (open) {
        out.push({ text: head, kind: 'collapsed', group: gid, tint: true })
        mdLines(it.m.content, contentW).forEach((l) => out.push({ text: `  ${l}`, kind: 'system', group: gid, tint: true }))
      } else {
        out.push({ text: head, kind: 'collapsed', group: gid })
      }
      markStart(s)
      spacer()
      continue
    }
    if (it.kind === 'msg') { const s = out.length; emitMsg(it.m, out, contentW); markStart(s); continue }
    if (mergeable(it)) {
      let j = k
      while (j + 1 < items.length && mergeable(items[j + 1])) j++
      const run = items.slice(k, j + 1)
      k = j
      const gid = (run[0] as { id: string }).id
      const open = expandAll || (expanded?.has(gid) ?? false)
      const s = out.length
      if (open) {
        // One continuous, UNIFORMLY-tinted band behind the whole expanded run
        // (see FlatLine.tint / app.tsx). think vs tool are told apart by FONT
        // depth, not by different background shades. A single TINTED blank row
        // separates sub-blocks so they don't read as one glued lump ("为什么挤
        // 那么近") — the row is part of the band (tinted), never a transparent
        // gap that would leak the terminal wallpaper through as a patchy hole.
        run.forEach((r, ri) => {
          if (ri > 0) out.push({ text: '', kind: 'blank', group: gid, tint: true })
          emitMergedFull(r, out, contentW, gid)
        })
      }
      else { const glyph = run[0].kind === 'think' ? symbols.star : symbols.assistant; push(`  ${glyph} ${mergedSummary(run)}`, 'collapsed', gid) }
      markStart(s)
      spacer()
      continue
    }
    // Non-mergeable tool (write/edit/task/plan/workflow): header + result/diff.
    const s = out.length
    emitTool(it as Extract<Item, { kind: 'tool' }>, out, contentW, expanded, expandAll)
    markStart(s)
    spacer()
  }
  while (out.length && out[out.length - 1].kind === 'blank') out.pop()
  return out
}

// A plain user/assistant/system message (no tool/think handling).
function emitMsg(m: Message, out: FlatLine[], contentW: number): void {
  const push = (text: string, kind: LineKind): void => { out.push({ text, kind }) }
  const spacer = (): void => { if (out.length && out[out.length - 1].kind !== 'blank') push('', 'blank') }
  // Per-turn completion footer ("✻ <word> for <elapsed> · done <clock>"): a faint
  // system line, rendered verbatim (no markdown) so the ✻ / · glyphs stay intact.
  if (m.meta?.turnDone) { m.content.split('\n').forEach((l) => push(`  ${l}`, 'system')); spacer(); return }
  if (m.role === 'user') {
    m.content.split('\n').forEach((l, i) => push(i === 0 ? `${symbols.userPrompt} ${l}` : `  ${l}`, 'user'))
  } else if (m.role === 'system') {
    const kind: LineKind = m.meta?.error ? 'error' : m.meta?.retry ? 'retry' : 'system'
    mdLines(m.content, contentW).forEach((l) => push(`  ${l}`, kind))
  } else {
    mdLines(m.content, contentW).forEach((l, i) =>
      push(i === 0 ? `${symbols.assistant} ${l}` : `  ${l}`, 'assistant'))
    if (m.meta?.interrupted) push('  ⎿ interrupted', 'error')
  }
  spacer()
}

// Merged run rendered in full (user clicked to expand): each think block shows
// its reasoning, each tool its header + result — all tagged with `gid` so a
// click anywhere re-collapses the run.
function emitMergedFull(it: Item, out: FlatLine[], contentW: number, gid: string): void {
  const push = (text: string, kind: LineKind): void => { out.push({ text, kind, group: gid, tint: true }) }
  if (it.kind === 'think') {
    push(`  ${symbols.star} Thought${it.m.meta?.thinkingSeconds ? ` for ${it.m.meta.thinkingSeconds}s` : ''}`, 'thinking')
    // PLAIN (not markdown) so every line is the same dim shade — see plainLines.
    plainLines(it.m.content, contentW).forEach((l) => push(`  ${l}`, 'thinking'))
  } else if (it.kind === 'tool') {
    it.header.content.split('\n').forEach((l) => push(`  ${l}`, 'tool-header'))
    if (it.result) {
      const err = it.result.meta?.error
      if (it.tool === 'read_file' && !err) {
        for (const row of readFileRows(it.result.content, contentW + 4)) push(row, 'tool')
      } else {
        it.result.content.split('\n').forEach((l) => push(`  ${l}`, err ? 'error' : 'tool'))
      }
    }
  }
}

// Render a read_file result block with a HANGING INDENT: a code line too wide for
// the row wraps onto continuation rows aligned after the line-number gutter,
// instead of falling back to column 0. read_file numbers each line as
// "<n padded to 5>\t<code>" (see tools/impl.ts) and useChat prefixes the block
// with "⎿ "; the tab puts the code at a fixed column on screen, but string-width
// measures a raw '\t' as 0 columns, so a long line slipped past wrap="truncate"
// and the terminal soft-wrapped it to column 0. We expand every tab to spaces so
// our width math matches the terminal, then hard-wrap the code, indenting each
// wrapped row to the gutter column. Each returned string is exactly one row, so
// the ScrollView's one-line-per-row windowing stays exact. `width` is the full
// terminal width; the 2-space transcript indent is added here.
function readFileRows(content: string, width: number): string[] {
  const rowMax = Math.max(20, width - 1) // 1-col right safety margin (avoid a stray terminal wrap)
  const rows: string[] = []
  for (const raw of content.split('\n')) {
    const line = `  ${raw}`
    const tab = line.indexOf('\t')
    if (tab < 0) { rows.push(line); continue } // no line-number gutter (e.g. the "… (+N more lines)" tail)
    const left = line.slice(0, tab)
    const leftW = displayWidth(left)
    const indent = ((leftW >> 3) + 1) << 3 // next 8-column tab stop = where the code starts on screen
    const code = expandTabs(line.slice(tab + 1), indent) // expand the code's own tabs from that column
    const segs = wrapToWidth(code, Math.max(8, rowMax - indent))
    rows.push(left + ' '.repeat(indent - leftW) + segs[0])
    for (let i = 1; i < segs.length; i++) rows.push(' '.repeat(indent) + segs[i])
  }
  return rows
}

// The one-line summary for a collapsed run: verbs grouped and counted in
// first-seen order, e.g. "Thought for 18s, read app.tsx, listed 2 directories".
function mergedSummary(run: Item[]): string {
  const order: string[] = []
  const g: Record<string, { count: number; first: string }> = {}
  let thinkSecs = 0
  for (const it of run) {
    if (it.kind === 'think') { thinkSecs += it.m.meta?.thinkingSeconds ?? 0; if (!order.includes('think')) order.push('think'); continue }
    if (it.kind !== 'tool') continue
    if (!g[it.tool]) { g[it.tool] = { count: 0, first: it.arg }; order.push(it.tool) }
    g[it.tool].count++
  }
  const phrases = order.map((v) => {
    if (v === 'think') return thinkSecs > 0 ? t('run.thought', { s: thinkSecs }) : t('run.thoughtNoTime')
    const { count, first } = g[v]
    switch (v) {
      case 'read_file': return count === 1 ? t('run.readOne', { name: baseName(first) }) : t('run.readMany', { count })
      case 'list_dir': return count === 1 ? t('run.listedOne', { name: baseName(first) || '.' }) : t('run.listedMany', { count })
      case 'bash': return count === 1 ? t('run.ranOne', { cmd: firstWord(first) }) : t('run.ranMany', { count })
      case 'grep': return count === 1 ? t('run.searchedOne', { pat: first }) : t('run.searchedMany', { count })
      case 'glob': return count === 1 ? t('run.globbedOne', { pat: first }) : t('run.globbedMany', { count })
      default: return `${v} ×${count}`
    }
  })
  return cap(phrases.join(', '))
}

// A non-mergeable tool. write/edit get a rewritten "Update(path)"/"Write(path)"
// header and (default-open, click to collapse) a line-numbered diff; other tools
// render header + result verbatim.
function emitTool(it: Extract<Item, { kind: 'tool' }>, out: FlatLine[], contentW: number, expanded: Set<string> | undefined, expandAll: boolean): void {
  const gid = it.id
  const isWrite = it.tool === 'write_file' || it.tool === 'edit_file'
  const header = isWrite ? `${symbols.assistant} ${it.tool === 'edit_file' ? t('run.update') : t('run.write')}(${abbrevPath(it.arg)})` : it.header.content
  out.push({ text: `  ${header}`, kind: 'tool-header' })
  if (!it.result) return
  const err = it.result.meta?.error
  const diff = it.result.meta?.diff
  if (diff && diff.length && !err) {
    // Summary line (clickable to toggle) then the diff rows (open by default).
    it.result.content.split('\n').forEach((l) => out.push({ text: `  ${l}`, kind: 'tool', group: gid }))
    const open = expandAll || !(expanded?.has(gid) ?? false)
    if (open) for (const dl of diffFlat(diff)) out.push({ ...dl, group: gid })
    return
  }
  it.result.content.split('\n').forEach((l) => out.push({ text: `  ${l}`, kind: err ? 'error' : 'tool' }))
}

// Diff rows → flat lines: right-aligned line number, then a sign column.
function diffFlat(d: DiffLine[]): FlatLine[] {
  const no = (n?: number): string => String(n ?? '').padStart(4)
  return d.map((r): FlatLine => {
    switch (r.tag) {
      case 'add': return { text: `     ${no(r.newNo)} + ${r.text}`, kind: 'diff-add' }
      case 'del': return { text: `     ${no(r.oldNo)} - ${r.text}`, kind: 'diff-del' }
      case 'hunk': return { text: `        ${r.text}`, kind: 'diff-hunk' }
      default: return { text: `     ${no(r.newNo)}   ${r.text}`, kind: 'diff-ctx' }
    }
  })
}


// The welcome banner as flat rows (a rounded box + cwd + help line), so it can
// scroll inside the owned viewport. Mirrors components/Banner.tsx.
export function bannerLines(width: number): FlatLine[] {
  const inner = Math.min(Math.max(38, width - 6), 72)
  const line = (s: string): string => '│ ' + s.padEnd(inner - 1).slice(0, inner - 1) + '│'
  const cwd = process.cwd().replace(os.homedir(), '~')
  return [
    { text: '  ╭' + '─'.repeat(inner) + '╮', kind: 'system' },
    { text: '  ' + line(`${symbols.star} Welcome to ${NAME} v${VERSION}`), kind: 'system' },
    { text: '  ' + line('a Claude Code–style coding agent'), kind: 'system' },
    { text: '  ╰' + '─'.repeat(inner) + '╯', kind: 'system' },
    { text: `  cwd  ${cwd}`, kind: 'system' },
    { text: '  /help commands · /model model · /exit quit', kind: 'system' },
  ]
}

// Live (streaming) reasoning as flat dim rows: a "✻ Thinking…" header plus the
// reflowed reasoning text. The committed form collapses to one "Thought" line
// (see flattenMessages); this keeps the in-progress reasoning visible while it
// streams, so the owned viewport can window it like any other content.
export function thinkingLines(msg: Message, width: number, expanded = false): FlatLine[] {
  // Render the LIVE (streaming) reasoning as a single collapsed line by default —
  // like the committed "✻ Thought for Ns" run — instead of dumping the whole
  // in-flight body above the prompt. This keeps thinking folded while it streams
  // (it never leaks its full text) and avoids the per-delta re-wrap of the entire
  // growing reasoning string that made large thinking blocks lag. When `expanded`
  // (ctrl+o, or the `verbose` setting), show the full in-flight body so the user
  // can read the reasoning as it streams, then collapse again.
  const secs = msg.meta?.thinkingSeconds
  const label = secs ? `${t('message.thinking')} ${secs}s` : t('message.thinking')
  const head: FlatLine = { text: `  ${symbols.star} ${label}`, kind: 'thinking' }
  if (!expanded) return [head]
  const contentW = Math.max(20, width - 4)
  const out: FlatLine[] = [head]
  for (const l of plainLines(msg.content, contentW)) out.push({ text: `  ${l}`, kind: 'thinking' })
  return out
}

// Rebuild a sub-agent's transcript (Message[]) from its raw event stream, so the
// switchable agent view (see app.tsx / AgentSnapshot) flattens it exactly like
// the main transcript: prose → assistant messages, tool_use → a "⏺ …" header,
// tool_result → an indented "⎿ …" block, errors → a system error line. Mirrors
// how useChat.submit commits the top-level stream.
export function messagesFromEvents(events: AgentEvent[]): Message[] {
  const out: Message[] = []
  let acc = ''
  let n = 0
  const flush = (): void => {
    if (acc.trim()) out.push({ id: `ev-a${n++}`, role: 'assistant', content: acc })
    acc = ''
  }
  for (const ev of events) {
    if (ev.type === 'text') acc += ev.text
    else if (ev.type === 'tool_use') {
      flush()
      out.push({ id: `ev-t${n++}`, role: 'tool', content: `● ${summarizeToolCall(ev.name, ev.input)}` })
    } else if (ev.type === 'tool_result') {
      if (ev.diff && ev.diff.length && !ev.isError) {
        out.push({ id: `ev-r${n++}`, role: 'tool', content: `⎿ ${changeSummary(ev.linesAdded ?? 0, ev.linesRemoved ?? 0)}`, meta: { diff: ev.diff } })
      } else {
        out.push({ id: `ev-r${n++}`, role: 'tool', content: toolResultBlock(ev.content, ev.isError), meta: ev.isError ? { error: true } : undefined })
      }
    } else if (ev.type === 'error') {
      flush()
      out.push({ id: `ev-e${n++}`, role: 'system', content: `⚠ ${ev.message}`, meta: { error: true } })
    }
  }
  flush()
  return out
}

// A tool result as the same indented, 12-line-truncated block useChat renders.
function toolResultBlock(content: string, isError?: boolean): string {
  const lines = content.split('\n')
  const shown = lines.slice(0, 12)
  const more = lines.length - shown.length
  const body = shown.join('\n') + (more > 0 ? `\n… (+${more} more lines)` : '')
  return (isError ? '⎿ ⚠ ' : '⎿ ') + body.split('\n').join('\n   ')
}
