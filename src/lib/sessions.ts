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
import { CONFIG_DIR } from '../config'
import type { SessionSnapshot } from '../app'

export const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions')

// Keep at most this many sessions on disk; the oldest fall off on save.
const MAX_SESSIONS = 50

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
function deriveTitle(snap: SessionSnapshot): string {
  const first = snap.messages.find((m) => m.role === 'user' && m.content.trim() && !m.content.startsWith('/'))
  const text = (first?.content ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return '(empty session)'
  return text.length > 60 ? text.slice(0, 59) + '…' : text
}

// Messages that actually carry content (skip the banner marker and blanks).
function realCount(snap: SessionSnapshot): number {
  return snap.messages.filter((m) => m.content !== '__banner__' && m.content.trim()).length
}

// Write (or overwrite) a session under `id`. No-op for an empty transcript, so
// quitting a just-opened session never litters the list. The API key is stripped
// from the stored config, exactly like saveConfig.
export function saveSession(id: string, snap: SessionSnapshot): void {
  try {
    if (realCount(snap) === 0) return
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
    const { apiKey: _omit, ...config } = snap.config
    const rec: SavedSession = {
      id,
      savedAt: Date.now(),
      cwd: process.cwd(),
      title: deriveTitle(snap),
      messageCount: realCount(snap),
      snapshot: { ...snap, config: config as SessionSnapshot['config'] },
    }
    fs.writeFileSync(fileFor(id), JSON.stringify(rec))
    prune()
  } catch {
    // best-effort; session persistence is non-critical
  }
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

// All sessions' metadata, newest-first. Best-effort: unreadable files are skipped.
export function listSessions(): SessionMeta[] {
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

// Load a full session snapshot by id (null if missing/corrupt).
export function loadSession(id: string): SessionSnapshot | null {
  return readFile(id)?.snapshot ?? null
}

// The most-recently-saved session's metadata, or null (drives `--continue`).
export function latestSession(): SessionMeta | null {
  return listSessions()[0] ?? null
}

// Trim to MAX_SESSIONS, deleting the oldest files.
function prune(): void {
  try {
    for (const m of listSessions().slice(MAX_SESSIONS)) {
      try { fs.unlinkSync(fileFor(m.id)) } catch { /* ignore one bad unlink */ }
    }
  } catch {
    // best-effort; pruning is non-critical
  }
}
