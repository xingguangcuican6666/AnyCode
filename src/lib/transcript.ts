// Flatten the message transcript into terminal-row lines for the scroll
// viewport (see components/ScrollView). The custom scroll needs exact
// windowing math, so each returned entry must render to EXACTLY one terminal
// row — the ScrollView draws every line with wrap="truncate", so a line wider
// than the terminal is truncated to one row rather than wrapped into several,
// keeping `lines[i]` ↔ row i in lockstep. We split each message's rendered
// content on '\n' (renderMarkdown already reflows prose to the given width) and
// tag each line with a kind so the ScrollView can color it like the transcript.
import type { Message } from '../types'
import os from 'node:os'
import { renderMarkdown } from './markdown'
import { symbols } from '../theme'
import { NAME, VERSION } from '../version'

export type LineKind = 'user' | 'assistant' | 'system' | 'error' | 'tool' | 'tool-header' | 'thinking' | 'retry' | 'blank'

export interface FlatLine {
  text: string   // may carry ANSI styling (from renderMarkdown); no embedded newline
  kind: LineKind
}

// Turn a list of messages into one flat, row-per-entry array. `width` is the
// full terminal width; prose is reflowed to width-4 (matching Message.tsx) and
// indented two columns so it reads like the live transcript.
export function flattenMessages(messages: Message[], width: number, opts?: { banner?: boolean }): FlatLine[] {
  const out: FlatLine[] = []
  const contentW = Math.max(20, width - 4)
  const push = (text: string, kind: LineKind): void => { out.push({ text, kind }) }
  // Collapse runs of blanks to a single spacer between messages.
  const spacer = (): void => { if (out.length && out[out.length - 1].kind !== 'blank') push('', 'blank') }

  for (const m of messages) {
    if (m.role === 'system' && m.content === '__banner__') {
      // The owned viewport scrolls the banner with the transcript (Claude Code
      // scrolls its welcome away too), so — unlike the old <Static> path that
      // rendered <Banner/> as a styled box — it must fold into flat rows here.
      if (opts?.banner) { for (const l of bannerLines(width)) out.push(l); spacer() }
      continue
    }
    if (!m.content.trim() && m.role !== 'tool') continue

    if (m.meta?.thinking) {
      // Committed reasoning collapses to a single dim summary line.
      push(`  ${symbols.star} Thought${m.meta.thinkingSeconds ? ` for ${m.meta.thinkingSeconds}s` : ''}`, 'thinking')
      spacer()
    } else if (m.role === 'user') {
      m.content.split('\n').forEach((l, i) => push(i === 0 ? `${symbols.userPrompt} ${l}` : `  ${l}`, 'user'))
      spacer()
    } else if (m.role === 'system') {
      const kind: LineKind = m.meta?.error ? 'error' : m.meta?.retry ? 'retry' : 'system'
      renderMarkdown(m.content, contentW).split('\n').forEach((l) => push(`  ${l}`, kind))
      spacer()
    } else if (m.role === 'tool') {
      const header = m.content.startsWith('⏺')
      const kind: LineKind = m.meta?.error ? 'error' : header ? 'tool-header' : 'tool'
      m.content.split('\n').forEach((l) => push(`  ${l}`, kind))
    } else {
      renderMarkdown(m.content, contentW).split('\n').forEach((l, i) =>
        push(i === 0 ? `${symbols.assistant} ${l}` : `  ${l}`, 'assistant'))
      if (m.meta?.interrupted) push('  ⎿ interrupted', 'error')
      spacer()
    }
  }
  // Drop trailing spacer(s) so the last real line sits flush at the bottom.
  while (out.length && out[out.length - 1].kind === 'blank') out.pop()
  return out
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
export function thinkingLines(msg: Message, width: number): FlatLine[] {
  const contentW = Math.max(20, width - 4)
  const out: FlatLine[] = [{ text: `  ${symbols.star} Thinking…`, kind: 'thinking' }]
  renderMarkdown(msg.content, contentW).split('\n').forEach((l) => out.push({ text: `  ${l}`, kind: 'thinking' }))
  return out
}
