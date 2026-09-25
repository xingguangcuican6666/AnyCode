// Context compaction: fold older transcript messages into a single digest so a
// long session fits back inside the model's context window. Real Claude Code
// asks the model to summarize; the mock has no general summarizer, so we distill
// structurally (turn counts, files touched, a trimmed excerpt of each side).
//
// This is a PURE transform: given the live messages it returns a new, shorter
// list. Compaction can't mutate the transcript in place because history lives in
// Ink's append-only <Static> — the App applies the result via a clean remount
// (the same primitive used for /clear and resize), which re-emits the compacted
// transcript exactly once.
import type { Message } from '../types'

// Most-recent messages kept verbatim; everything older is summarized.
export const KEEP_RECENT = 6

let digestCounter = 0

// A deterministic, offline-safe digest of the messages being compacted.
export function heuristicSummary(msgs: Message[]): string {
  const users = msgs.filter((m) => m.role === 'user')
  const assistants = msgs.filter((m) => m.role === 'assistant')
  const tools = msgs.filter((m) => m.role === 'tool')
  // Collect file-ish paths mentioned anywhere (src/x.ts, ./a/b, foo.json …).
  const paths = new Set<string>()
  const pathRe = /(?:\.{0,2}\/)?[\w.-]+\/[\w./-]+|[\w-]+\.[a-z]{1,4}\b/gi
  for (const m of msgs) for (const p of m.content.match(pathRe) ?? []) if (p.length > 3) paths.add(p)
  const clip = (s: string, n = 200): string => {
    const t = s.replace(/\s+/g, ' ').trim()
    return t.length > n ? t.slice(0, n) + '…' : t
  }
  const lines: string[] = []
  lines.push(`Folded ${msgs.length} earlier messages (${users.length} user, ${assistants.length} assistant, ${tools.length} tool).`)
  if (paths.size) lines.push(`Files/paths referenced: ${[...paths].slice(0, 20).join(', ')}${paths.size > 20 ? ', …' : ''}`)
  if (users.length) {
    lines.push('', 'What the user asked:')
    for (const u of users.slice(-5)) lines.push(`• ${clip(u.content)}`)
  }
  if (assistants.length) {
    const last = assistants[assistants.length - 1]
    lines.push('', 'Where the assistant left off:', `• ${clip(last.content, 400)}`)
  }
  return lines.join('\n')
}

export interface CompactResult {
  messages: Message[] // the new, shorter transcript (banner + digest + recent)
  folded: number      // how many messages were summarized (0 = nothing to do)
}

// Fold everything older than the last KEEP_RECENT messages into one digest,
// preserving the banner. Returns { messages, folded }; folded === 0 means the
// transcript was already short enough and `messages` is unchanged.
export function compactMessages(all: Message[], keepRecent = KEEP_RECENT): CompactResult {
  const banner = all.find((m) => m.content === '__banner__')
  const body = all.filter((m) => m.content !== '__banner__')
  if (body.length <= keepRecent + 1) return { messages: all, folded: 0 }
  const cut = body.length - keepRecent
  const older = body.slice(0, cut)
  const recent = body.slice(cut)
  const digest: Message = {
    id: `cmp${++digestCounter}`,
    role: 'system',
    content: `⎗ Context compacted — ${older.length} earlier messages summarized.\n\n${heuristicSummary(older)}`,
  }
  const messages = banner ? [banner, digest, ...recent] : [digest, ...recent]
  return { messages, folded: older.length }
}
