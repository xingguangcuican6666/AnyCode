// Custom status line (the `statusLine` setting): a user-provided shell command
// whose stdout becomes a persistent footer line, mirroring Claude Code's
// `statusLine`. The command receives a JSON context object on stdin (model,
// provider, cwd, version, session token/turn totals) and prints its status to
// stdout; we take the first non-empty line. Shelling out per render would be far
// too costly, so the caller runs this on a slow poll and caches the last line.
import { spawn } from 'node:child_process'

export interface StatusLineContext {
  model: string
  provider: string
  cwd: string
  version: string
  // Cumulative session totals, for a cost/context-style readout.
  tokens?: number
  turns?: number
}

const RUN_TIMEOUT_MS = 5_000

// Run the command and resolve to its first non-empty stdout line, or null if it
// failed, timed out, or printed nothing. Never rejects — a broken status-line
// command must not crash the app; it just yields no line.
export function runStatusLine(command: string, ctx: StatusLineContext, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (v: string | null): void => { if (!done) { done = true; resolve(v) } }
    let child
    try {
      child = spawn('/bin/bash', ['-c', command], { stdio: ['pipe', 'pipe', 'ignore'], signal })
    } catch { finish(null); return }
    const timer = setTimeout(() => { try { child.kill('SIGTERM') } catch {}; finish(null) }, RUN_TIMEOUT_MS)
    child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    child.on('error', () => { clearTimeout(timer); finish(null) })
    child.on('close', () => {
      clearTimeout(timer)
      const line = out.split('\n').map((l) => l.trimEnd()).find((l) => l.trim().length > 0)
      finish(line ? line.trim() : null)
    })
    try { child.stdin?.write(JSON.stringify(ctx)); child.stdin?.end() } catch {}
  })
}
