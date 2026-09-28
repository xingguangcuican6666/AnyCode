// Git worktree creation for the `/worktree` command and the `worktreeBaseRef`
// setting. We shell out to git (best-effort: no repo / no git / non-zero exit is
// reported, never thrown). `worktreeBaseRef` decides what a new worktree branches
// FROM: 'fresh' bases it on the origin default branch (origin/HEAD, so it starts
// clean from upstream), 'head' bases it on the current local HEAD (so it inherits
// your uncommitted-then-committed local work's tip).
import { spawn } from 'node:child_process'
import path from 'node:path'

export type WorktreeBaseRef = 'fresh' | 'head'

/** Run git, resolving { code, out, err } — never rejects. */
function git(args: string[], cwd: string, timeoutMs = 8000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: { code: number; out: string; err: string }): void => { if (!done) { done = true; resolve(v) } }
    try {
      const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = '', err = ''
      const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } finish({ code: -1, out, err: err || 'git timed out' }) }, timeoutMs)
      child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8') })
      child.stderr?.on('data', (c: Buffer) => { err += c.toString('utf8') })
      child.on('error', (e) => { clearTimeout(timer); finish({ code: -1, out, err: (e as Error).message }) })
      child.on('close', (code) => { clearTimeout(timer); finish({ code: code ?? -1, out: out.trim(), err: err.trim() }) })
    } catch (e) {
      finish({ code: -1, out: '', err: (e as Error).message })
    }
  })
}

// A filesystem-safe branch/directory slug from a user-supplied worktree name.
function slug(name: string): string {
  return name.trim().replace(/[^\w./-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'worktree'
}

export interface WorktreeResult {
  ok: boolean
  path?: string
  branch?: string
  base?: string
  error?: string
}

// Resolve what a 'fresh' worktree should branch from: the origin default branch
// (origin/HEAD → e.g. origin/main), falling back to origin/main|master, else HEAD.
async function freshBase(cwd: string): Promise<string> {
  const head = await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd)
  if (head.code === 0 && head.out) return head.out.replace('refs/remotes/', '') // → origin/main
  for (const ref of ['origin/main', 'origin/master']) {
    const r = await git(['rev-parse', '--verify', '--quiet', ref], cwd)
    if (r.code === 0 && r.out) return ref
  }
  return 'HEAD'
}

// Create a git worktree named `name`, branching per `baseRef`. Returns a result
// describing the created path/branch or an error message (all best-effort).
export async function createWorktree(cwd: string, name: string, baseRef: WorktreeBaseRef): Promise<WorktreeResult> {
  const root = await git(['rev-parse', '--show-toplevel'], cwd)
  if (root.code !== 0 || !root.out) return { ok: false, error: root.err || 'not a git repository' }
  const repoRoot = root.out
  const branch = slug(name)
  const dir = path.join(repoRoot, '.worktrees', branch)
  const base = baseRef === 'head' ? 'HEAD' : await freshBase(repoRoot)

  // If the branch already exists, attach the worktree to it; otherwise create it
  // from `base`. `-b` fails on an existing branch, so probe first.
  const exists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot)
  const args = exists.code === 0 && exists.out
    ? ['worktree', 'add', dir, branch]
    : ['worktree', 'add', '-b', branch, dir, base]
  const add = await git(args, repoRoot)
  if (add.code !== 0) return { ok: false, error: add.err || add.out || 'git worktree add failed' }
  return { ok: true, path: dir, branch, base }
}
