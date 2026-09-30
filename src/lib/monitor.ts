// Session-scoped, agent-facing monitor — MeowCode's answer to Claude Code's
// Monitor tool. The `monitor` tool spawns a shell command; each stdout line the
// command emits becomes a wakeup event fed back into the turn loop (via the sink
// the app wires to setQueued), so the model is notified as things happen instead
// of polling. Long-running watchers (`tail -f`, poll loops) end the watch by
// exiting; the monitor also enforces a timeout and an event cap so a firehose
// can't wedge the session.
//
// Module-level singleton so watchers OUTLIVE a turn (and an App remount): the app
// re-registers its sink on mount. In-memory only; everything is killed on exit.
import { spawn, type ChildProcess } from 'node:child_process'

export interface Monitor {
  id: string
  command: string
  description: string
  startedAt: number
  events: number       // stdout lines forwarded so far
  done: boolean
  child: ChildProcess
  timer: ReturnType<typeof setTimeout>
  buf: string          // partial line carried between data chunks
  coalesce: string[]   // lines gathered within the coalesce window
  flushTimer: ReturnType<typeof setTimeout> | null
}

// The app registers a sink that enqueues forwarded lines as a turn. `lines` is a
// batch coalesced within COALESCE_MS so a burst becomes one turn, not twenty.
type Sink = (lines: string[], meta: { id: string; description: string; done: boolean }) => void

let sink: Sink | null = null
const monitors = new Map<string, Monitor>()
let seq = 0

const COALESCE_MS = 250          // gather a burst of lines into one wakeup
const MAX_EVENTS = 100           // stop a monitor after this many forwarded lines
const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 1_800_000
const MAX_MONITORS = 16

export function setMonitorSink(fn: Sink | null): void { sink = fn }

function flush(m: Monitor): void {
  if (m.flushTimer) { clearTimeout(m.flushTimer); m.flushTimer = null }
  if (m.coalesce.length === 0) return
  const batch = m.coalesce
  m.coalesce = []
  try { sink?.(batch, { id: m.id, description: m.description, done: m.done }) } catch { /* sink errors never kill the watch */ }
}

function emit(m: Monitor, line: string): void {
  if (m.done) return
  m.events += 1
  m.coalesce.push(line)
  if (!m.flushTimer) m.flushTimer = setTimeout(() => flush(m), COALESCE_MS)
  if (m.events >= MAX_EVENTS) stopMonitor(m.id, `event cap (${MAX_EVENTS}) reached`)
}

function finish(m: Monitor, note: string): void {
  if (m.done) return
  m.done = true
  clearTimeout(m.timer)
  // Final flush carries any buffered partial line plus a closing note.
  if (m.buf.trim()) m.coalesce.push(m.buf.trim())
  m.buf = ''
  m.coalesce.push(`[monitor ended: ${note}]`)
  flush(m)
  try { m.child.kill('SIGTERM') } catch { /* already gone */ }
}

export interface MonitorOutcome { monitor?: Monitor; error?: string }

export function startMonitor(command: string, description?: string, timeoutMs?: number): MonitorOutcome {
  // Only RUNNING monitors count toward the cap — ended ones linger for `list`
  // but must never block a new watch.
  const active = [...monitors.values()].filter((m) => !m.done).length
  if (active >= MAX_MONITORS) return { error: `too many active monitors (max ${MAX_MONITORS}); stop some first` }
  const id = `mon${++seq}`
  const ttl = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, timeoutMs ?? DEFAULT_TIMEOUT_MS))
  const child = spawn('bash', ['-lc', command], { stdio: ['ignore', 'pipe', 'pipe'] })
  const m: Monitor = {
    id, command, description: description || command.slice(0, 40), startedAt: Date.now(),
    events: 0, done: false, child, buf: '', coalesce: [], flushTimer: null,
    timer: setTimeout(() => finish(m, `timeout after ${Math.round(ttl / 1000)}s`), ttl),
  }
  const onData = (chunk: Buffer) => {
    m.buf += chunk.toString('utf8')
    const parts = m.buf.split('\n')
    m.buf = parts.pop() ?? ''
    for (const line of parts) { const t = line.trimEnd(); if (t) emit(m, t) }
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)  // stderr lines are events too — watchers often log there
  child.on('error', (err) => finish(m, `spawn error: ${err.message}`))
  child.on('close', (code) => finish(m, `command exited (code ${code ?? 0})`))
  monitors.set(id, m)
  return { monitor: m }
}

export function listMonitors(): Monitor[] {
  return [...monitors.values()].sort((a, b) => a.startedAt - b.startedAt)
}

export function stopMonitor(id: string, note = 'stopped'): boolean {
  const m = monitors.get(id)
  if (!m) return false
  finish(m, note)
  monitors.delete(id)
  return true
}

/** Kill and forget every monitor (e.g. a brand-new session via /clear). */
export function clearMonitors(): void {
  for (const m of monitors.values()) {
    if (m.flushTimer) clearTimeout(m.flushTimer)
    clearTimeout(m.timer)
    try { m.child.kill('SIGKILL') } catch { /* already gone */ }
  }
  monitors.clear()
}
