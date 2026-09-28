import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// A tiny file-based mailbox so concurrent MeowCode sessions (same machine, same
// user) can message each other — what the `otherSessionMessages` setting
// surfaces ('off' | 'notify' | 'deliver'). Everything lives under
// ~/.anycode/mailbox/: one JSON file per message, plus a presence/ subdir where
// each running session heartbeats a file so peers can be listed and DM'd.
//
// Best-effort throughout: a missing dir means "no peers / no mail", and every
// read/write swallows its error rather than throwing into the UI. This is a
// same-machine convenience, not a durable queue — old mail and dead sessions'
// presence files are garbage-collected on access.
const DIR = path.join(os.homedir(), '.anycode', 'mailbox')
const PRES = path.join(DIR, 'presence')
const PRESENCE_TTL = 30_000        // a presence file older than this = dead session
const MAIL_TTL = 10 * 60_000       // mail older than this is GC'd
const MAX_MAIL = 500               // hard cap on mailbox size

export interface Peer { id: string; title: string; cwd: string; at: number }
export interface Mail { id: string; from: string; fromTitle: string; to: string; text: string; ts: number }

// Identity of THIS running session, set once the app knows its session id (see
// app.tsx). Held module-level — like the checkpoint store, one process, one
// identity — so the /dm command and the poll effect share it without plumbing.
let self: { id: string; title: string; cwd: string } | null = null
export function setIdentity(id: string, title: string, cwd: string): void { self = { id, title, cwd } }
export function getIdentity(): { id: string; title: string; cwd: string } | null { return self }

// Read every *.json directly in `dir` (never recursing into subdirs like
// presence/), parsed and tagged with its filename so callers can unlink it.
function readJsonFiles<T>(dir: string): Array<{ file: string; data: T }> {
  let ents: fs.Dirent[]
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out: Array<{ file: string; data: T }> = []
  for (const e of ents) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue
    try { out.push({ file: path.join(dir, e.name), data: JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8')) as T }) } catch { /* skip corrupt */ }
  }
  return out
}

// Publish (or refresh) this session's presence file. Called on a heartbeat so a
// crashed session's entry goes stale within PRESENCE_TTL instead of lingering.
export function announce(now: number): void {
  if (!self) return
  try {
    fs.mkdirSync(PRES, { recursive: true })
    fs.writeFileSync(path.join(PRES, `${self.id}.json`), JSON.stringify({ id: self.id, title: self.title, cwd: self.cwd, at: now }))
  } catch { /* best-effort */ }
}

// Remove this session's presence file on a clean exit (peers stop listing it at
// once rather than waiting for the TTL).
export function farewell(): void {
  if (!self) return
  try { fs.unlinkSync(path.join(PRES, `${self.id}.json`)) } catch { /* already gone */ }
}

// Live peer sessions (fresh presence, not us), newest first. Stale entries are
// unlinked as we pass over them so the directory self-cleans.
export function livePeers(now: number): Peer[] {
  const peers: Peer[] = []
  for (const { file, data } of readJsonFiles<Peer>(PRES)) {
    if (!data || typeof data.id !== 'string') continue
    if (now - data.at >= PRESENCE_TTL) { try { fs.unlinkSync(file) } catch { /* ignore */ } ; continue }
    if (self && data.id === self.id) continue
    peers.push(data)
  }
  return peers.sort((a, b) => b.at - a.at)
}

// Trim the mailbox: drop expired mail, then the oldest beyond MAX_MAIL.
function gcMail(now: number): void {
  const all = readJsonFiles<Mail>(DIR)
  const live = all.filter(({ file, data }) => {
    if (!data || now - data.ts >= MAIL_TTL) { try { fs.unlinkSync(file) } catch { /* ignore */ } ; return false }
    return true
  })
  if (live.length > MAX_MAIL) {
    live.sort((a, b) => a.data.ts - b.data.ts)
    for (const { file } of live.slice(0, live.length - MAX_MAIL)) { try { fs.unlinkSync(file) } catch { /* ignore */ } }
  }
}

// Post a message to `to` (a peer session id, or '*' to broadcast). Returns false
// when we have no identity yet (nothing to stamp the sender with).
export function sendMail(to: string, text: string, now: number, rand: string): boolean {
  if (!self) return false
  try {
    fs.mkdirSync(DIR, { recursive: true })
    const mail: Mail = { id: `${now}-${rand}`, from: self.id, fromTitle: self.title, to, text, ts: now }
    fs.writeFileSync(path.join(DIR, `${mail.id}.json`), JSON.stringify(mail))
    gcMail(now)
    return true
  } catch { return false }
}

// Mail addressed to us (or broadcast) that arrived after `sinceTs`, oldest first.
// Our own messages are skipped. GCs the mailbox as a side effect.
export function pollMail(sinceTs: number, now: number): Mail[] {
  if (!self) return []
  const mine: Mail[] = []
  for (const { data } of readJsonFiles<Mail>(DIR)) {
    if (!data || typeof data.ts !== 'number' || typeof data.text !== 'string') continue
    if (data.ts <= sinceTs || data.from === self.id) continue
    if (data.to === self.id || data.to === '*') mine.push(data)
  }
  gcMail(now)
  return mine.sort((a, b) => a.ts - b.ts)
}
