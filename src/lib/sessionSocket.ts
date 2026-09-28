import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Real-time inter-session transport over Unix-domain sockets. Each running
// MeowCode session listens on ~/.anycode/ipc/<id>.sock; peers connect and write
// newline-delimited JSON frames for INSTANT delivery — complementing the
// file-based mailbox (lib/mailbox.ts), which stays as a durable fallback and the
// source of presence/listing. A message frame carries the SAME id its fallback
// mail uses, so a receiver that gets both dedups to one (see app.tsx).
//
// Everything is best-effort: socket creation, connect, and IO errors are all
// swallowed so a missing or blocked socket layer never breaks the CLI — the
// mailbox still delivers. Unix sockets are a Unix/macOS feature; where they're
// unavailable, creation simply fails and we fall back silently.

const DIR = path.join(os.homedir(), '.anycode', 'ipc')

export type FrameKind = 'msg' | 'idle' | 'sub' | 'unsub'
export interface SockFrame {
  kind: FrameKind
  id: string
  from: string
  fromTitle: string
  text?: string
  ts: number
}

const sockPath = (id: string): string => path.join(DIR, `${id}.sock`)

let server: net.Server | null = null
let selfId: string | null = null
let selfTitle = ''
// Sessions subscribed to OUR idle notifications (they sent us a 'sub' frame).
const subscribers = new Set<string>()
// Peers WE are subscribed to — so /sessions can list and toggle them.
const mySubs = new Set<string>()

export function mySubscriptions(): string[] { return [...mySubs] }
export function isSubscribed(id: string): boolean { return mySubs.has(id) }
export function setSelfTitle(title: string): void { selfTitle = title }
/** Is a peer currently listening (its socket exists)? A liveness hint, racy by nature. */
export function isReachable(id: string): boolean {
  try { return fs.existsSync(sockPath(id)) } catch { return false }
}

// PLACEHOLDER_HUB

// Start listening on this session's socket. `onFrame` fires for every received
// frame (already parsed). Returns a stop() that closes the server and removes the
// socket file. Incoming sub/unsub frames also update our subscriber set here.
export function startHub(id: string, title: string, onFrame: (f: SockFrame) => void): () => void {
  stopHub()
  selfId = id
  selfTitle = title
  try {
    fs.mkdirSync(DIR, { recursive: true })
    const p = sockPath(id)
    try { fs.unlinkSync(p) } catch { /* no stale socket from a prior crash */ }
    const srv = net.createServer((conn) => {
      conn.setEncoding('utf8')
      let buf = ''
      conn.on('data', (d: string) => {
        buf += d
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
          if (!line.trim()) continue
          let f: SockFrame | null = null
          try { f = JSON.parse(line) as SockFrame } catch { continue }
          if (!f || typeof f.id !== 'string' || typeof f.from !== 'string') continue
          if (f.kind === 'sub') subscribers.add(f.from)
          else if (f.kind === 'unsub') subscribers.delete(f.from)
          try { onFrame(f) } catch { /* a UI callback must never kill the socket */ }
        }
      })
      conn.on('error', () => { /* ignore a broken peer connection */ })
    })
    srv.on('error', () => { /* never throw into the app */ })
    srv.listen(p)
    server = srv
  } catch { /* sockets unavailable — the mailbox still works */ }
  return stopHub
}

export function stopHub(): void {
  const srv = server; server = null
  const id = selfId
  subscribers.clear(); mySubs.clear()
  if (srv) { try { srv.close() } catch { /* ignore */ } }
  if (id) { try { fs.unlinkSync(sockPath(id)) } catch { /* already gone */ } }
}

// Connect to a peer socket, write ONE frame, then close. Fire-and-forget: every
// error is swallowed (the mailbox fallback covers a miss). Skips the connect when
// the peer clearly isn't listening to avoid ENOENT churn.
function writeFrame(toId: string, frame: SockFrame): void {
  if (!isReachable(toId)) return
  let conn: net.Socket
  try { conn = net.createConnection(sockPath(toId)) } catch { return }
  conn.on('error', () => { try { conn.destroy() } catch { /* ignore */ } })
  conn.on('connect', () => {
    try { conn.write(JSON.stringify(frame) + '\n', () => { try { conn.end() } catch { /* ignore */ } }) }
    catch { try { conn.destroy() } catch { /* ignore */ } }
  })
}

// Deliver a chat message to a peer in real time (pair with a mailbox write using
// the SAME id for durability + dedup). `to` is a peer session id.
export function sendMessageFrame(to: string, id: string, text: string, ts: number): void {
  if (!selfId) return
  writeFrame(to, { kind: 'msg', id, from: selfId, fromTitle: selfTitle, text, ts })
}

// Subscribe to / unsubscribe from a peer's idle notifications. We track the
// subscription locally and tell the peer so it can notify us when it goes idle.
export function subscribeTo(to: string, ts: number): void {
  if (!selfId) return
  mySubs.add(to)
  writeFrame(to, { kind: 'sub', id: `sub-${ts}`, from: selfId, fromTitle: selfTitle, ts })
}
export function unsubscribeFrom(to: string, ts: number): void {
  if (!selfId) return
  mySubs.delete(to)
  writeFrame(to, { kind: 'unsub', id: `unsub-${ts}`, from: selfId, fromTitle: selfTitle, ts })
}

// Tell every subscriber that this session just went idle (finished a turn).
export function notifyIdle(ts: number): void {
  if (!selfId || subscribers.size === 0) return
  for (const s of subscribers) writeFrame(s, { kind: 'idle', id: `idle-${ts}`, from: selfId, fromTitle: selfTitle, ts })
}
