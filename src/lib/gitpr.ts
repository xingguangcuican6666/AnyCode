// PR / branch status for the `prStatusFooter` setting. We shell out to git (and
// to `gh` when it's installed) once, on a slow poll, and cache the one-line
// result — never on every render. Every spawn is best-effort: no repo, no git,
// no gh, or any non-zero exit just yields null and the footer line is omitted.
import { spawn } from 'node:child_process'

/** Run a command, resolve its trimmed stdout, or null on any failure/non-zero. */
function run(cmd: string, args: string[], cwd: string, timeoutMs = 2500): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: string | null): void => { if (!done) { done = true; resolve(v) } }
    try {
      const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } finish(null) }, timeoutMs)
      child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8') })
      child.on('error', () => { clearTimeout(timer); finish(null) })
      child.on('close', (code) => { clearTimeout(timer); finish(code === 0 ? out.trim() : null) })
    } catch {
      finish(null)
    }
  })
}

// A short, footer-friendly PR/branch summary, or null when there's nothing
// useful to show (not a git repo, detached HEAD with no info, etc.).
export async function prStatus(cwd: string): Promise<string | null> {
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  if (!branch || branch === 'HEAD') return null

  // Prefer a real PR state when the GitHub CLI is available and authed.
  const pr = await run('gh', ['pr', 'view', '--json', 'number,state,title', '-q', '"#\\(.number) \\(.state)"'], cwd)
  if (pr) return `⎇ ${branch} · PR ${pr}`

  // Fallback: ahead/behind vs the upstream tracking branch, plus a dirty marker.
  const ab = await run('git', ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], cwd)
  const dirty = await run('git', ['status', '--porcelain'], cwd)
  let tail = ''
  if (ab) {
    const [behind, ahead] = ab.split(/\s+/).map((n) => parseInt(n, 10) || 0)
    const parts: string[] = []
    if (ahead) parts.push(`↑${ahead}`)
    if (behind) parts.push(`↓${behind}`)
    if (parts.length) tail += ' ' + parts.join('')
  }
  if (dirty) tail += ' ●'
  return `⎇ ${branch}${tail}`
}
