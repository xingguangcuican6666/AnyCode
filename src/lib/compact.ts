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

// The split that a compaction would perform: which messages fold (`older`),
// which stay verbatim (`recent`), and the banner to preserve. Kept separate from
// building the digest so a caller can summarize `older` with a model (an async
// step) before assembling the result — see app.tsx doCompact and lib/summarize.
export interface CompactPlan {
  banner?: Message
  older: Message[]
  recent: Message[]
}

// Decide what a compaction would fold, or null when there is nothing worth
// folding. `force` (a manual /compact) folds whenever there is anything older,
// shrinking how many recent messages are kept if the transcript is short — so
// /compact always does something instead of silently reporting "nothing to do".
// Auto-compaction leaves `force` off and only bothers once there are at least
// two older messages worth folding.
export function planCompaction(all: Message[], keepRecent = KEEP_RECENT, opts?: { force?: boolean }): CompactPlan | null {
  const banner = all.find((m) => m.content === '__banner__')
  const body = all.filter((m) => m.content !== '__banner__')
  let keep = keepRecent
  if (opts?.force) {
    if (body.length < 2) return null // only the latest turn — nothing older to fold
    keep = Math.min(keepRecent, Math.max(1, body.length - 1)) // ensure at least one message folds
  } else if (body.length <= keepRecent + 1) {
    return null
  }
  const cut = body.length - keep
  if (cut <= 0) return null
  return { banner, older: body.slice(0, cut), recent: body.slice(cut) }
}

// Assemble a compacted transcript from a plan and a ready summary (model-driven
// or heuristic). The digest carries `meta.compacted` so the provider forwards it
// to the model as a user turn (a plain system message would be dropped).
export function buildCompacted(plan: CompactPlan, summary: string): CompactResult {
  const digest: Message = {
    id: `cmp${++digestCounter}`,
    role: 'system',
    meta: { compacted: true },
    content: `⎗ Context compacted — ${plan.older.length} earlier messages summarized.\n\n${summary}`,
  }
  const messages = plan.banner ? [plan.banner, digest, ...plan.recent] : [digest, ...plan.recent]
  return { messages, folded: plan.older.length }
}

// Fold everything older than the last KEEP_RECENT messages into one digest,
// preserving the banner, using the OFFLINE heuristic summary. Returns
// { messages, folded }; folded === 0 means nothing was folded and `messages` is
// unchanged. This is the synchronous, network-free path (used by the mock
// provider and as the fallback when a model summary is unavailable). For a
// model-driven summary, callers use planCompaction + buildCompacted directly.
