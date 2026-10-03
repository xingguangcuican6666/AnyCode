// Persistent full-session save/restore: a session's whole transcript plus its
// config, goal, loop and usage survive quitting MeowCode and can be reopened with
// /resume (or `meowcode --continue`). This is the entire conversation — distinct
// from lib/history.ts, which only stores the ↑/↓ input recall. Each session is one
// JSON file at ~/.anycode/sessions/<id>.json; the newest-first list drives the
// /resume picker.
//
// Everything here is best-effort and never throws: a missing/corrupt file just
// means "that session is gone", and a failed write silently drops that one
// autosave. The stored config never carries the API key (same rule as saveConfig).
import path from 'node:path'
import fs from 'node:fs'
import { CONFIG_DIR, loadConfig } from '../config'
import { getSetting } from './settings'
import { summarizeTitle } from './summarize'
import type { SessionSnapshot } from '../app'

export const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions')

// Keep at most this many sessions PER WORKSPACE (cwd); the oldest in a workspace
// fall off on save. Other workspaces' sessions are never touched — history is
// scoped to the project you're in, not one global list.
const MAX_PER_WORKSPACE = 100

// Normalize a cwd for stable comparison across saves (absolute, no trailing /).
function normCwd(p: string): string {
  try { return path.resolve(p) } catch { return p }
}

// One saved session file: the snapshot plus the metadata the picker lists.
export interface SavedSession {
  id: string
  savedAt: number       // epoch ms of the last autosave
  cwd: string
  title: string         // first user line, for the picker
  messageCount: number
  snapshot: SessionSnapshot
}

// Just the fields the picker needs (no full transcript), newest-first.
export type SessionMeta = Omit<SavedSession, 'snapshot'>

// A fresh, filename-safe, time-sortable id: base36 timestamp + short random tail.
export function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const fileFor = (id: string): string => path.join(SESSIONS_DIR, `${id}.json`)

// A short one-line title from the first real user message (commands/blank skipped).
// Kept as the synchronous fallback when the model summarizer is unavailable.
function deriveTitle(snap: SessionSnapshot): string {
  const first = titleSource(snap.messages).find((m) => m.role === 'user' && !m.content.startsWith('/'))
  const text = (first?.content ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return '(empty session)'
  return text.length > 60 ? text.slice(0, 59) + '…' : text
}

// The messages a title may be derived from: slash-command turns (meta.command)
// and async-event wakeup turns (meta.wakeup) are machine input, not user intent,
// so neither the model summarizer nor the fallback should title a session after
// a "/resume" or a monitor flush. Content-bearing messages only.
function titleSource(messages: SessionSnapshot['messages']): SessionSnapshot['messages'] {
  return messages.filter((m) => m.content !== '__banner__' && m.content.trim() && !m.meta?.command && !m.meta?.wakeup)
}

// Messages that actually carry content (skip the banner marker and blanks).
function realCount(snap: SessionSnapshot): number {
  return snap.messages.filter((m) => m.content !== '__banner__' && m.content.trim()).length
}

// Write (or overwrite) a session under `id`. No-op for an empty transcript, so
// quitting a just-opened session never litters the list. The API key is stripped
// from the stored config, exactly like saveConfig.
// The title is a model-written one-line summary of the conversation (falls back
// to the first user message when the summarizer is unavailable, so saving never
// blocks on the network). Called on every debounced autosave, so it must be
// cheap: only re-summarize when the message count crosses a threshold.
export function saveSession(id: string, snap: SessionSnapshot): void {
  try {
    if (realCount(snap) === 0) return
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
    const { apiKey: _omit, ...config } = snap.config
    void persistSession(id, snap, config as SessionSnapshot['config'])
  } catch {
    // best-effort; session persistence is non-critical
  }
}

// How often to re-summarize the title: only when the message count grows by at
// least this many since the last model-written title (so a burst of streaming
// autosaves doesn't fire an API call each time). The first title is written at
// the very first save so the picker has a readable name immediately.
const TITLE_REFRESH_EVERY = 10

// Last message count we wrote a model title for, per session id, so successive
// autosaves know whether to refresh. In-memory only; a fresh process just
// re-titles on its first save.
const lastTitleCount = new Map<string, number>()

async function persistSession(id: string, snap: SessionSnapshot, config: SessionSnapshot['config']): Promise<void> {
  const count = realCount(snap)
  const prevCount = lastTitleCount.get(id) ?? 0
  const shouldTitle = prevCount === 0 || count - prevCount >= TITLE_REFRESH_EVERY
  let title = deriveTitle(snap)
  if (shouldTitle) {
    const summarized = await summarizeTitle(titleSource(snap.messages), config)
    if (summarized) {
      title = summarized.replace(/\s+/g, ' ').trim()
      if (title.length > 80) title = title.slice(0, 79) + '…'
      lastTitleCount.set(id, count)
    } else {
      // Summarizer unavailable/failed: remember the count anyway so we don't
      // hammer the API on every autosave while it stays down.
      lastTitleCount.set(id, count)
    }
  } else {
    // Keep the previously-saved title for this refresh cycle: re-read it so a
    // burst of autosaves doesn't clobber a good model title with the fallback.
    const existing = readFile(id)
    if (existing?.title) title = existing.title
    // Repair titles written before commands were excluded from title
    // derivation: a stored title beginning with "/" can only have come from a
    // slash-command turn, so regenerate it now rather than leaving it forever.
    if (title.startsWith('/')) title = deriveTitle(snap)
  }
  const rec: SavedSession = {
    id,
    savedAt: Date.now(),
    cwd: process.cwd(),
    title,
    messageCount: count,
    snapshot: { ...snap, config },
  }
  fs.writeFileSync(fileFor(id), JSON.stringify(rec))
  prune()
}

// Read one raw session file, or null if missing/corrupt. Treats the file as
// untrusted: a record without the expected shape is dropped rather than trusted.
function readFile(id: string): SavedSession | null {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(id), 'utf8')) as SavedSession
    if (!raw || typeof raw.id !== 'string' || !raw.snapshot || !Array.isArray(raw.snapshot.messages)) return null
    return raw
  } catch {
    return null
  }
}

// Every session's metadata across all workspaces, newest-first. Best-effort:
// unreadable files are skipped.
function allMetas(): SessionMeta[] {
  let names: string[] = []
  try {
    names = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    return [] // directory not created yet — no sessions
  }
  const metas: SessionMeta[] = []
  for (const f of names) {
    const rec = readFile(f.replace(/\.json$/, ''))
    if (rec) metas.push({ id: rec.id, savedAt: rec.savedAt, cwd: rec.cwd, title: rec.title, messageCount: rec.messageCount })
  }
  return metas.sort((a, b) => b.savedAt - a.savedAt)
}

// Saved sessions' metadata, newest-first. Scoped to ONE workspace by default
// (the current cwd) so /resume and `--continue` show this project's own history
// instead of a globally-shared list — pass `null` to list every workspace.
export function listSessions(cwd: string | null = process.cwd()): SessionMeta[] {
  const all = allMetas()
  if (cwd === null) return all
  const want = normCwd(cwd)
  return all.filter((m) => normCwd(m.cwd) === want)
}

// Load a full session snapshot by id (null if missing/corrupt).
export function loadSession(id: string): SessionSnapshot | null {
  return readFile(id)?.snapshot ?? null
}

// Fork a saved session: copy its transcript into a NEW session file under a fresh
// id and return that id, leaving the source untouched so the conversation can
// branch without altering the original. Used by `/fork` (branch and continue) and
// `--fork-session` (open a copy at launch). Returns null when the source is
// missing/corrupt or carries no content worth forking. The copy is stamped with
// the current workspace, so a fork always lands in the project you're in.
export function forkSession(sourceId: string): string | null {
  const snap = loadSession(sourceId)
  if (!snap) return null
  const newId = newSessionId()
  saveSession(newId, snap)
  // saveSession no-ops on an empty transcript; confirm the copy actually landed.
  return loadSession(newId) ? newId : null
}

// The most-recently-saved session's metadata in this workspace, or null (drives
// `--continue`). Pass `null` for the globally newest across all workspaces.
export function latestSession(cwd: string | null = process.cwd()): SessionMeta | null {
  return listSessions(cwd)[0] ?? null
}

// Trim each workspace to MAX_PER_WORKSPACE, deleting its oldest files. Grouped
// by cwd so a busy project never evicts another project's saved sessions. Also
// applies the `cleanupPeriodDays` retention policy across ALL workspaces: any
// session last saved longer ago than that window is deleted (0 = keep forever).
function prune(): void {
  try {
    const metas = allMetas() // already newest-first
    // Age-based retention (global): mirrors Claude Code's cleanupPeriodDays. Read
    // from the persisted config so it applies even to background autosaves.
    let cutoff = 0
    try {
      const days = Number(getSetting(loadConfig().settings, 'cleanupPeriodDays'))
      if (Number.isFinite(days) && days > 0) cutoff = Date.now() - days * 86_400_000
    } catch { /* config unreadable — skip age pruning */ }
    const survivors: SessionMeta[] = []
    for (const m of metas) {
      if (cutoff && m.savedAt < cutoff) {
        try { fs.unlinkSync(fileFor(m.id)) } catch { /* ignore one bad unlink */ }
      } else {
        survivors.push(m)
      }
    }
    // Count-based cap, per workspace, on whatever's left after age pruning.
    const byCwd = new Map<string, SessionMeta[]>()
    for (const m of survivors) {
      const k = normCwd(m.cwd)
      const arr = byCwd.get(k) ?? []
      arr.push(m)
      byCwd.set(k, arr)
    }
    for (const arr of byCwd.values()) {
      for (const m of arr.slice(MAX_PER_WORKSPACE)) {
        try { fs.unlinkSync(fileFor(m.id)) } catch { /* ignore one bad unlink */ }
      }
    }
  } catch {
    // best-effort; pruning is non-critical
  }
}
