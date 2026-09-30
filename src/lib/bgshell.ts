// Background shells — MeowCode's answer to Claude Code's `run_in_background`
// bash + BashOutput + KillShell. The `bash` tool with `run_in_background: true`
// spawns the command here and returns immediately with a shell id; the model
// then polls new output with the `bash_output` tool and kills a shell it no
// longer needs. Unlike `monitor` (which PUSHES each line back as a wakeup turn),
// background shells are PULL: they buffer output silently and hand back only the
// bytes not yet read, so a long build/server/watcher can run alongside the turn
// without flooding it.
//
// Module-level singleton so shells OUTLIVE a turn (they're meant to): everything
// is in-memory and killed on /clear or process exit.
import { spawn, type ChildProcess } from 'node:child_process'

export type BgStatus = 'running' | 'completed' | 'failed' | 'killed'

export interface BgShell {
  id: string
  command: string
  startedAt: number
  endedAt?: number
  child: ChildProcess
  status: BgStatus
  exitCode: number | null
  error?: string
  // Full captured streams plus per-stream read cursors, so `bash_output` can
  // return only what's new since the last read.
  stdout: string
  stderr: string
  outCursor: number
  errCursor: number
  killed: boolean
  timer: ReturnType<typeof setTimeout> | null
}

const shells = new Map<string, BgShell>()
let seq = 0

const MAX_SHELLS = 32            // cap concurrent RUNNING shells
const MAX_BUFFER = 5_000_000     // per-stream byte cap; oldest bytes drop (cursor adjusts)

// Append to a stream buffer, capping its size. When we trim the front we shift
// the read cursor by the same amount so already-read/unread boundaries hold.
function append(s: BgShell, stream: 'stdout' | 'stderr', chunk: string): void {
  const cursor = stream === 'stdout' ? 'outCursor' : 'errCursor'
  s[stream] += chunk
  if (s[stream].length > MAX_BUFFER) {
    const drop = s[stream].length - MAX_BUFFER
    s[stream] = s[stream].slice(drop)
    s[cursor] = Math.max(0, (s[cursor] as number) - drop)
  }
}

export interface StartResult { shell?: BgShell; error?: string }

// Spawn a command detached from the turn (no abort signal wired — that's the
// point). An optional timeout kills it; by default it runs until it exits or is
// killed.
export function startBgShell(command: string, cwd: string, timeoutMs?: number): StartResult {
  const active = [...shells.values()].filter((s) => s.status === 'running').length
  if (active >= MAX_SHELLS) return { error: `too many background shells (max ${MAX_SHELLS}); kill some first` }
  const id = `bash_${++seq}`
  const child = spawn(command, { cwd, shell: '/bin/bash', stdio: ['ignore', 'pipe', 'pipe'] })
  const s: BgShell = {
    id, command, startedAt: Date.now(), child, status: 'running', exitCode: null,
    stdout: '', stderr: '', outCursor: 0, errCursor: 0, killed: false, timer: null,
  }
  if (timeoutMs && timeoutMs > 0) {
    s.timer = setTimeout(() => { s.killed = true; try { child.kill('SIGKILL') } catch { /* gone */ } }, timeoutMs)
  }
  child.stdout?.on('data', (d: Buffer) => append(s, 'stdout', d.toString('utf8')))
  child.stderr?.on('data', (d: Buffer) => append(s, 'stderr', d.toString('utf8')))
  child.on('error', (err) => {
    if (s.timer) { clearTimeout(s.timer); s.timer = null }
    s.status = 'failed'; s.error = err.message; s.endedAt = Date.now()
  })
  child.on('close', (code) => {
    if (s.timer) { clearTimeout(s.timer); s.timer = null }
    if (s.status !== 'failed') {
      s.status = s.killed ? 'killed' : code === 0 ? 'completed' : 'failed'
      s.exitCode = code
      s.endedAt = Date.now()
    }
  })
  shells.set(id, s)
  return { shell: s }
}

export interface ReadResult {
  shell: BgShell
  stdout: string   // new stdout since last read (post-filter)
  stderr: string   // new stderr since last read (post-filter)
}

// Return output produced since the previous read and advance the cursors. An
// optional line-regex filter keeps only matching lines (like BashOutput's
// `filter`). Reading a finished shell is fine — it drains any tail then reports
// its final status.
export function readBgShell(id: string, filter?: string): ReadResult | undefined {
  const s = shells.get(id)
  if (!s) return undefined
  let out = s.stdout.slice(s.outCursor)
  let err = s.stderr.slice(s.errCursor)
  s.outCursor = s.stdout.length
  s.errCursor = s.stderr.length
  if (filter) {
    let re: RegExp | null = null
    try { re = new RegExp(filter) } catch { re = null }
    if (re) {
      const keep = (t: string) => t.split('\n').filter((l) => re!.test(l)).join('\n')
      out = keep(out)
      err = keep(err)
    }
  }
  return { shell: s, stdout: out, stderr: err }
}

export function killBgShell(id: string): boolean {
  const s = shells.get(id)
  if (!s) return false
  if (s.status === 'running') {
    s.killed = true
    if (s.timer) { clearTimeout(s.timer); s.timer = null }
    try { s.child.kill('SIGTERM') } catch { /* gone */ }
    // Escalate if it ignores SIGTERM.
    setTimeout(() => { if (s.status === 'running') try { s.child.kill('SIGKILL') } catch { /* gone */ } }, 2000)
  }
  return true
}

export function listBgShells(): BgShell[] {
  return [...shells.values()].sort((a, b) => a.startedAt - b.startedAt)
}

/** Kill and forget every background shell (e.g. a brand-new session via /clear). */
export function clearBgShells(): void {
  for (const s of shells.values()) {
    if (s.timer) clearTimeout(s.timer)
    try { s.child.kill('SIGKILL') } catch { /* gone */ }
  }
  shells.clear()
}
